import { randomUUID } from "node:crypto";

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
    split: "development";
  };
  evaluated_layers: DocumentFailureLayer[];
  intervention: DocumentQualityIntervention;
  baseline_report: DocumentQualityReport;
  candidate_report: DocumentQualityReport;
  comparison: DocumentQualityComparison;
  diagnosis: DocumentQualityDiagnosis;
  promotion_status: "development_passed" | "hold";
  production_mutation: false;
  raw_artifacts_persisted: false;
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

function assertExactCaseSet(dataset: DocumentQualityDataset, bundle: DocumentArtifactBundle, name: string): void {
  const expected = dataset.cases.filter((item) => item.split === "development").map((item) => item.case_id).sort();
  const actual = bundle.artifacts.map((item) => item.case_id).sort();
  if (new Set(actual).size !== actual.length || JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${name} must contain every development case exactly once`);
  }
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
  assertExactCaseSet(input.dataset, baselineBundle, "baseline_artifacts");
  assertExactCaseSet(input.dataset, candidateBundle, "candidate_artifacts");
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
    intervention: selectedIntervention,
    baseline_report: baselineReport,
    candidate_report: candidateReport,
    comparison,
    diagnosis,
    promotion_status: comparison.promotable ? "development_passed" : "hold",
    production_mutation: false,
    raw_artifacts_persisted: false,
  };
}
