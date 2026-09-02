import { createHash, randomUUID } from "node:crypto";

import type { Identity } from "./contracts.js";
import {
  compareDocumentQualityReports,
  DOCUMENT_FAILURE_LAYERS,
  evaluateDocumentQuality,
  type DocumentFailureLayer,
  type DocumentPipelineArtifact,
  type DocumentQualityComparison,
  type DocumentQualityDataset,
  type DocumentQualityReport,
} from "./document-quality.js";

export const DOCUMENT_PREINDEX_LAYERS = ["ocr", "layout", "cleaning", "chunk"] as const satisfies readonly DocumentFailureLayer[];
export const DOCUMENT_RETRIEVAL_LAYERS = ["ocr", "layout", "cleaning", "chunk", "retrieval", "safety"] as const satisfies readonly DocumentFailureLayer[];
export const DOCUMENT_HOLDOUT_LAYERS = ["ocr", "layout", "cleaning", "chunk", "retrieval", "safety"] as const satisfies readonly DocumentFailureLayer[];

type RunnableDocumentQualitySplit = "development" | "holdout";

export interface DocumentArtifactBundle {
  schema: "agent-evaluation.document-quality.artifacts.v1";
  source?: Record<string, unknown>;
  config?: Record<string, unknown>;
  artifacts: DocumentPipelineArtifact[];
}

export interface DocumentQualityIntervention {
  variable: "chunk_profile";
  baseline: string;
  candidate: string;
  rationale: string;
}

export interface DocumentQualityDiagnosis {
  root_cause_layer: DocumentFailureLayer | "no_measurable_change";
  confidence: number;
  evidence: string[];
  recommendation: string;
  requires_human_review: true;
}

export interface DocumentQualityExperiment {
  schema: "agent-evaluation.document-quality.experiment.v1";
  experiment_id: string;
  tenant_id: string;
  requested_by: string;
  started_at: string;
  completed_at: string;
  dataset: {
    suite_id: string;
    dataset_id: string;
    version: string;
    snapshot: string;
    split: RunnableDocumentQualitySplit;
  };
  evaluated_layers: DocumentFailureLayer[];
  execution_stage: "pre-index" | "retrieval-sandbox";
  intervention: DocumentQualityIntervention;
  baseline_report: DocumentQualityReport;
  candidate_report: DocumentQualityReport;
  comparison: DocumentQualityComparison;
  diagnosis: DocumentQualityDiagnosis;
  promotion_status: "development_passed" | "retrieval_passed" | "holdout_passed" | "hold";
  retrieval_sandbox?: {
    baseline: RetrievalSandboxSummary;
    candidate: RetrievalSandboxSummary;
  };
  frozen_profiles: {
    baseline: { label: string; bundle_config: Record<string, unknown>; fingerprint: string };
    candidate: { label: string; bundle_config: Record<string, unknown>; fingerprint: string };
  };
  release_gate?: {
    kind: "holdout-once";
    parent_experiment_id: string;
    attempt_key: string;
    candidate_fingerprint: string;
    verdict: "pass" | "fail";
    retry_policy: "quality-result-is-final; infrastructure-failure-may-retry";
  };
  production_mutation: false;
  raw_artifacts_persisted: false;
}

export interface RetrievalSandboxRequest {
  run_id: string;
  variant: "baseline" | "candidate";
  chunks: Array<{
    chunk_id: string;
    document_id: string;
    dataset_id: string;
    title: string;
    content: string;
    source_file: string;
    source_page?: number;
    source_sheet?: string;
    source_cell_range?: string;
    heading_path?: string[];
  }>;
  queries: Array<{ query_id: string; query: string; top_k: number; candidate_k: number }>;
}

