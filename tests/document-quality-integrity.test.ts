import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createContext, runInContext } from "node:vm";
import { evaluateDocumentCase, evaluateDocumentQuality, compareDocumentQualityReports, renderDocumentQualityMarkdown, type DocumentQualityDataset, type DocumentPipelineArtifact } from "../src/document-quality.js";
import { prepareDocumentQualityRetrievalExperiment, runDocumentQualityExperiment } from "../src/document-quality-platform.js";

const dataset: DocumentQualityDataset = {
  schema: "agent-evaluation.document-quality.dataset.v1", suite_id: "integrity", dataset_id: "integrity",
  version: "1", domain: "test", language: "zh-CN", provenance: "deterministic adversarial fixture",
  contains_patient_data: false, description: "No model calls or real medical instructions", snapshot_id: "sha256:integrity",
  split_policy: { development: { purpose: "test", case_count: 1, prompt_visible: true }, holdout: { purpose: "test", case_count: 0, prompt_visible: false }, regression: { purpose: "test", case_count: 0, prompt_visible: true } },
  cases: [{ case_id: "probe", source_group: "manual", split: "development", input_variant: "native", expected_status: "ready", critical_fields: ["4.2"], retrieval_queries: [{ query_id: "q1", query: "version 4.2", required_document_ids: ["manual"], required_content_spans: ["expected evidence"] }] }],
};

function artifact(): DocumentPipelineArtifact {
  return { schema: "agent-evaluation.document-quality.artifact.v2", case_id: "probe", document_id: "manual", source_file: "manual.md", metadata: { model_codes: ["VSM-100"], software_version_from: "4.2" }, status: "ready", indexed: false, config_fingerprint: "fixture", blocks: [{ block_type: "paragraph", text: "软件版本4.2。" }], cleaning: { removed_blocks: [] }, chunks: [{ chunk_id: "c1", parent_id: "manual", content: "expected evidence" }], retrieval: [] };
}

test("exact critical fields reject identifier prefixes, suffixes and dotted versions", () => {
  for (const [expected, actual] of [["4.2", "14.2"], ["4.2", "4.2.1"], ["4.2", "4.2-beta"], ["VSM-42", "VSM-420"], ["LOT-P2801", "LOT-P28010"], ["BAT-021", "BAT-021_A"]]) {
    const result = evaluateDocumentCase({ ...dataset.cases[0], critical_fields: [expected] }, { ...artifact(), blocks: [{ block_type: "paragraph", text: actual }] }, ["ocr"]);
    assert.equal(result.passed, false, `${expected} must not match ${actual}`);
  }
  for (const text of ["版本4.2可用", "(4.2)", "Version 4.2. Next step", "版本14.2，正确版本4.2。"])
    assert.equal(evaluateDocumentCase(dataset.cases[0], { ...artifact(), blocks: [{ block_type: "paragraph", text }] }, ["ocr"]).passed, true, text);
});

test("evidence in the wrong document cannot satisfy the required answer span", () => {
  const value = artifact();
  value.retrieval = [{ query_id: "q1", hits: [{ document_id: "manual", content: "incomplete" }, { document_id: "wrong", content: "expected evidence" }] }];
  const result = evaluateDocumentCase(dataset.cases[0], value, ["retrieval"]);
  assert.equal(result.measurements.retrieval_hits, 1);
  assert.equal(result.measurements.retrieval_evidence_spans_contained, 0);
  assert.equal(result.passed, false);
});

test("missing coverage is null, not 100 percent, and cannot pass a hard gate", () => {
  const unannotated = { ...dataset, cases: [{ ...dataset.cases[0], critical_fields: [], retrieval_queries: [] }] };
  const report = evaluateDocumentQuality(unannotated, [artifact()], "development", ["ocr", "retrieval"]);
  for (const name of ["critical_field_exact_match", "retrieval_hit_at_5", "retrieval_source_locator_accuracy"]) {
    const metric = report.metrics.find(x => x.name === name);
    assert.equal(metric?.value, null, name);
    assert.equal(metric?.passed, null, name);
    assert.equal(metric?.status, "not_evaluated", name);
    assert.equal(metric?.sample_count, 0, name);
  }
  assert.equal(report.gate_passed, false);
  assert.match(renderDocumentQualityMarkdown(report), /NOT_EVALUATED/);
  const comparison = compareDocumentQualityReports(report, report);
  const delta = comparison.metric_deltas.find(x => x.name === "retrieval_hit_at_5");
  assert.equal(delta?.delta, null);
  assert.equal(delta?.improved, false);
  assert.equal(comparison.promotable, false);
});

