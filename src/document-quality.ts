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
  required_source_sheets?: string[];
  required_source_cell_ranges?: string[];
  required_heading_paths?: string[][];
  required_source_locators?: Array<{
    source_page?: number;
    source_sheet?: string;
    source_cell_range?: string;
    heading_path?: string[];
  }>;
  required_content_spans?: string[];
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
  source_sheet?: string;
  source_cell_range?: string;
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
  source_sheet?: string;
  source_cell_range?: string;
  heading_path?: string[];
}

export interface DocumentRetrievalArtifact {
  query_id: string;
  hits: Array<{
    document_id: string;
    chunk_id?: string;
    content?: string;
    source_page?: number;
    source_sheet?: string;
    source_cell_range?: string;
    heading_path?: string[];
    source_file?: string;
    score?: number;
    fusion_score?: number;
    rerank_score?: number;
    pre_rerank_rank?: number;
    post_rerank_rank?: number;
  }>;
}

export interface DocumentPipelineArtifact {
  schema: "agent-evaluation.document-quality.artifact.v1";
  case_id: string;
  dataset_id?: string;
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
  retrieval_evidence_spans_total: number;
  retrieval_evidence_spans_contained: number;
  retrieval_locators_total: number;
  retrieval_locators_matched: number;
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
  evaluated_layers: DocumentFailureLayer[];
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

export interface DocumentQualityComparison {
  schema: "agent-evaluation.document-quality.comparison.v1";
  dataset_snapshot: string;
  split: DatasetSplit | "all";
  evaluated_layers: DocumentFailureLayer[];
  baseline: { gate_passed: boolean; cases_passed: number; cases_total: number; config_fingerprints: string[] };
  candidate: { gate_passed: boolean; cases_passed: number; cases_total: number; config_fingerprints: string[] };
  metric_deltas: Array<{ name: string; baseline: number; candidate: number; delta: number; improved: boolean; regressed: boolean }>;
  fixed_cases: string[];
  regressed_cases: string[];
  regressed_metrics: string[];
  promotable: boolean;
  recommendation: string;
}

function ratio(numerator: number, denominator: number): number {
  return denominator ? numerator / denominator : 1;
}

function normalizeForCER(value: string): string {
  return value.normalize("NFC").replace(/\s+/gu, "").toLocaleLowerCase("zh-CN");
}

function containsIgnoringWhitespace(value: string, expected: string): boolean {
  return value.replace(/\s+/gu, "").includes(expected.replace(/\s+/gu, ""));
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

export function evaluateDocumentCase(
  item: DocumentQualityCase,
  artifact: DocumentPipelineArtifact,
  enabledLayers: readonly DocumentFailureLayer[] = DOCUMENT_FAILURE_LAYERS,
): DocumentQualityCaseResult {
  if (artifact.case_id !== item.case_id) throw new Error(`artifact case mismatch: expected ${item.case_id}, got ${artifact.case_id}`);
  const enabled = new Set(enabledLayers);
  const checks: DocumentQualityCheck[] = [];
  const documentText = artifact.blocks.map((block) => block.text).join("\n");
  const removedText = artifact.cleaning.removed_blocks.map((block) => block.text).join("\n");
  const measurements: CaseMeasurements = {
    critical_total: enabled.has("ocr") ? item.critical_fields?.length ?? 0 : 0,
    critical_matched: 0,
    protected_total: enabled.has("cleaning") ? item.protected_text?.length ?? 0 : 0,
    protected_preserved: 0,
    noise_total: enabled.has("cleaning") ? item.expected_removed_noise?.length ?? 0 : 0,
    noise_removed: 0,
    spans_total: enabled.has("chunk") ? item.required_chunk_spans?.length ?? 0 : 0,
    spans_contained: 0,
    retrieval_total: enabled.has("retrieval") ? item.retrieval_queries?.length ?? 0 : 0,
    retrieval_hits: 0,
    reciprocal_rank_sum: 0,
    wrong_document_count: 0,
    retrieval_evidence_spans_total: enabled.has("retrieval")
      ? (item.retrieval_queries ?? []).reduce((total, query) => total + (query.required_content_spans?.length ?? 0), 0)
      : 0,
    retrieval_evidence_spans_contained: 0,
    retrieval_locators_total: enabled.has("retrieval")
      ? (item.retrieval_queries ?? []).reduce((total, query) => total
        + (query.required_source_pages?.length ?? 0)
        + (query.required_source_sheets?.length ?? 0)
        + (query.required_source_cell_ranges?.length ?? 0)
        + (query.required_heading_paths?.length ?? 0)
        + (query.required_source_locators?.length ?? 0), 0)
      : 0,
    retrieval_locators_matched: 0,
    unsafe_publish_count: enabled.has("safety") && artifact.status !== "ready" && artifact.indexed ? 1 : 0,
    embedding_amplification: enabled.has("chunk") ? embeddingAmplification(artifact.chunks) : undefined,
  };

  if (enabled.has("safety")) {
    checks.push(check({
      name: "expected_status", layer: "safety", hard: true,
      passed: artifact.status === item.expected_status, expected: item.expected_status, actual: artifact.status,
    }));
    checks.push(check({
      name: "non_ready_not_indexed", layer: "safety", hard: true,
      passed: measurements.unsafe_publish_count === 0, expected: 0, actual: measurements.unsafe_publish_count,
    }));
  }

  for (const field of enabled.has("ocr") ? item.critical_fields ?? [] : []) {
    const passed = documentText.includes(field);
    if (passed) measurements.critical_matched += 1;
    checks.push(check({ name: `critical_field:${field}`, layer: "ocr", hard: true, passed, expected: field, actual: passed ? field : "missing" }));
  }
  for (const forbidden of enabled.has("ocr") ? item.forbidden_normalizations ?? [] : []) {
    const passed = !documentText.includes(forbidden);
    checks.push(check({ name: `forbidden_normalization:${forbidden}`, layer: "ocr", hard: true, passed, expected: "absent", actual: passed ? "absent" : "present" }));
  }

  for (const expected of enabled.has("layout") ? item.expected_blocks ?? [] : []) {
    const passed = artifact.blocks.some((block) => blockMatches(expected, block));
    checks.push(check({ name: `expected_block:${expected.text ?? expected.contains ?? expected.type ?? "block"}`, layer: "layout", hard: true, passed }));
  }
  let previousIndex = -1;
  for (const marker of enabled.has("layout") ? item.expected_reading_order ?? [] : []) {
    const index = artifact.blocks.findIndex((block, blockIndex) => blockIndex > previousIndex && block.text.includes(marker));
    const passed = index > previousIndex;
    checks.push(check({ name: `reading_order:${marker}`, layer: "layout", hard: true, passed, expected: `after ${previousIndex}`, actual: index }));
    if (passed) previousIndex = index;
  }

  for (const noise of enabled.has("cleaning") ? item.expected_removed_noise ?? [] : []) {
    const passed = removedText.includes(noise) && !documentText.includes(noise);
    if (passed) measurements.noise_removed += 1;
    checks.push(check({ name: `removed_noise:${noise}`, layer: "cleaning", hard: true, passed }));
  }
  for (const protectedValue of enabled.has("cleaning") ? item.protected_text ?? [] : []) {
    const passed = documentText.includes(protectedValue) && !removedText.includes(protectedValue);
    if (passed) measurements.protected_preserved += 1;
    checks.push(check({ name: `protected_text:${protectedValue}`, layer: "cleaning", hard: true, passed }));
  }

  for (const span of enabled.has("chunk") ? item.required_chunk_spans ?? [] : []) {
    // Layout parsers and OCR engines may insert or remove presentation-only
    // whitespace around CJK text. Chunk containment evaluates whether the
    // answer unit stayed in one chunk; identifier exactness is enforced by the
    // separate critical-field checks above.
    const passed = artifact.chunks.some((chunk) => containsIgnoringWhitespace(chunk.content, span));
    if (passed) measurements.spans_contained += 1;
    checks.push(check({ name: `chunk_span:${span.slice(0, 40)}`, layer: "chunk", hard: true, passed }));
  }
  if (measurements.embedding_amplification !== undefined) {
    checks.push(check({
      name: "embedding_amplification", layer: "chunk", hard: false,
      passed: measurements.embedding_amplification <= 1.3, expected: "<=1.3", actual: measurements.embedding_amplification.toFixed(4),
    }));
  }

  for (const golden of enabled.has("retrieval") ? item.retrieval_queries ?? [] : []) {
    const actual = artifact.retrieval.find((entry) => entry.query_id === golden.query_id);
    const documentIDs = actual?.hits.map((hit) => hit.document_id) ?? [];
    const rankIndex = documentIDs.findIndex((documentID) => golden.required_document_ids.includes(documentID));
    const hit = rankIndex >= 0 && rankIndex < 5;
    if (hit) measurements.retrieval_hits += 1;
    if (rankIndex >= 0) measurements.reciprocal_rank_sum += 1 / (rankIndex + 1);
    const wrong = documentIDs.filter((documentID) => golden.forbidden_document_ids?.includes(documentID)).length;
    measurements.wrong_document_count += wrong;
    const requiredDocumentHits = actual?.hits.filter((hitItem) => golden.required_document_ids.includes(hitItem.document_id)) ?? [];
    const pages = new Set(requiredDocumentHits.map((hitItem) => hitItem.source_page));
    const sheets = new Set(requiredDocumentHits.map((hitItem) => hitItem.source_sheet));
    const cellRanges = new Set(requiredDocumentHits.map((hitItem) => hitItem.source_cell_range));
    const headingPaths = requiredDocumentHits.map((hitItem) => hitItem.heading_path ?? []);
    const pagesPassed = (golden.required_source_pages ?? []).every((page) => pages.has(page));
    const sheetsPassed = (golden.required_source_sheets ?? []).every((sheet) => sheets.has(sheet));
    const cellRangesPassed = (golden.required_source_cell_ranges ?? []).every((cellRange) => cellRanges.has(cellRange));
    const headingPathsPassed = (golden.required_heading_paths ?? []).every((expectedPath) => headingPaths.some((actualPath) =>
      expectedPath.length === actualPath.length && expectedPath.every((part, index) => part === actualPath[index])));
    const locatorMatches = (golden.required_source_locators ?? []).map((locator) => requiredDocumentHits.some((hitItem) =>
      (locator.source_page === undefined || hitItem.source_page === locator.source_page)
      && (locator.source_sheet === undefined || hitItem.source_sheet === locator.source_sheet)
      && (locator.source_cell_range === undefined || hitItem.source_cell_range === locator.source_cell_range)
      && (locator.heading_path === undefined || (hitItem.heading_path?.length === locator.heading_path.length
        && locator.heading_path.every((part, index) => part === hitItem.heading_path?.[index])))));
    const locatorsPassed = locatorMatches.every(Boolean);
    measurements.retrieval_locators_matched += (golden.required_source_pages ?? []).filter((page) => pages.has(page)).length;
    measurements.retrieval_locators_matched += (golden.required_source_sheets ?? []).filter((sheet) => sheets.has(sheet)).length;
    measurements.retrieval_locators_matched += (golden.required_source_cell_ranges ?? []).filter((cellRange) => cellRanges.has(cellRange)).length;
    measurements.retrieval_locators_matched += (golden.required_heading_paths ?? []).filter((expectedPath) => headingPaths.some((actualPath) =>
      expectedPath.length === actualPath.length && expectedPath.every((part, index) => part === actualPath[index]))).length;
    measurements.retrieval_locators_matched += locatorMatches.filter(Boolean).length;
    for (const span of golden.required_content_spans ?? []) {
      const contained = actual?.hits.some((hitItem) => containsIgnoringWhitespace(hitItem.content ?? "", span)) ?? false;
      if (contained) measurements.retrieval_evidence_spans_contained += 1;
      checks.push(check({ name: `retrieval_evidence_span:${golden.query_id}:${span.slice(0, 32)}`, layer: "retrieval", hard: true, passed: contained }));
    }
    checks.push(check({ name: `retrieval_hit:${golden.query_id}`, layer: "retrieval", hard: true, passed: hit }));
    checks.push(check({ name: `retrieval_forbidden:${golden.query_id}`, layer: "retrieval", hard: true, passed: wrong === 0, expected: 0, actual: wrong }));
    checks.push(check({ name: `retrieval_source_page:${golden.query_id}`, layer: "retrieval", hard: true, passed: pagesPassed }));
    checks.push(check({ name: `retrieval_source_sheet:${golden.query_id}`, layer: "retrieval", hard: true, passed: sheetsPassed }));
    checks.push(check({ name: `retrieval_source_cell_range:${golden.query_id}`, layer: "retrieval", hard: true, passed: cellRangesPassed }));
    checks.push(check({ name: `retrieval_heading_path:${golden.query_id}`, layer: "retrieval", hard: true, passed: headingPathsPassed }));
    checks.push(check({ name: `retrieval_source_locator:${golden.query_id}`, layer: "retrieval", hard: true, passed: locatorsPassed }));
  }

  if (enabled.has("ocr") && item.expected_text !== undefined) {
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
  enabledLayers: readonly DocumentFailureLayer[] = DOCUMENT_FAILURE_LAYERS,
): DocumentQualityReport {
  const cases = dataset.cases.filter((item) => split === "all" || item.split === split);
  const artifactsByID = new Map(artifacts.map((artifact) => [artifact.case_id, artifact]));
  const results = cases.map((item) => {
    const artifact = artifactsByID.get(item.case_id);
    if (!artifact) throw new Error(`missing document artifact: ${item.case_id}`);
    return evaluateDocumentCase(item, artifact, enabledLayers);
  });
  const sums = results.reduce((total, item) => {
    for (const key of Object.keys(total) as Array<keyof typeof total>) total[key] += item.measurements[key] as number || 0;
    return total;
  }, {
    critical_total: 0, critical_matched: 0, protected_total: 0, protected_preserved: 0,
    noise_total: 0, noise_removed: 0, spans_total: 0, spans_contained: 0,
    retrieval_total: 0, retrieval_hits: 0, reciprocal_rank_sum: 0,
    wrong_document_count: 0, unsafe_publish_count: 0,
    retrieval_evidence_spans_total: 0, retrieval_evidence_spans_contained: 0,
    retrieval_locators_total: 0, retrieval_locators_matched: 0,
  });
  const cerValues = results.map((item) => item.measurements.character_error_rate).filter((value): value is number => value !== undefined);
  const amplificationValues = results.map((item) => item.measurements.embedding_amplification).filter((value): value is number => value !== undefined);
  const enabled = new Set(enabledLayers);
  const metrics: DocumentQualityMetric[] = [
    gate("case_pass_rate", ratio(results.filter((item) => item.passed).length, results.length), ">=", 0.95, false),
    gate("hard_case_failure_count", results.filter((item) => !item.passed).length, "=", 0, true),
  ];
  if (enabled.has("ocr")) metrics.push(gate("critical_field_exact_match", ratio(sums.critical_matched, sums.critical_total), ">=", 1, true));
  if (enabled.has("cleaning")) {
    metrics.push(gate("protected_text_preservation", ratio(sums.protected_preserved, sums.protected_total), ">=", 1, true));
    metrics.push(gate("expected_noise_removal", ratio(sums.noise_removed, sums.noise_total), ">=", 0.95, true));
  }
  if (enabled.has("chunk")) metrics.push(gate("answer_span_containment", ratio(sums.spans_contained, sums.spans_total), ">=", 0.98, true));
  if (enabled.has("retrieval")) {
    metrics.push(gate("retrieval_hit_at_5", ratio(sums.retrieval_hits, sums.retrieval_total), ">=", 0.90, true));
    metrics.push(gate("retrieval_mrr", ratio(sums.reciprocal_rank_sum, sums.retrieval_total), ">=", 0.80, true));
    metrics.push(gate("wrong_document_count", sums.wrong_document_count, "=", 0, true));
    metrics.push(gate("retrieval_evidence_span_containment", ratio(sums.retrieval_evidence_spans_contained, sums.retrieval_evidence_spans_total), ">=", 1, true));
    metrics.push(gate("retrieval_source_locator_accuracy", ratio(sums.retrieval_locators_matched, sums.retrieval_locators_total), ">=", 1, true));
  }
  if (enabled.has("safety")) metrics.push(gate("unsafe_publish_count", sums.unsafe_publish_count, "=", 0, true));
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
    evaluated_layers: [...enabledLayers],
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
  return `# Document Quality Evaluation Report\n\n- Suite: \`${report.suite_id}\`\n- Dataset: \`${report.dataset_id}@${report.dataset_version}\`\n- Snapshot: \`${report.dataset_snapshot}\`\n- Split: \`${report.split}\`\n- Evaluated layers: ${report.evaluated_layers.map((layer) => `\`${layer}\``).join(", ")}\n- Cases: ${report.cases_passed}/${report.cases_total}\n- Gate: **${report.gate_passed ? "PASS" : "FAIL"}**\n\n> Stages not listed above were not executed and are not counted as pass or fail.\n\n## Metrics\n\n| Metric | Value | Gate | Type | Result |\n| --- | ---: | ---: | --- | --- |\n${metrics}\n\n## Failure Layers\n\n| Layer | Failed Cases |\n| --- | ---: |\n${layers}\n\n## Failed Cases\n\n${report.failed_cases.length ? report.failed_cases.map((item) => `- \`${item}\``).join("\n") : "- None"}\n`;
}

export function compareDocumentQualityReports(
  baseline: DocumentQualityReport,
  candidate: DocumentQualityReport,
): DocumentQualityComparison {
  if (baseline.dataset_snapshot !== candidate.dataset_snapshot || baseline.split !== candidate.split) {
    throw new Error("document quality reports must use the same dataset snapshot and split");
  }
  if (baseline.evaluated_layers.join(",") !== candidate.evaluated_layers.join(",")) {
    throw new Error("document quality reports must evaluate the same ordered layers");
  }
  const baselineMetrics = new Map(baseline.metrics.map((metric) => [metric.name, metric]));
  const metricDeltas = candidate.metrics.flatMap((metric) => {
    const previous = baselineMetrics.get(metric.name);
    if (!previous) return [];
    const delta = metric.value - previous.value;
    const previousDistance = Math.abs(previous.value - previous.threshold);
    const candidateDistance = Math.abs(metric.value - metric.threshold);
    const improved = metric.operator === "<=" ? delta < 0 : metric.operator === ">=" ? delta > 0 : candidateDistance < previousDistance;
    const regressed = metric.operator === "<=" ? delta > 0 : metric.operator === ">=" ? delta < 0 : candidateDistance > previousDistance;
    return [{ name: metric.name, baseline: previous.value, candidate: metric.value, delta, improved, regressed }];
  });
  const baselineFailed = new Set(baseline.failed_cases);
  const candidateFailed = new Set(candidate.failed_cases);
  const fixedCases = baseline.failed_cases.filter((caseID) => !candidateFailed.has(caseID));
  const regressedCases = candidate.failed_cases.filter((caseID) => !baselineFailed.has(caseID));
  const regressedMetrics = metricDeltas.filter((metric) => metric.regressed).map((metric) => metric.name);
  const promotable = candidate.gate_passed && regressedCases.length === 0 && regressedMetrics.length === 0;
  return {
    schema: "agent-evaluation.document-quality.comparison.v1",
    dataset_snapshot: baseline.dataset_snapshot,
    split: baseline.split,
    evaluated_layers: [...baseline.evaluated_layers],
    baseline: {
      gate_passed: baseline.gate_passed, cases_passed: baseline.cases_passed,
      cases_total: baseline.cases_total, config_fingerprints: baseline.config_fingerprints,
    },
    candidate: {
      gate_passed: candidate.gate_passed, cases_passed: candidate.cases_passed,
      cases_total: candidate.cases_total, config_fingerprints: candidate.config_fingerprints,
    },
    metric_deltas: metricDeltas,
    fixed_cases: fixedCases,
    regressed_cases: regressedCases,
    regressed_metrics: regressedMetrics,
    promotable,
    recommendation: promotable
      ? `promote candidate; fixed ${fixedCases.length} case(s) with no regression`
      : `do not promote; candidate has ${candidate.failed_cases.length} failed, ${regressedCases.length} regressed case(s), and ${regressedMetrics.length} regressed metric(s)`,
  };
}

export function renderDocumentQualityComparisonMarkdown(comparison: DocumentQualityComparison): string {
  const metrics = comparison.metric_deltas.map((metric) => `| ${metric.name} | ${metric.baseline.toFixed(4)} | ${metric.candidate.toFixed(4)} | ${metric.delta >= 0 ? "+" : ""}${metric.delta.toFixed(4)} | ${metric.improved ? "improved" : metric.regressed ? "worse" : "unchanged"} |`).join("\n");
  return `# Document Quality Baseline / Candidate Comparison\n\n- Dataset snapshot: \`${comparison.dataset_snapshot}\`\n- Split: \`${comparison.split}\`\n- Evaluated layers: ${comparison.evaluated_layers.map((layer) => `\`${layer}\``).join(", ")}\n- Baseline: ${comparison.baseline.cases_passed}/${comparison.baseline.cases_total}, gate **${comparison.baseline.gate_passed ? "PASS" : "FAIL"}**\n- Candidate: ${comparison.candidate.cases_passed}/${comparison.candidate.cases_total}, gate **${comparison.candidate.gate_passed ? "PASS" : "FAIL"}**\n- Promotion decision: **${comparison.promotable ? "PROMOTE" : "HOLD"}**\n- Recommendation: ${comparison.recommendation}\n\n## Metric Deltas\n\n| Metric | Baseline | Candidate | Delta | Direction |\n| --- | ---: | ---: | ---: | --- |\n${metrics}\n\n## Fixed Cases\n\n${comparison.fixed_cases.length ? comparison.fixed_cases.map((item) => `- \`${item}\``).join("\n") : "- None"}\n\n## Regressed Cases\n\n${comparison.regressed_cases.length ? comparison.regressed_cases.map((item) => `- \`${item}\``).join("\n") : "- None"}\n\n## Regressed Metrics\n\n${comparison.regressed_metrics.length ? comparison.regressed_metrics.map((item) => `- \`${item}\``).join("\n") : "- None"}\n`;
}