export interface RetrievalSandboxRun {
  schema: "raglab.retrieval-sandbox.run.v1";
  run_id: string;
  variant: string;
  collection_scope: "temporary-isolated";
  embedder: string;
  dimensions: number;
  reranker: string;
  retrieval: string;
  index: string;
  chunks_indexed: number;
  index_build_latency_ms: number;
  total_latency_ms: number;
  cleanup_completed: boolean;
  production_mutation: false;
  queries: Array<{
    query_id: string;
    query: string;
    embedding_latency_ms: number;
    search_latency_ms: number;
    rerank_latency_ms: number;
    hits: Array<{
      chunk_id: string;
      document_id: string;
      title?: string;
      content: string;
      source_file?: string;
      source_page?: number;
      source_sheet?: string;
      source_cell_range?: string;
      heading_path?: string[];
      pre_rerank_rank: number;
      post_rerank_rank: number;
      fusion_score?: number;
      rerank_score?: number;
      recall_sources?: string[];
      exact_matches?: string[];
    }>;
  }>;
}

export interface RetrievalSandboxSummary {
  provider: { embedder: string; dimensions: number; reranker: string };
  retrieval: string;
  index: string;
  collection_scope: "temporary-isolated";
  chunks_indexed: number;
  cleanup_completed: boolean;
  production_mutation: false;
  index_build_latency_ms: number;
  total_latency_ms: number;
  queries: Array<{
    query_id: string;
    embedding_latency_ms: number;
    search_latency_ms: number;
    rerank_latency_ms: number;
    hits: Array<{
      chunk_id: string;
      document_id: string;
      pre_rerank_rank: number;
      post_rerank_rank: number;
      fusion_score?: number;
      rerank_score?: number;
      source_page?: number;
      source_sheet?: string;
      source_cell_range?: string;
      heading_path?: string[];
    }>;
  }>;
}

export interface PreparedRetrievalExperiment {
  run_id: string;
  started_at: string;
  baseline_bundle: DocumentArtifactBundle;
  candidate_bundle: DocumentArtifactBundle;
  intervention: DocumentQualityIntervention;
  split: RunnableDocumentQualitySplit;
  baseline_request: RetrievalSandboxRequest;
  candidate_request: RetrievalSandboxRequest;
}

export interface PreparedDocumentQualityHoldoutGate extends PreparedRetrievalExperiment {
  split: "holdout";
  parent_experiment: DocumentQualityExperiment;
  attempt_key: string;
  candidate_fingerprint: string;
}

