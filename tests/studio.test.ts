import assert from "node:assert/strict";
import test from "node:test";

import { RaglabAdapter } from "../src/adapters/raglab.js";
import type { EvaluationConfig } from "../src/config.js";
import type { EvaluationDataset } from "../src/dataset.js";
import type { EvaluationPlan, Identity, StageJudgement } from "../src/contracts.js";
import { createProjectWorkspace, EVALUATION_STUDIO_STAGES, normalizeRecommendedExperiment, runStagePromptExperiment } from "../src/studio.js";

const identity: Identity = { subject: "alice", tenant_id: "tenant_a", roles: ["admin"] };
const plan: EvaluationPlan = {
  schema: "agent-evaluation.plan.v1",
  plan_id: "plan",
  target_id: "rag-evolution-lab",
  suite_id: "suite",
  name: "test",
  objective: "验证业务 Agent",
  app_id: "tenant_a-medical-device-customer-agent",
  environment_id: "tenant_a-medical-device-customer-agent-dev",
  workflow: [{ node_id: "answer", name: "回答", owner: "llm", evaluation_questions: [], metrics: ["grounding"], interventions: ["prompt"], prompt_editable: true }],
  dataset: { dataset_id: "dataset", version: "1", provenance: "synthetic", case_count: 2, safety_case_count: 0, segments: ["sales"] },
  gates: [], execution_order: [], production_mutation: false,
};

const dataset: EvaluationDataset = {
  schema: "agent-evaluation.dataset.v1",
  dataset_id: "dataset",
  name: "dataset",
  version: "1",
  domain: "sales",
  language: "zh-CN",
  provenance: "synthetic",
  contains_patient_data: false,
  description: "test",
  split_policy: {
    development: { purpose: "test", prompt_visible: true, case_count: 2 },
    holdout: { purpose: "test", prompt_visible: false, case_count: 0 },
    regression: { purpose: "test", prompt_visible: true, case_count: 0 },
  },
  cases: [
    { id: "pass", split: "development", segment: "sales", query: "产品是什么", expected_decision: "answer", minimum_citations: 1, required_document_ids: ["doc-1"] },
    { id: "fail", split: "development", segment: "sales", query: "另一产品是什么", expected_decision: "answer", minimum_citations: 1, required_document_ids: ["doc-2"] },
  ],
};

class StudioAdapter extends RaglabAdapter {
  constructor() { super("http://agent", "http://api"); }
  override async promptPreview(input: { query: string }): Promise<Record<string, unknown>> {
    const documentID = input.query === "产品是什么" ? "doc-1" : "wrong-doc";
    return { response: { result: { decision: "answer", reason_code: "ok", answer: "产品信息", citations: [{ document_id: documentID, dataset_id: "dataset" }], trace_id: "trace" } } };
  }
}

const config = { modelApiKey: "", model: "mock" } as EvaluationConfig;

test("creates a project discovery workspace with a bounded editable evaluation chain", () => {
  const workspace = createProjectWorkspace(identity, plan, "医疗设备 Agent");
  assert.match(workspace.workspace_id, /^workspace_[a-f0-9]{32}$/);
  assert.equal(workspace.business_flow.length, 1);
  assert.ok(workspace.evaluation_chain.some((stage) => stage.prompt_editable));
  assert.ok(workspace.evaluation_chain.some((stage) => !stage.prompt_editable));
  assert.equal(EVALUATION_STUDIO_STAGES.find((stage) => stage.stage_id === "authorize_target")?.prompt_editable, false);
});

test("normalizes target-system ideas into a bounded judge prompt experiment", () => {
  const workspace = createProjectWorkspace(identity, plan, "医疗设备 Agent");
  const brief = normalizeRecommendedExperiment({
    ...workspace.brief,
    recommended_stage_id: "retrieval_judge",
    recommended_prompt_hypothesis: "调整 Rerank 与 Hybrid 召回权重",
    recommended_first_evaluation: "修改生产检索链路",
  });
  assert.match(brief.recommended_prompt_hypothesis, /Judge Prompt/);
  assert.doesNotMatch(brief.recommended_prompt_hypothesis, /Rerank|Hybrid/);
  assert.match(brief.recommended_first_evaluation, /不修改生产 Agent/);
});

test("compares a selected judge stage against the deterministic oracle", async () => {
  const workspace = createProjectWorkspace(identity, plan, "医疗设备 Agent");
  const judge = async (_stage: unknown, prompt: string, observations: Array<{ case_id: string; oracle_pass: boolean }>) => new Map<string, StageJudgement>(
    observations.map((item) => [item.case_id, {
      pass: prompt === "candidate" ? item.oracle_pass : true,
      score: prompt === "candidate" ? 0.9 : 0.6,
      rationale: "mock judgement",
    }]),
  );
  const experiment = await runStagePromptExperiment({
    config,
    adapter: new StudioAdapter(),
    identity,
    workspace,
    dataset,
    appID: plan.app_id,
    environmentID: plan.environment_id,
    stageID: "retrieval_judge",
    candidatePrompt: "candidate",
    caseLimit: 2,
    judge,
  });
  assert.equal(experiment.baseline.agreement, 0.5);
  assert.equal(experiment.candidate.agreement, 1);
  assert.deepEqual(experiment.improved_cases, ["fail"]);
  assert.deepEqual(experiment.regressed_cases, []);
  assert.equal(experiment.dataset_split, "development");
  assert.equal(experiment.promotion_status, "validate_holdout");
  assert.equal(experiment.production_mutation, false);
});
