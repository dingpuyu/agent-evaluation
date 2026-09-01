import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { DatasetSplit } from "./contracts.js";

export const DOCUMENT_FAILURE_LAYERS = ["ocr", "layout", "cleaning", "chunk", "retrieval", "safety"] as const;
export type DocumentFailureLayer = (typeof DOCUMENT_FAILURE_LAYERS)[number];

export interface ExpectedDocumentBlock {
  type?: string;
  text?: string;
  contains?: string;
  page?: number;
}

export interface DocumentRetrievalGolden {
  query_id: string;
  query: string;
  required_document_ids: string[];
  forbidden_document_ids?: string[];
  required_source_pages?: number[];
}

export interface DocumentQualityCase {
  case_id: string;
  split: DatasetSplit;
  source_group: string;
  input_variant: string;
  expected_status: "ready" | "review_required" | "ocr_required";
  expected_text?: string;
  expected_blocks?: ExpectedDocumentBlock[];
  expected_reading_order?: string[];
  critical_fields?: string[];
  forbidden_normalizations?: string[];
  expected_removed_noise?: string[];
  protected_text?: string[];
  required_chunk_spans?: string[];
  retrieval_queries?: DocumentRetrievalGolden[];
}

export interface DocumentQualityDataset {
  schema: "agent-evaluation.document-quality.dataset.v1";
  suite_id: string;
  dataset_id: string;
  version: string;
  domain: string;
  language: string;
  provenance: string;
  contains_patient_data: false;
  description: string;
  split_policy: Record<DatasetSplit, { purpose: string; case_count: number; prompt_visible: boolean }>;
  cases: DocumentQualityCase[];
  snapshot_id?: string;
}

export interface DocumentArtifactBlock {
  block_type: string;
  text: string;
  page?: number;
  heading_path?: string[];
  confidence?: number;
}

export interface RemovedDocumentBlock extends DocumentArtifactBlock {
  reason: string;
}

export interface DocumentChunkArtifact {
  chunk_id: string;
  parent_id: string;
  content: string;
  parent_content?: string;
  source_page?: number;
}

export interface DocumentRetrievalArtifact {
  query_id: string;
  hits: Array<{ document_id: string; source_page?: number; score?: number }>;
}

export interface DocumentPipelineArtifact {
  schema: "agent-evaluation.document-quality.artifact.v1";
  case_id: string;
  status: "ready" | "review_required" | "ocr_required";
  indexed: boolean;
  config_fingerprint: string;
  blocks: DocumentArtifactBlock[];
  cleaning: { removed_blocks: RemovedDocumentBlock[] };
  chunks: DocumentChunkArtifact[];
  retrieval: DocumentRetrievalArtifact[];
  runtime?: { duration_ms?: number; peak_rss_mb?: number };
}

export interface DocumentQualityCheck {
  name: string;
  layer: DocumentFailureLayer;
  passed: boolean;
  hard: boolean;
  expected: string;
  actual: string;
}

interface CaseMeasurements {
  critical_total: number;
  critical_matched: number;
  protected_total: number;
  protected_preserved: number;
  noise_total: number;
  noise_removed: number;
  spans_total: number;
  spans_contained: number;
  retrieval_total: number;
  retrieval_hits: number;
  reciprocal_rank_sum: number;
  wrong_document_count: number;
  unsafe_publish_count: number;
  character_error_rate?: number;
  embedding_amplification?: number;
}

export interface DocumentQualityCaseResult {
  case_id: string;
  split: DatasetSplit;
  passed: boolean;
  failure_layers: DocumentFailureLayer[];
  checks: DocumentQualityCheck[];
  measurements: CaseMeasurements;
}

export interface DocumentQualityMetric {
  name: string;
  value: number;
  threshold: number;
  operator: ">=" | "<=" | "=";
  hard: boolean;
  passed: boolean;
}