test("chunk experiments freeze metadata, source, parser and non-chunk configuration", () => {
  const baseline = { schema: "agent-evaluation.document-quality.artifacts.v2", config: { max_runes: 400, overlap_runes: 100, pipeline_release: "release-1", embedding_model: "embedding-1" }, artifacts: [artifact()] };
  for (const mutate of [
    (x: typeof baseline) => { x.artifacts[0].metadata!.model_codes = ["OTHER"]; },
    (x: typeof baseline) => { x.artifacts[0].source_file = "different.md"; },
    (x: typeof baseline) => { x.config.pipeline_release = "release-2"; },
    (x: typeof baseline) => { x.config.embedding_model = "embedding-2"; },
    (x: typeof baseline) => { x.artifacts[0].metadata!.software_version_from = "14.2"; },
    (x: typeof baseline) => { x.artifacts[0].metadata!.affected_lots = ["OTHER-LOT"]; },
    (x: typeof baseline) => { x.artifacts[0].source_sha256 = "different-source-hash"; },
    (x: typeof baseline) => { x.artifacts[0].document_ir = { quality: { parser_version: "new-parser" } }; },
  ]) {
    const candidate = structuredClone(baseline); candidate.config.max_runes = 700; candidate.config.overlap_runes = 80; mutate(candidate);
    assert.throws(() => prepareDocumentQualityRetrievalExperiment({ dataset, baseline_artifacts: baseline, candidate_artifacts: candidate }), /single-variable|configuration/);
  }
  const candidate = structuredClone(baseline); candidate.config.max_runes = 700; candidate.config.overlap_runes = 80;
  assert.doesNotThrow(() => prepareDocumentQualityRetrievalExperiment({ dataset, baseline_artifacts: baseline, candidate_artifacts: candidate }));
});

test("legacy reports and coverage changes cannot authorize promotion", () => {
  const report = evaluateDocumentQuality(dataset, [artifact()], "development", ["ocr"]);
  assert.equal(report.gate_passed, true);
  const legacy = { ...report, evaluator_version: "document-quality/1" };
  assert.throws(() => compareDocumentQualityReports(legacy, report), /re-evaluation/);
  const changed = structuredClone(report);
  changed.metrics.find(x => x.name === "critical_field_exact_match")!.sample_count += 1;
  assert.equal(compareDocumentQualityReports(report, changed).promotable, false);
  assert.throws(() => evaluateDocumentQuality({ ...dataset, cases: [] }, [], "development"), /empty/);
});

test("source hashes and IR are frozen while runtime duration and JSON key order may change", () => {
  const source = artifact(); source.source_sha256 = "sha256:unchanged";
  source.pipeline_config = { max_runes: 400, overlap_runes: 100, parser_version: "1" };
  const baseline = { schema: "agent-evaluation.document-quality.artifacts.v2", config: { max_runes: 400, overlap_runes: 100 }, artifacts: [source] };
  const candidate = structuredClone(baseline); candidate.config.max_runes = 700; candidate.config.overlap_runes = 80;
  candidate.artifacts[0].pipeline_config = { parser_version: "1", overlap_runes: 80, max_runes: 700 };
  candidate.artifacts[0].runtime = { duration_ms: 999 };
  candidate.artifacts[0].metadata = { software_version_from: "4.2", model_codes: ["VSM-100"] };
  assert.doesNotThrow(() => prepareDocumentQualityRetrievalExperiment({ dataset, baseline_artifacts: baseline, candidate_artifacts: candidate }));
  candidate.artifacts[0].pipeline_config.parser_version = "2";
  assert.throws(() => prepareDocumentQualityRetrievalExperiment({ dataset, baseline_artifacts: baseline, candidate_artifacts: candidate }), /single-variable/);
});

test("web renderer exposes uncovered metrics and labels legacy reports without a green pass", async () => {
  const source = await readFile("public/document-quality.js", "utf8");
  const nodes = new Map<string, {innerHTML: string; textContent: string; className: string; scrollIntoView(): void}>();
  const context = createContext({ document: { querySelector: (selector: string) => {
    if (!nodes.has(selector)) nodes.set(selector, {innerHTML: "", textContent: "", className: "", scrollIntoView() {}});
    return nodes.get(selector);
  } } });
  // Evaluate the real renderer definitions without bootstrapping HTTP/login.
  runInContext(source.slice(0, source.indexOf('$("#baselineFile").addEventListener')), context);
  assert.match(String(runInContext("locatorLabel({heading_path:['heading']})", context)), /无页码 \/ 工作表标注/);
  assert.doesNotMatch(String(runInContext("locatorLabel({heading_path:['heading']})", context)), /XLSX/);
  const baseline = {schema: "agent-evaluation.document-quality.artifacts.v2", config: {max_runes:400, overlap_runes:100}, artifacts:[artifact()]};
  const candidate = structuredClone(baseline); candidate.config = {max_runes:700, overlap_runes:80};
  const result = runDocumentQualityExperiment({identity:{subject:"test",tenant_id:"test",roles:["admin"]}, dataset, baseline_artifacts:baseline, candidate_artifacts:candidate});
  assert.equal(result.frozen_profiles.baseline.input_fingerprint, result.frozen_profiles.candidate.input_fingerprint);
  context.probe = result;
  runInContext("renderResult(probe)", context);
  assert.match(nodes.get("#result")!.innerHTML, /未评测 \(n=0\)/);
  assert.match(nodes.get("#result")!.innerHTML, /缺少评测覆盖/);
  result.candidate_report.evaluator_version = "legacy"; result.promotion_status = "holdout_passed";
  runInContext("renderResult(probe)", context);
  assert.equal(nodes.get("#resultStatus")!.textContent, "历史记录 · 待复核");
  assert.equal(nodes.get("#resultStatus")!.className.includes("safe"), false);
  assert.match(nodes.get("#result")!.innerHTML, /历史未复核/);
  runInContext("state.experiments = [probe]; renderHistory()", context);
  assert.match(nodes.get("#history")!.innerHTML, /历史待复核/);
  assert.doesNotMatch(nodes.get("#history")!.innerHTML, /class="passed"/);
});
