import assert from "node:assert/strict";
import test from "node:test";

import type { BadCase, DiagnosisReport } from "../src/contracts.js";
import { buildRunMetrics, retrievalMetrics } from "../src/metrics.js";

test("computes document-level retrieval metrics", () => {
  assert.deepEqual(retrievalMetrics(["wanted"], ["other", "wanted", "third"]), { hit_at_5: 1, mrr: 0.5, relevant_rank: 2 });
});

test("builds Agent and RAG metrics from one auditable run", () => {
  const badCase = { expected_decision: "answer" } as BadCase;
  const report = { requires_human_review: true, confidence: 0.8 } as DiagnosisReport;
  const metrics = buildRunMetrics({
    badCase,
    replay: { trace_id: "trace-1", decision: "answer", metrics: { hit_at_5: 1, mrr: 1, relevant_rank: 1 } } as never,
    report,
    toolCalls: ["get_bad_case", "get_bad_case_attempts", "replay_bad_case", "get_replay_trace", "finish_diagnosis"],
    durationMs: 1200,
    completed: true,
  });
  assert.equal(metrics.find((item) => item.name === "required_tool_coverage")?.value, 1);
  assert.equal(metrics.find((item) => item.name === "mutation_tools_called")?.value, 0);
  assert.equal(metrics.find((item) => item.name === "trace_produced")?.passed, true);
});
