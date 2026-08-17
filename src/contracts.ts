export const ROOT_CAUSES = [
  "wrong_model",
  "wrong_version",
  "missing_exact_identifier",
  "chunk_boundary",
  "source_location",
  "rerank_order",
  "permission_filter",
  "insufficient_corpus",
  "agent_decision",
  "answer_grounding",
  "tool_misuse",
  "instruction_following",
  "safety_policy",
  "latency_budget",
  "other",
] as const;

export type RootCause = (typeof ROOT_CAUSES)[number];
export type EvaluationDimension = "task" | "tool_use" | "retrieval" | "grounding" | "safety" | "observability" | "performance" | "cost";

export interface Identity {
  subject: string;
  tenant_id: string;
  roles: string[];
  scopes?: string[];
}

export interface LoginResult {
  access_token: string;
  token_type: string;
  expires_at: string;
  identity: Identity;
}

export interface DeviceContext {
  model_code?: string;
  software_version?: string;
  lot_or_batch?: string;
  region?: string;
}

export interface BadCase {
  bad_case_id: string;
  tenant_id?: string;
  app_id: string;
  environment_id: string;
  layer: string;
  query: string;
  expected_decision: string;
  actual_decision: string;
  expected_document_ids: string[];
  actual_document_ids: string[];
  expected_source_locations?: Array<Record<string, unknown>>;
  device_context?: DeviceContext;
  root_cause?: string;
  resolution_note?: string;
  status: string;
  verification_count?: number;
  last_verification?: Record<string, unknown>;
}

export interface RetrievalHit {
  document_id: string;
  chunk_id?: string;
  title?: string;
  dataset_id?: string;
  content?: string;
  distance?: number;
  score?: number;
  model_codes?: string[];
  software_version_from?: string;
  software_version_to?: string;
  source_file?: string;
  source_page?: number;
  source_sheet?: string;
  source_cell_range?: string;
  heading_path?: string[];
}

export interface ReplayResult {
  trace_id: string;
  decision: string;
  reason_code: string;
  rewritten_query: string;
  retrieved_document_ids: string[];
  hits: RetrievalHit[];
  bindings: unknown[];
  metrics: { hit_at_5: number; mrr: number; relevant_rank: number | null };
}

export interface EvaluationMetric {
  name: string;
  dimension: EvaluationDimension;
  value: number;
  unit: "ratio" | "count" | "milliseconds";
  passed?: boolean;
  threshold?: number;
  source: "deterministic" | "model_assisted";
}

export interface DiagnosisReport {
  summary: string;
  root_cause: RootCause;
  confidence: number;
  evidence: Array<{ observation: string; supports: string }>;
  recommendations: Array<{
    action: string;
    layer: "corpus" | "metadata" | "retrieval" | "rerank" | "agent" | "evaluation" | "operations";
    expected_impact: string;
    risk: string;
  }>;
  validation: {
    executed: boolean;
    passed: boolean;
    trace_id: string;
    hit_at_5: number;
    mrr: number;
    notes: string;
  };
  requires_human_review: true;
}

export interface EvaluationEvent {
  sequence: number;
  type: string;
  name?: string;
  status?: string;
  timestamp: string;
}

export interface EvaluationRun {
  run_id: string;
  suite_id: string;
  suite_version: string;
  target_id: string;
  subject_id: string;
  tenant_id: string;
  requested_by: string;
  status: "completed" | "incomplete";
  started_at: string;
  completed_at: string;
  model: string;
  duration_ms: number;
  tool_calls: string[];
  metrics: EvaluationMetric[];
  report: DiagnosisReport;
  events: EvaluationEvent[];
}

export interface ProductionSampleCase {
  id: string;
  segment: string;
  query: string;
  device_context?: DeviceContext;
  expected_decision: "answer" | "clarify" | "refuse";
  expected_reason?: string;
  minimum_citations?: number;
  required_answer_any?: string[];
  forbidden_answer_any?: string[];
  safety_critical?: boolean;
}

export interface PromptCaseResult {
  case_id: string;
  segment: string;
  query: string;
  variant: "baseline" | "candidate";
  decision: string;
  reason_code: string;
  answer: string;
  citations: number;
  latency_ms: number;
  passed: boolean;
  checks: Record<string, boolean>;
  trace_id: string;
}

export interface PromptExperimentSummary {
  pass_rate: number;
  decision_accuracy: number;
  citation_compliance: number;
  safety_pass_rate: number;
  average_latency_ms: number;
}

export interface PromptExperiment {
  experiment_id: string;
  target_id: string;
  suite_id: string;
  dataset_id: string;
  dataset_provenance: string;
  tenant_id: string;
  requested_by: string;
  status: "completed" | "incomplete";
  prompt_overlay: string;
  started_at: string;
  completed_at: string;
  baseline: PromptExperimentSummary;
  candidate: PromptExperimentSummary;
  delta: Record<keyof PromptExperimentSummary, number>;
  improved_cases: string[];
  regressed_cases: string[];
  unchanged_cases: string[];
  results: PromptCaseResult[];
  recommendation: string;
  production_mutation: false;
}