export interface RunDocumentQualityExperimentInput {
  identity: Identity;
  dataset: DocumentQualityDataset;
  split?: unknown;
  evaluated_layers?: unknown;
  intervention?: unknown;
  baseline_artifacts?: unknown;
  candidate_artifacts?: unknown;
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function artifactBundle(value: unknown, name: string): DocumentArtifactBundle {
  const record = asRecord(value, name);
  if (record.schema !== "agent-evaluation.document-quality.artifacts.v1") throw new Error(`${name} uses an unsupported schema`);
  if (!Array.isArray(record.artifacts) || !record.artifacts.length) throw new Error(`${name}.artifacts must be a non-empty array`);
  for (const artifact of record.artifacts) {
    const item = asRecord(artifact, `${name}.artifact`);
    if (item.schema !== "agent-evaluation.document-quality.artifact.v1" || typeof item.case_id !== "string") {
      throw new Error(`${name} contains an invalid document artifact`);
    }
    if (item.indexed !== false || !Array.isArray(item.retrieval) || item.retrieval.length !== 0) {
      throw new Error(`${name} must contain pre-index artifacts only`);
    }
  }
  return record as unknown as DocumentArtifactBundle;
}

function selectedLayers(value: unknown): DocumentFailureLayer[] {
  const requested = value === undefined ? [...DOCUMENT_PREINDEX_LAYERS] : value;
  if (!Array.isArray(requested) || !requested.length) throw new Error("evaluated_layers must be a non-empty array");
  const requestedSet = new Set(requested.map(String));
  for (const layer of requestedSet) {
    if (!(DOCUMENT_PREINDEX_LAYERS as readonly string[]).includes(layer)) {
      throw new Error(`pre-index experiments cannot evaluate layer: ${layer}`);
    }
  }
  return DOCUMENT_FAILURE_LAYERS.filter((layer) => requestedSet.has(layer));
}

function intervention(value: unknown, baseline: DocumentArtifactBundle, candidate: DocumentArtifactBundle): DocumentQualityIntervention {
  const record = asRecord(value ?? {}, "intervention");
  if ((record.variable ?? "chunk_profile") !== "chunk_profile") throw new Error("only chunk_profile is currently supported");
  const fallback = (bundle: DocumentArtifactBundle) => {
    const maxRunes = Number(bundle.config?.max_runes);
    const overlapRunes = Number(bundle.config?.overlap_runes);
    return Number.isFinite(maxRunes) && Number.isFinite(overlapRunes) ? `${maxRunes}/${overlapRunes}` : "unspecified";
  };
  const baselineLabel = String(record.baseline ?? fallback(baseline)).trim().slice(0, 120);
  const candidateLabel = String(record.candidate ?? fallback(candidate)).trim().slice(0, 120);
  if (!baselineLabel || !candidateLabel || baselineLabel === candidateLabel) throw new Error("baseline and candidate chunk profiles must be different");
  const rationale = String(record.rationale ?? "测试 chunk 参数是否能保持完整答案单元，同时控制重复向量成本").trim().slice(0, 500);
  return { variable: "chunk_profile", baseline: baselineLabel, candidate: candidateLabel, rationale };
}

function assertExactCaseSet(dataset: DocumentQualityDataset, bundle: DocumentArtifactBundle, name: string, split: RunnableDocumentQualitySplit): void {
  const expected = dataset.cases.filter((item) => item.split === split).map((item) => item.case_id).sort();
  const actual = bundle.artifacts.map((item) => item.case_id).sort();
  if (new Set(actual).size !== actual.length || JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${name} must contain every ${split} case exactly once`);
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function frozenProfile(label: string, bundle: DocumentArtifactBundle) {
  const bundleConfig = bundle.config ?? {};
  const fingerprint = `sha256:${createHash("sha256").update(canonical({ label, bundle_config: bundleConfig })).digest("hex")}`;
  return { label, bundle_config: bundleConfig, fingerprint };
}

function frozenProfiles(interventionValue: DocumentQualityIntervention, baseline: DocumentArtifactBundle, candidate: DocumentArtifactBundle) {
  return {
    baseline: frozenProfile(interventionValue.baseline, baseline),
    candidate: frozenProfile(interventionValue.candidate, candidate),
  };
}

function stablePreChunkState(artifact: DocumentPipelineArtifact): string {
  return JSON.stringify({
    case_id: artifact.case_id,
    status: artifact.status,
    blocks: artifact.blocks,
    cleaning: artifact.cleaning,
  });
}

function assertSingleVariableExperiment(baseline: DocumentArtifactBundle, candidate: DocumentArtifactBundle): void {
  const candidateByID = new Map(candidate.artifacts.map((item) => [item.case_id, item]));
  for (const item of baseline.artifacts) {
    const counterpart = candidateByID.get(item.case_id);
    if (!counterpart || stablePreChunkState(item) !== stablePreChunkState(counterpart)) {
      throw new Error(`pre-chunk state differs for ${item.case_id}; the comparison is not a single-variable chunk experiment`);
    }
  }
}

function diagnose(
  baseline: DocumentQualityReport,
  candidate: DocumentQualityReport,
  comparison: DocumentQualityComparison,
): DocumentQualityDiagnosis {
  const reductions = DOCUMENT_FAILURE_LAYERS.map((layer) => ({
    layer,
    delta: baseline.layer_failures[layer] - candidate.layer_failures[layer],
  })).sort((left, right) => right.delta - left.delta);
  const best = reductions[0];
  const rootCause = best && best.delta > 0 ? best.layer : "no_measurable_change";
  const improvedMetrics = comparison.metric_deltas.filter((item) => item.improved).map((item) => item.name);
  const evidence = [
    comparison.fixed_cases.length ? `修复用例：${comparison.fixed_cases.join(", ")}` : "没有修复用例",
    improvedMetrics.length ? `改善指标：${improvedMetrics.join(", ")}` : "没有改善指标",
    comparison.regressed_cases.length ? `退化用例：${comparison.regressed_cases.join(", ")}` : "未出现新增失败用例",
    comparison.regressed_metrics.length ? `退化指标：${comparison.regressed_metrics.join(", ")}` : "未出现指标退化",
  ];
  return {
    root_cause_layer: rootCause,
    confidence: rootCause === "no_measurable_change" ? 0.45 : 0.92,
    evidence,
    recommendation: comparison.promotable
      ? "Development 门禁通过，可提交一次受控 Holdout 验证；尚不能直接发布生产。"
      : "保留当前基线，回到失败层检查清洗规则或 chunk 边界，再运行 Development 对照。",
    requires_human_review: true,
  };
}

export function runDocumentQualityExperiment(input: RunDocumentQualityExperimentInput): DocumentQualityExperiment {
  const split = String(input.split ?? "development");
  if (split !== "development") throw new Error("interactive tuning is restricted to the development split");
  const layers = selectedLayers(input.evaluated_layers);
  const baselineBundle = artifactBundle(input.baseline_artifacts, "baseline_artifacts");
  const candidateBundle = artifactBundle(input.candidate_artifacts, "candidate_artifacts");
  assertExactCaseSet(input.dataset, baselineBundle, "baseline_artifacts", "development");
  assertExactCaseSet(input.dataset, candidateBundle, "candidate_artifacts", "development");
  assertSingleVariableExperiment(baselineBundle, candidateBundle);
  const selectedIntervention = intervention(input.intervention, baselineBundle, candidateBundle);
  const startedAt = new Date().toISOString();
  const baselineReport = evaluateDocumentQuality(input.dataset, baselineBundle.artifacts, "development", layers);
  const candidateReport = evaluateDocumentQuality(input.dataset, candidateBundle.artifacts, "development", layers);
  const comparison = compareDocumentQualityReports(baselineReport, candidateReport);
  const diagnosis = diagnose(baselineReport, candidateReport, comparison);
  return {
    schema: "agent-evaluation.document-quality.experiment.v1",
    experiment_id: `docqexp_${randomUUID().replaceAll("-", "")}`,
    tenant_id: input.identity.tenant_id,
    requested_by: input.identity.subject,
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    dataset: {
      suite_id: input.dataset.suite_id,
      dataset_id: input.dataset.dataset_id,
      version: input.dataset.version,
      snapshot: input.dataset.snapshot_id ?? "unversioned",
      split: "development",
    },
    evaluated_layers: layers,
    execution_stage: "pre-index",
    intervention: selectedIntervention,
    baseline_report: baselineReport,
    candidate_report: candidateReport,
    comparison,
    diagnosis,
    promotion_status: comparison.promotable ? "development_passed" : "hold",
    frozen_profiles: frozenProfiles(selectedIntervention, baselineBundle, candidateBundle),
    production_mutation: false,
    raw_artifacts_persisted: false,
  };
}

function sandboxRequest(
  runID: string,
  variant: "baseline" | "candidate",
  dataset: DocumentQualityDataset,
  bundle: DocumentArtifactBundle,
  split: RunnableDocumentQualitySplit,
): RetrievalSandboxRequest {
  const cases = dataset.cases.filter((item) => item.split === split);
  const caseByID = new Map(cases.map((item) => [item.case_id, item]));
  const chunks = bundle.artifacts.flatMap((artifact) => {
    const golden = caseByID.get(artifact.case_id);
    // review_required / ocr_required artifacts must never reach Embedding or
    // an index. Holdout contains an explicit probe for this release boundary.
    if (!golden || artifact.status !== "ready") return [];
    return artifact.chunks.map((chunk) => ({
      chunk_id: chunk.chunk_id,
      document_id: golden.source_group,
      dataset_id: dataset.dataset_id,
      title: golden.source_group,
      content: chunk.content,
      source_file: golden.source_group,
      source_page: chunk.source_page,
      source_sheet: chunk.source_sheet,
      source_cell_range: chunk.source_cell_range,
      heading_path: chunk.heading_path,
    }));
  });
  // Keep the reranker pool large enough for recall but bounded independently
  // from corpus/chunk count. The first real run sent all 34 candidates to
  // Qwen; top-20 preserved every golden hit while cutting provider work.
  const candidateK = 20;
  const queries = cases.flatMap((item) => (item.retrieval_queries ?? []).map((query) => ({
    query_id: query.query_id,
    query: query.query,
    top_k: 5,
    candidate_k: candidateK,
  })));
  if (!queries.length) throw new Error(`${split} split has no retrieval queries`);
  return { run_id: runID, variant, chunks, queries };
}

export function prepareDocumentQualityRetrievalExperiment(input: {
  dataset: DocumentQualityDataset;
  split?: unknown;
  intervention?: unknown;
  baseline_artifacts?: unknown;
  candidate_artifacts?: unknown;
}): PreparedRetrievalExperiment {
  if (String(input.split ?? "development") !== "development") {
    throw new Error("interactive tuning is restricted to the development split");
  }
  const baseline = artifactBundle(input.baseline_artifacts, "baseline_artifacts");
  const candidate = artifactBundle(input.candidate_artifacts, "candidate_artifacts");
  assertExactCaseSet(input.dataset, baseline, "baseline_artifacts", "development");
  assertExactCaseSet(input.dataset, candidate, "candidate_artifacts", "development");
  assertSingleVariableExperiment(baseline, candidate);
  const selectedIntervention = intervention(input.intervention, baseline, candidate);
  const runID = `docqrun_${randomUUID().replaceAll("-", "")}`;
  return {
    run_id: runID,
    started_at: new Date().toISOString(),
    baseline_bundle: baseline,
    candidate_bundle: candidate,
    intervention: selectedIntervention,
    split: "development",
    baseline_request: sandboxRequest(runID, "baseline", input.dataset, baseline, "development"),
    candidate_request: sandboxRequest(runID, "candidate", input.dataset, candidate, "development"),
  };
}

export function prepareDocumentQualityHoldoutGate(input: {
  dataset: DocumentQualityDataset;
  parent_experiment: DocumentQualityExperiment;
  intervention?: unknown;
  baseline_artifacts?: unknown;
  candidate_artifacts?: unknown;
}): PreparedDocumentQualityHoldoutGate {
  const parent = input.parent_experiment;
  if (parent.dataset.split !== "development" || parent.execution_stage !== "retrieval-sandbox" || parent.promotion_status !== "retrieval_passed") {
    throw new Error("holdout requires a passed development retrieval experiment");
  }
  if (parent.dataset.snapshot !== (input.dataset.snapshot_id ?? "unversioned")) {
    throw new Error("holdout dataset snapshot differs from the parent development experiment");
  }
  const baseline = artifactBundle(input.baseline_artifacts, "baseline_artifacts");
  const candidate = artifactBundle(input.candidate_artifacts, "candidate_artifacts");
  assertExactCaseSet(input.dataset, baseline, "baseline_artifacts", "holdout");
  assertExactCaseSet(input.dataset, candidate, "candidate_artifacts", "holdout");
  assertSingleVariableExperiment(baseline, candidate);
  const selectedIntervention = intervention(input.intervention, baseline, candidate);
  if (canonical({ variable: selectedIntervention.variable, baseline: selectedIntervention.baseline, candidate: selectedIntervention.candidate })
    !== canonical({ variable: parent.intervention.variable, baseline: parent.intervention.baseline, candidate: parent.intervention.candidate })) {
    throw new Error("holdout intervention must exactly match the frozen development experiment");
  }
  const profiles = frozenProfiles(selectedIntervention, baseline, candidate);
  if (profiles.baseline.fingerprint !== parent.frozen_profiles.baseline.fingerprint
    || profiles.candidate.fingerprint !== parent.frozen_profiles.candidate.fingerprint) {
    throw new Error("holdout bundle configuration does not match the frozen development profiles");
  }
  const candidateFingerprint = profiles.candidate.fingerprint;
  const attemptKey = `sha256:${createHash("sha256").update(canonical({
    tenant_id: parent.tenant_id,
    dataset_snapshot: parent.dataset.snapshot,
    candidate_fingerprint: candidateFingerprint,
  })).digest("hex")}`;
  const runID = `docqgate_${randomUUID().replaceAll("-", "")}`;
  return {
    run_id: runID,
    started_at: new Date().toISOString(),
    baseline_bundle: baseline,
    candidate_bundle: candidate,
    intervention: selectedIntervention,
    split: "holdout",
    baseline_request: sandboxRequest(runID, "baseline", input.dataset, baseline, "holdout"),
    candidate_request: sandboxRequest(runID, "candidate", input.dataset, candidate, "holdout"),
    parent_experiment: parent,
    attempt_key: attemptKey,
    candidate_fingerprint: candidateFingerprint,
  };
}

function validateSandboxRun(value: RetrievalSandboxRun, expected: RetrievalSandboxRequest): void {
  if (value.schema !== "raglab.retrieval-sandbox.run.v1" || value.run_id !== expected.run_id || value.variant !== expected.variant) {
    const variant = expected.variant;
    throw new Error(`${variant} retrieval sandbox returned an invalid run contract`);
  }
  const variant = expected.variant;
  if (value.collection_scope !== "temporary-isolated" || !value.cleanup_completed || value.production_mutation !== false) {
    throw new Error(`${variant} retrieval sandbox did not prove isolation and cleanup`);
  }
  if (!value.embedder || !value.reranker || !value.dimensions || value.chunks_indexed !== expected.chunks.length || !Array.isArray(value.queries)) {
    throw new Error(`${variant} retrieval sandbox omitted provider trace data`);
  }
  const expectedQueries = expected.queries.map((query) => query.query_id).sort();
  const actualQueries = value.queries.map((query) => query.query_id).sort();
  if (new Set(actualQueries).size !== actualQueries.length || JSON.stringify(actualQueries) !== JSON.stringify(expectedQueries)) {
    throw new Error(`${variant} retrieval sandbox returned the wrong query set`);
  }
  for (const query of value.queries) {
    if (!Array.isArray(query.hits)) {
      throw new Error(`${variant} retrieval sandbox query ${query.query_id} omitted the hit list`);
    }
    for (const [index, hit] of query.hits.entries()) {
      const invalid = [
        !hit.chunk_id ? "chunk_id" : "",
        !hit.document_id ? "document_id" : "",
        typeof hit.content !== "string" ? "content" : "",
        hit.post_rerank_rank < 1 ? "post_rerank_rank" : "",
      ].filter(Boolean);
      if (invalid.length) {
        throw new Error(`${variant} retrieval sandbox query ${query.query_id} hit ${index + 1} has invalid ${invalid.join(",")}`);
      }
    }
  }
}

function artifactsWithRetrieval(bundle: DocumentArtifactBundle, dataset: DocumentQualityDataset, run: RetrievalSandboxRun, split: RunnableDocumentQualitySplit): DocumentPipelineArtifact[] {
  const queryByID = new Map(run.queries.map((query) => [query.query_id, query]));
  const caseByID = new Map(dataset.cases.filter((item) => item.split === split).map((item) => [item.case_id, item]));
  return bundle.artifacts.map((artifact) => ({
    ...artifact,
    indexed: artifact.status === "ready",
    retrieval: (caseByID.get(artifact.case_id)?.retrieval_queries ?? []).map((golden) => {
      const actual = queryByID.get(golden.query_id);
      if (!actual) throw new Error(`retrieval sandbox omitted query ${golden.query_id}`);
      return {
        query_id: golden.query_id,
        hits: actual.hits.map((hit) => ({
          document_id: hit.document_id,
          chunk_id: hit.chunk_id,
          content: hit.content,
          source_file: hit.source_file,
          source_page: hit.source_page,
          source_sheet: hit.source_sheet,
          source_cell_range: hit.source_cell_range,
          heading_path: hit.heading_path,
          fusion_score: hit.fusion_score,
          rerank_score: hit.rerank_score,
          pre_rerank_rank: hit.pre_rerank_rank,
          post_rerank_rank: hit.post_rerank_rank,
        })),
      };
    }),
  }));
}

function sandboxSummary(run: RetrievalSandboxRun): RetrievalSandboxSummary {
  return {
    provider: { embedder: run.embedder, dimensions: run.dimensions, reranker: run.reranker },
    retrieval: run.retrieval,
    index: run.index,
    collection_scope: run.collection_scope,
    chunks_indexed: run.chunks_indexed,
    cleanup_completed: run.cleanup_completed,
    production_mutation: false,
    index_build_latency_ms: run.index_build_latency_ms,
    total_latency_ms: run.total_latency_ms,
    queries: run.queries.map((query) => ({
      query_id: query.query_id,
      embedding_latency_ms: query.embedding_latency_ms,
      search_latency_ms: query.search_latency_ms,
      rerank_latency_ms: query.rerank_latency_ms,
      hits: query.hits.map((hit) => ({
        chunk_id: hit.chunk_id,
        document_id: hit.document_id,
        pre_rerank_rank: hit.pre_rerank_rank,
        post_rerank_rank: hit.post_rerank_rank,
        fusion_score: hit.fusion_score,
        rerank_score: hit.rerank_score,
        source_page: hit.source_page,
        source_sheet: hit.source_sheet,
        source_cell_range: hit.source_cell_range,
        heading_path: hit.heading_path,
      })),
    })),
  };
}

export function completeDocumentQualityRetrievalExperiment(input: {
  identity: Identity;
  dataset: DocumentQualityDataset;
  prepared: PreparedRetrievalExperiment;
  baseline_retrieval: RetrievalSandboxRun;
  candidate_retrieval: RetrievalSandboxRun;
}): DocumentQualityExperiment {
  validateSandboxRun(input.baseline_retrieval, input.prepared.baseline_request);
  validateSandboxRun(input.candidate_retrieval, input.prepared.candidate_request);
  const baselineReport = evaluateDocumentQuality(
    input.dataset,
    artifactsWithRetrieval(input.prepared.baseline_bundle, input.dataset, input.baseline_retrieval, "development"),
    "development",
    DOCUMENT_RETRIEVAL_LAYERS,
  );
  const candidateReport = evaluateDocumentQuality(
    input.dataset,
    artifactsWithRetrieval(input.prepared.candidate_bundle, input.dataset, input.candidate_retrieval, "development"),
    "development",
    DOCUMENT_RETRIEVAL_LAYERS,
  );
  const comparison = compareDocumentQualityReports(baselineReport, candidateReport);
  const diagnosis = diagnose(baselineReport, candidateReport, comparison);
  return {
    schema: "agent-evaluation.document-quality.experiment.v1",
    experiment_id: `docqexp_${randomUUID().replaceAll("-", "")}`,
    tenant_id: input.identity.tenant_id,
    requested_by: input.identity.subject,
    started_at: input.prepared.started_at,
    completed_at: new Date().toISOString(),
    dataset: {
      suite_id: input.dataset.suite_id,
      dataset_id: input.dataset.dataset_id,
      version: input.dataset.version,
      snapshot: input.dataset.snapshot_id ?? "unversioned",
      split: "development",
    },
    evaluated_layers: [...DOCUMENT_RETRIEVAL_LAYERS],
    execution_stage: "retrieval-sandbox",
    intervention: input.prepared.intervention,
    baseline_report: baselineReport,
    candidate_report: candidateReport,
    comparison,
    diagnosis,
    promotion_status: comparison.promotable ? "retrieval_passed" : "hold",
    frozen_profiles: frozenProfiles(input.prepared.intervention, input.prepared.baseline_bundle, input.prepared.candidate_bundle),
    retrieval_sandbox: {
      baseline: sandboxSummary(input.baseline_retrieval),
      candidate: sandboxSummary(input.candidate_retrieval),
    },
    production_mutation: false,
    raw_artifacts_persisted: false,
  };
}

function assertFrozenRetrievalProvider(parent: DocumentQualityExperiment, baseline: RetrievalSandboxRun, candidate: RetrievalSandboxRun): void {
  const expected = parent.retrieval_sandbox;
  if (!expected) throw new Error("parent development experiment omitted retrieval provider evidence");
  const signature = (value: { provider?: { embedder: string; dimensions: number; reranker: string }; embedder?: string; dimensions?: number; reranker?: string; retrieval: string; index: string }) => canonical({
    embedder: value.provider?.embedder ?? value.embedder,
    dimensions: value.provider?.dimensions ?? value.dimensions,
    reranker: value.provider?.reranker ?? value.reranker,
    retrieval: value.retrieval,
    index: value.index,
  });
  if (signature(expected.baseline) !== signature(baseline) || signature(expected.candidate) !== signature(candidate)) {
    throw new Error("holdout retrieval provider/index differs from the frozen development experiment");
  }
}

export function completeDocumentQualityHoldoutGate(input: {
  identity: Identity;
  dataset: DocumentQualityDataset;
  prepared: PreparedDocumentQualityHoldoutGate;
  baseline_retrieval: RetrievalSandboxRun;
  candidate_retrieval: RetrievalSandboxRun;
}): DocumentQualityExperiment {
  validateSandboxRun(input.baseline_retrieval, input.prepared.baseline_request);
  validateSandboxRun(input.candidate_retrieval, input.prepared.candidate_request);
  assertFrozenRetrievalProvider(input.prepared.parent_experiment, input.baseline_retrieval, input.candidate_retrieval);
  const baselineReport = evaluateDocumentQuality(
    input.dataset,
    artifactsWithRetrieval(input.prepared.baseline_bundle, input.dataset, input.baseline_retrieval, "holdout"),
    "holdout",
    DOCUMENT_HOLDOUT_LAYERS,
  );
  const candidateReport = evaluateDocumentQuality(
    input.dataset,
    artifactsWithRetrieval(input.prepared.candidate_bundle, input.dataset, input.candidate_retrieval, "holdout"),
    "holdout",
    DOCUMENT_HOLDOUT_LAYERS,
  );
  const comparison = compareDocumentQualityReports(baselineReport, candidateReport);
  const diagnosis = diagnose(baselineReport, candidateReport, comparison);
  diagnosis.recommendation = comparison.promotable
    ? "一次性 Holdout 门禁通过，可进入 Regression；仍不能跳过回归集直接发布。"
    : "冻结本次失败，不得查看 Holdout 后原地调参；应把失败模式转写成新的 Development Bad Case，再形成新候选。";
  return {
    schema: "agent-evaluation.document-quality.experiment.v1",
    experiment_id: `docqexp_${randomUUID().replaceAll("-", "")}`,
    tenant_id: input.identity.tenant_id,
    requested_by: input.identity.subject,
    started_at: input.prepared.started_at,
    completed_at: new Date().toISOString(),
    dataset: {
      suite_id: input.dataset.suite_id,
      dataset_id: input.dataset.dataset_id,
      version: input.dataset.version,
      snapshot: input.dataset.snapshot_id ?? "unversioned",
      split: "holdout",
    },
    evaluated_layers: [...DOCUMENT_HOLDOUT_LAYERS],
    execution_stage: "retrieval-sandbox",
    intervention: input.prepared.intervention,
    baseline_report: baselineReport,
    candidate_report: candidateReport,
    comparison,
    diagnosis,
    promotion_status: comparison.promotable ? "holdout_passed" : "hold",
    frozen_profiles: frozenProfiles(input.prepared.intervention, input.prepared.baseline_bundle, input.prepared.candidate_bundle),
    release_gate: {
      kind: "holdout-once",
      parent_experiment_id: input.prepared.parent_experiment.experiment_id,
      attempt_key: input.prepared.attempt_key,
      candidate_fingerprint: input.prepared.candidate_fingerprint,
      verdict: comparison.promotable ? "pass" : "fail",
      retry_policy: "quality-result-is-final; infrastructure-failure-may-retry",
    },
    retrieval_sandbox: {
      baseline: sandboxSummary(input.baseline_retrieval),
      candidate: sandboxSummary(input.candidate_retrieval),
    },
    production_mutation: false,
    raw_artifacts_persisted: false,
  };
}
