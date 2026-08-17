import { randomUUID } from "node:crypto";

import { RaglabAdapter } from "./adapters/raglab.js";
import type { EvaluationDataset } from "./dataset.js";
import type { Identity, ProductionSampleCase, PromptCaseResult, PromptExperiment, PromptExperimentSummary } from "./contracts.js";

function normalized(value: string): string { return value.trim().toLocaleLowerCase("zh-CN"); }

function responseResult(payload: Record<string, unknown>): Record<string, unknown> {
  const response = (payload.response ?? {}) as Record<string, unknown>;
  return (response.result ?? {}) as Record<string, unknown>;
}

async function runCase(
  adapter: RaglabAdapter,
  appID: string,
  environmentID: string,
  item: ProductionSampleCase,
  variant: "baseline" | "candidate",
  promptOverlay: string,
): Promise<PromptCaseResult> {
  const started = performance.now();
  const payload = await adapter.promptPreview({
    app_id: appID,
    environment_id: environmentID,
    query: item.query,
    device_context: item.device_context ?? {},
    prompt_overlay: promptOverlay,
  });
  const result = responseResult(payload);
  const answer = String(result.answer ?? "");
  const citations = Array.isArray(result.citations) ? result.citations.length : 0;
  const lowerAnswer = normalized(answer);
  const required = item.required_answer_any ?? [];
  const forbidden = item.forbidden_answer_any ?? [];
  const checks = {
    decision: String(result.decision ?? "") === item.expected_decision,
    reason: !item.expected_reason || String(result.reason_code ?? "") === item.expected_reason,
    citations: citations >= (item.minimum_citations ?? 0),
    required_answer: required.length === 0 || required.some((term) => lowerAnswer.includes(normalized(term))),
    forbidden_answer: forbidden.every((term) => !lowerAnswer.includes(normalized(term))),
  };
  return {
    case_id: item.id,
    segment: item.segment,
    query: item.query,
    variant,
    decision: String(result.decision ?? ""),
    reason_code: String(result.reason_code ?? ""),
    answer,
    citations,
    latency_ms: Math.round(performance.now() - started),
    passed: Object.values(checks).every(Boolean),
    checks,
    trace_id: String(result.trace_id ?? ""),
  };
}

function summarize(results: PromptCaseResult[], cases: ProductionSampleCase[]): PromptExperimentSummary {
  const critical = new Set(cases.filter((item) => item.safety_critical).map((item) => item.id));
  const safetyResults = results.filter((item) => critical.has(item.case_id));
  return {
    pass_rate: results.filter((item) => item.passed).length / Math.max(1, results.length),
    decision_accuracy: results.filter((item) => item.checks.decision).length / Math.max(1, results.length),
    citation_compliance: results.filter((item) => item.checks.citations).length / Math.max(1, results.length),
    // A suite without safety-critical cases is "not applicable", not a failed
    // safety gate. Dataset provenance still shows which cases were executed.
    safety_pass_rate: safetyResults.length
      ? safetyResults.filter((item) => item.passed).length / safetyResults.length
      : 1,
    average_latency_ms: results.reduce((sum, item) => sum + item.latency_ms, 0) / Math.max(1, results.length),
  };
}

export async function runPromptExperiment(input: {
  adapter: RaglabAdapter;
  identity: Identity;
  dataset: EvaluationDataset;
  appID: string;
  environmentID: string;
  promptOverlay: string;
  caseLimit: number;
}): Promise<PromptExperiment> {
  const startedAt = new Date().toISOString();
  const cases = input.dataset.cases.slice(0, Math.max(1, Math.min(input.caseLimit, input.dataset.cases.length, 12)));
  const results: PromptCaseResult[] = [];
  // Keep execution sequential so a comparison cannot create a burst against
  // the production-like target or obscure per-case latency and rate limits.
  for (const item of cases) results.push(await runCase(input.adapter, input.appID, input.environmentID, item, "baseline", ""));
  for (const item of cases) results.push(await runCase(input.adapter, input.appID, input.environmentID, item, "candidate", input.promptOverlay));
  const baselineResults = results.filter((item) => item.variant === "baseline");
  const candidateResults = results.filter((item) => item.variant === "candidate");
  const baseline = summarize(baselineResults, cases);
  const candidate = summarize(candidateResults, cases);
  const baselineByID = new Map(baselineResults.map((item) => [item.case_id, item]));
  const improvedCases: string[] = [];
  const regressedCases: string[] = [];
  const unchangedCases: string[] = [];
  for (const item of candidateResults) {
    const previous = baselineByID.get(item.case_id);
    if (!previous?.passed && item.passed) improvedCases.push(item.case_id);
    else if (previous?.passed && !item.passed) regressedCases.push(item.case_id);
    else unchangedCases.push(item.case_id);
  }
  const keys: Array<keyof PromptExperimentSummary> = ["pass_rate", "decision_accuracy", "citation_compliance", "safety_pass_rate", "average_latency_ms"];
  const delta = Object.fromEntries(keys.map((key) => [key, candidate[key] - baseline[key]])) as Record<keyof PromptExperimentSummary, number>;
  const recommendation = regressedCases.length > 0
    ? `Reject candidate: ${regressedCases.length} regression(s) detected; inspect case-level evidence before revising the prompt.`
    : candidate.safety_pass_rate < 1
      ? "Reject candidate: safety-critical cases are not all passing. Prompt changes cannot override hard safety gates."
      : improvedCases.length > 0
        ? `Candidate improved ${improvedCases.length} case(s) without measured regression. Expand the regression sample before release review.`
        : "No measurable quality gain on this sample. Keep the baseline and revise the intervention hypothesis.";
  return {
    experiment_id: `experiment_${randomUUID().replaceAll("-", "")}`,
    target_id: "rag-evolution-lab",
    suite_id: "raglab.medical-sales.prompt-ab.v1",
    dataset_id: input.dataset.dataset_id,
    dataset_provenance: input.dataset.provenance,
    tenant_id: input.identity.tenant_id,
    requested_by: input.identity.subject,
    status: "completed",
    prompt_overlay: input.promptOverlay,
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    baseline,
    candidate,
    delta,
    improved_cases: improvedCases,
    regressed_cases: regressedCases,
    unchanged_cases: unchangedCases,
    results,
    recommendation,
    production_mutation: false,
  };
}
