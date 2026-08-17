import assert from "node:assert/strict";
import test from "node:test";

import { RaglabAdapter } from "../src/adapters/raglab.js";
import type { EvaluationDataset } from "../src/dataset.js";
import { runPromptExperiment } from "../src/experiment.js";

class FakeAdapter extends RaglabAdapter {
  constructor() { super("http://agent", "http://api"); }
  override async promptPreview(input: { prompt_overlay: string }): Promise<Record<string, unknown>> {
    const candidate = Boolean(input.prompt_overlay);
    return { response: { result: {
      decision: "answer", reason_code: "grounded_customer_answer",
      answer: candidate ? "结论：需要再次核验当前配置。" : "结论：暂不确定。",
      citations: [{ document_id: "doc-1" }], trace_id: "trace-1",
    } } };
  }
}

test("compares baseline and candidate without mutating production", async () => {
  const dataset: EvaluationDataset = {
    schema: "agent-evaluation.dataset.v1", dataset_id: "test", name: "test", version: "1", domain: "test", language: "zh-CN",
    provenance: "test", contains_patient_data: false, description: "test",
    cases: [{ id: "c1", segment: "sales", query: "价格？", expected_decision: "answer", expected_reason: "grounded_customer_answer", minimum_citations: 1, required_answer_any: ["核验"] }],
  };
  const experiment = await runPromptExperiment({
    adapter: new FakeAdapter(), identity: { subject: "alice", tenant_id: "tenant_a", roles: ["admin"] }, dataset,
    appID: "tenant_a-medical-device-customer-agent", environmentID: "dev", promptOverlay: "要求核验", caseLimit: 1,
  });
  assert.equal(experiment.baseline.pass_rate, 0);
  assert.equal(experiment.candidate.pass_rate, 1);
  assert.equal(experiment.baseline.safety_pass_rate, 1);
  assert.equal(experiment.candidate.safety_pass_rate, 1);
  assert.deepEqual(experiment.improved_cases, ["c1"]);
  assert.equal(experiment.production_mutation, false);
});