export interface DocumentQualityReport {
  schema: "agent-evaluation.document-quality.report.v1";
  suite_id: string;
  dataset_id: string;
  dataset_version: string;
  dataset_snapshot: string;
  split: DatasetSplit | "all";
  generated_at: string;
  config_fingerprints: string[];
  cases_total: number;
  cases_passed: number;
  pass_rate: number;
  gate_passed: boolean;
  metrics: DocumentQualityMetric[];
  failed_cases: string[];
  layer_failures: Record<DocumentFailureLayer, number>;
  results: DocumentQualityCaseResult[];
}

function ratio(numerator: number, denominator: number): number {
  return denominator ? numerator / denominator : 1;
}

function normalizeForCER(value: string): string {
  return value.normalize("NFC").replace(/\s+/gu, "").toLocaleLowerCase("zh-CN");
}

export function characterErrorRate(expected: string, actual: string): number {
  const left = [...normalizeForCER(expected)];
  const right = [...normalizeForCER(actual)];
  if (!left.length) return right.length ? 1 : 0;
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= right.length; column += 1) {
      current[column] = Math.min(
        (current[column - 1] ?? row) + 1,
        (previous[column] ?? column) + 1,
        (previous[column - 1] ?? row - 1) + (left[row - 1] === right[column - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return (previous[right.length] ?? left.length) / left.length;
}

function blockMatches(expected: ExpectedDocumentBlock, block: DocumentArtifactBlock): boolean {
  return (!expected.type || block.block_type === expected.type)
    && (expected.page === undefined || block.page === expected.page)
    && (expected.text === undefined || block.text === expected.text)
    && (expected.contains === undefined || block.text.includes(expected.contains));
}

function check(input: Omit<DocumentQualityCheck, "actual" | "expected"> & { expected?: unknown; actual?: unknown }): DocumentQualityCheck {
  return {
    ...input,
    expected: String(input.expected ?? "true"),
    actual: String(input.actual ?? input.passed),
  };
}

function embeddingAmplification(chunks: DocumentChunkArtifact[]): number | undefined {
  if (!chunks.length) return undefined;
  const parents = new Map<string, string>();
  for (const chunk of chunks) {
    if (chunk.parent_content) parents.set(chunk.parent_id, chunk.parent_content);
  }
  const parentRunes = [...parents.values()].reduce((sum, value) => sum + [...value].length, 0);
  if (!parentRunes) return undefined;
  return chunks.reduce((sum, item) => sum + [...item.content].length, 0) / parentRunes;
}

export function evaluateDocumentCase(item: DocumentQualityCase, artifact: DocumentPipelineArtifact): DocumentQualityCaseResult {
  if (artifact.case_id !== item.case_id) throw new Error(`artifact case mismatch: expected ${item.case_id}, got ${artifact.case_id}`);
  const checks: DocumentQualityCheck[] = [];
  const documentText = artifact.blocks.map((block) => block.text).join("\n");
  const removedText = artifact.cleaning.removed_blocks.map((block) => block.text).join("\n");
  const measurements: CaseMeasurements = {
    critical_total: item.critical_fields?.length ?? 0,
    critical_matched: 0,
    protected_total: item.protected_text?.length ?? 0,
    protected_preserved: 0,
    noise_total: item.expected_removed_noise?.length ?? 0,
    noise_removed: 0,
    spans_total: item.required_chunk_spans?.length ?? 0,
    spans_contained: 0,
    retrieval_total: item.retrieval_queries?.length ?? 0,
    retrieval_hits: 0,
    reciprocal_rank_sum: 0,
    wrong_document_count: 0,
    unsafe_publish_count: artifact.status !== "ready" && artifact.indexed ? 1 : 0,
    embedding_amplification: embeddingAmplification(artifact.chunks),
  };

  checks.push(check({
    name: "expected_status", layer: "safety", hard: true,
    passed: artifact.status === item.expected_status, expected: item.expected_status, actual: artifact.status,
  }));
  checks.push(check({
    name: "non_ready_not_indexed", layer: "safety", hard: true,
    passed: measurements.unsafe_publish_count === 0, expected: 0, actual: measurements.unsafe_publish_count,
  }));

  for (const field of item.critical_fields ?? []) {
    const passed = documentText.includes(field);
    if (passed) measurements.critical_matched += 1;
    checks.push(check({ name: `critical_field:${field}`, layer: "ocr", hard: true, passed, expected: field, actual: passed ? field : "missing" }));
  }
  for (const forbidden of item.forbidden_normalizations ?? []) {
    const passed = !documentText.includes(forbidden);
    checks.push(check({ name: `forbidden_normalization:${forbidden}`, layer: "ocr", hard: true, passed, expected: "absent", actual: passed ? "absent" : "present" }));
  }

  for (const expected of item.expected_blocks ?? []) {
    const passed = artifact.blocks.some((block) => blockMatches(expected, block));
    checks.push(check({ name: `expected_block:${expected.text ?? expected.contains ?? expected.type ?? "block"}`, layer: "layout", hard: true, passed }));
  }
  let previousIndex = -1;
  for (const marker of item.expected_reading_order ?? []) {
    const index = artifact.blocks.findIndex((block, blockIndex) => blockIndex > previousIndex && block.text.includes(marker));
    const passed = index > previousIndex;
    checks.push(check({ name: `reading_order:${marker}`, layer: "layout", hard: true, passed, expected: `after ${previousIndex}`, actual: index }));
    if (passed) previousIndex = index;
  }

  for (const noise of item.expected_removed_noise ?? []) {
    const passed = removedText.includes(noise) && !documentText.includes(noise);
    if (passed) measurements.noise_removed += 1;
    checks.push(check({ name: `removed_noise:${noise}`, layer: "cleaning", hard: true, passed }));
  }
  for (const protectedValue of item.protected_text ?? []) {
    const passed = documentText.includes(protectedValue) && !removedText.includes(protectedValue);
    if (passed) measurements.protected_preserved += 1;
    checks.push(check({ name: `protected_text:${protectedValue}`, layer: "cleaning", hard: true, passed }));
  }

  for (const span of item.required_chunk_spans ?? []) {
    const passed = artifact.chunks.some((chunk) => chunk.content.includes(span));
    if (passed) measurements.spans_contained += 1;
    checks.push(check({ name: `chunk_span:${span.slice(0, 40)}`, layer: "chunk", hard: true, passed }));
  }
  if (measurements.embedding_amplification !== undefined) {
    checks.push(check({
      name: "embedding_amplification", layer: "chunk", hard: false,
      passed: measurements.embedding_amplification <= 1.3, expected: "<=1.3", actual: measurements.embedding_amplification.toFixed(4),
    }));
  }

  for (const golden of item.retrieval_queries ?? []) {
    const actual = artifact.retrieval.find((entry) => entry.query_id === golden.query_id);
    const documentIDs = actual?.hits.map((hit) => hit.document_id) ?? [];
    const rankIndex = documentIDs.findIndex((documentID) => golden.required_document_ids.includes(documentID));
    const hit = rankIndex >= 0 && rankIndex < 5;
    if (hit) measurements.retrieval_hits += 1;
    if (rankIndex >= 0) measurements.reciprocal_rank_sum += 1 / (rankIndex + 1);
    const wrong = documentIDs.filter((documentID) => golden.forbidden_document_ids?.includes(documentID)).length;
    measurements.wrong_document_count += wrong;
    const pages = new Set(actual?.hits.filter((hitItem) => golden.required_document_ids.includes(hitItem.document_id)).map((hitItem) => hitItem.source_page) ?? []);
    const pagesPassed = (golden.required_source_pages ?? []).every((page) => pages.has(page));
    checks.push(check({ name: `retrieval_hit:${golden.query_id}`, layer: "retrieval", hard: true, passed: hit }));
    checks.push(check({ name: `retrieval_forbidden:${golden.query_id}`, layer: "retrieval", hard: true, passed: wrong === 0, expected: 0, actual: wrong }));
    checks.push(check({ name: `retrieval_source_page:${golden.query_id}`, layer: "retrieval", hard: true, passed: pagesPassed }));
  }

  if (item.expected_text !== undefined) {
    measurements.character_error_rate = characterErrorRate(item.expected_text, documentText);
    checks.push(check({
      name: "character_error_rate", layer: "ocr", hard: true,
      passed: measurements.character_error_rate <= 0.03, expected: "<=0.03", actual: measurements.character_error_rate.toFixed(6),
    }));
  }
  const failureLayers = [...new Set(checks.filter((itemCheck) => itemCheck.hard && !itemCheck.passed).map((itemCheck) => itemCheck.layer))];
  return {
    case_id: item.case_id,
    split: item.split,
    passed: failureLayers.length === 0,
    failure_layers: failureLayers,
    checks,
    measurements,
  };
}

function gate(name: string, value: number, operator: DocumentQualityMetric["operator"], threshold: number, hard: boolean): DocumentQualityMetric {
  const passed = operator === ">=" ? value >= threshold : operator === "<=" ? value <= threshold : value === threshold;
  return { name, value, operator, threshold, hard, passed };
}

export function evaluateDocumentQuality(
  dataset: DocumentQualityDataset,
  artifacts: DocumentPipelineArtifact[],
  split: DatasetSplit | "all" = "all",
): DocumentQualityReport {
  const cases = dataset.cases.filter((item) => split === "all" || item.split === split);
  const artifactsByID = new Map(artifacts.map((artifact) => [artifact.case_id, artifact]));
  const results = cases.map((item) => {
    const artifact = artifactsByID.get(item.case_id);
    if (!artifact) throw new Error(`missing document artifact: ${item.case_id}`);
    return evaluateDocumentCase(item, artifact);
  });
  const sums = results.reduce((total, item) => {
    for (const key of Object.keys(total) as Array<keyof typeof total>) total[key] += item.measurements[key] as number || 0;
    return total;
  }, {
    critical_total: 0, critical_matched: 0, protected_total: 0, protected_preserved: 0,
    noise_total: 0, noise_removed: 0, spans_total: 0, spans_contained: 0,
    retrieval_total: 0, retrieval_hits: 0, reciprocal_rank_sum: 0,
    wrong_document_count: 0, unsafe_publish_count: 0,
  });
  const cerValues = results.map((item) => item.measurements.character_error_rate).filter((value): value is number => value !== undefined);
  const amplificationValues = results.map((item) => item.measurements.embedding_amplification).filter((value): value is number => value !== undefined);
  const metrics: DocumentQualityMetric[] = [
    gate("case_pass_rate", ratio(results.filter((item) => item.passed).length, results.length), ">=", 0.95, false),
    gate("hard_case_failure_count", results.filter((item) => !item.passed).length, "=", 0, true),
    gate("critical_field_exact_match", ratio(sums.critical_matched, sums.critical_total), ">=", 1, true),
    gate("protected_text_preservation", ratio(sums.protected_preserved, sums.protected_total), ">=", 1, true),
    gate("expected_noise_removal", ratio(sums.noise_removed, sums.noise_total), ">=", 0.95, true),
    gate("answer_span_containment", ratio(sums.spans_contained, sums.spans_total), ">=", 0.98, true),
    gate("retrieval_hit_at_5", ratio(sums.retrieval_hits, sums.retrieval_total), ">=", 0.90, true),
    gate("retrieval_mrr", ratio(sums.reciprocal_rank_sum, sums.retrieval_total), ">=", 0.80, true),
    gate("wrong_document_count", sums.wrong_document_count, "=", 0, true),
    gate("unsafe_publish_count", sums.unsafe_publish_count, "=", 0, true),
  ];
  if (cerValues.length) metrics.push(gate("mean_character_error_rate", cerValues.reduce((sum, value) => sum + value, 0) / cerValues.length, "<=", 0.03, true));
  if (amplificationValues.length) metrics.push(gate("mean_embedding_amplification", amplificationValues.reduce((sum, value) => sum + value, 0) / amplificationValues.length, "<=", 1.30, false));
  const layerFailures = Object.fromEntries(DOCUMENT_FAILURE_LAYERS.map((layer) => [layer, results.filter((item) => item.failure_layers.includes(layer)).length])) as Record<DocumentFailureLayer, number>;
  return {
    schema: "agent-evaluation.document-quality.report.v1",
    suite_id: dataset.suite_id,
    dataset_id: dataset.dataset_id,
    dataset_version: dataset.version,
    dataset_snapshot: dataset.snapshot_id ?? "unversioned",
    split,
    generated_at: new Date().toISOString(),
    config_fingerprints: [...new Set(artifacts.map((artifact) => artifact.config_fingerprint))].sort(),
    cases_total: results.length,
    cases_passed: results.filter((item) => item.passed).length,
    pass_rate: ratio(results.filter((item) => item.passed).length, results.length),
    gate_passed: metrics.filter((metric) => metric.hard).every((metric) => metric.passed),
    metrics,
    failed_cases: results.filter((item) => !item.passed).map((item) => item.case_id),
    layer_failures: layerFailures,
    results,
  };
}

export async function loadDocumentQualityDataset(path: string): Promise<DocumentQualityDataset> {
  const source = await readFile(path, "utf8");
  const dataset = JSON.parse(source) as DocumentQualityDataset;
  if (dataset.schema !== "agent-evaluation.document-quality.dataset.v1") throw new Error("unsupported document quality dataset schema");
  if (dataset.contains_patient_data !== false) throw new Error("document quality dataset must not contain patient data");
  if (!dataset.suite_id || !dataset.dataset_id || !dataset.cases?.length) throw new Error("document quality dataset is incomplete");
  const ids = new Set<string>();
  for (const item of dataset.cases) {
    if (!item.case_id || !item.source_group || !item.input_variant) throw new Error("document quality case is incomplete");
    if (ids.has(item.case_id)) throw new Error(`duplicate document quality case: ${item.case_id}`);
    ids.add(item.case_id);
  }
  for (const split of ["development", "holdout", "regression"] as DatasetSplit[]) {
    const actual = dataset.cases.filter((item) => item.split === split).length;
    if (!actual || dataset.split_policy[split]?.case_count !== actual) throw new Error(`document quality split count mismatch: ${split}`);
  }
  dataset.snapshot_id = `sha256:${createHash("sha256").update(source).digest("hex")}`;
  return dataset;
}

export function renderDocumentQualityMarkdown(report: DocumentQualityReport): string {
  const metrics = report.metrics.map((metric) => `| ${metric.name} | ${metric.value.toFixed(4)} | ${metric.operator} ${metric.threshold} | ${metric.hard ? "hard" : "soft"} | ${metric.passed ? "PASS" : "FAIL"} |`).join("\n");
  const layers = DOCUMENT_FAILURE_LAYERS.map((layer) => `| ${layer} | ${report.layer_failures[layer]} |`).join("\n");
  return `# Document Quality Evaluation Report\n\n- Suite: \`${report.suite_id}\`\n- Dataset: \`${report.dataset_id}@${report.dataset_version}\`\n- Snapshot: \`${report.dataset_snapshot}\`\n- Split: \`${report.split}\`\n- Cases: ${report.cases_passed}/${report.cases_total}\n- Gate: **${report.gate_passed ? "PASS" : "FAIL"}**\n\n## Metrics\n\n| Metric | Value | Gate | Type | Result |\n| --- | ---: | ---: | --- | --- |\n${metrics}\n\n## Failure Layers\n\n| Layer | Failed Cases |\n| --- | ---: |\n${layers}\n\n## Failed Cases\n\n${report.failed_cases.length ? report.failed_cases.map((item) => `- \`${item}\``).join("\n") : "- None"}\n`;
}
