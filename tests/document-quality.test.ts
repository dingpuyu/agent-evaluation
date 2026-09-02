import assert from "node:assert/strict";
import test from "node:test";

import {
  characterErrorRate,
  compareDocumentQualityReports,
  evaluateDocumentCase,
  evaluateDocumentQuality,
  loadDocumentQualityDataset,
  type DocumentPipelineArtifact,
  type DocumentQualityCase,
  type DocumentQualityDataset,
} from "../src/document-quality.js";

const richCase: DocumentQualityCase = {
  case_id: "quality-rich-001",
  split: "development",
  source_group: "manual-r1",
  input_variant: "scan-200dpi",
  expected_status: "ready",
  expected_blocks: [
    { type: "heading", text: "AED 设备故障排查", page: 1 },
    { contains: "BAT-LOW-021", page: 1 },
  ],
  expected_reading_order: ["AED 设备故障排查", "BeneHeart C2", "BAT-LOW-021"],
  critical_fields: ["BeneHeart C2", "BAT-LOW-021"],
  forbidden_normalizations: ["BAT-LOW-O21"],
  expected_removed_noise: ["PulseCare Medical Devices"],
  protected_text: ["仅授权服务人员执行"],
  required_chunk_spans: ["BAT-LOW-021 处理：连接交流电源并检查电池状态"],
  retrieval_queries: [{
    query_id: "q1",
    query: "BAT-LOW-021 怎么处理？",
    required_document_ids: ["manual-r1"],
    forbidden_document_ids: ["wrong-manual"],
    required_source_pages: [1],
    required_content_spans: ["BAT-LOW-021 处理：连接交流电源并检查电池状态"],
  }],
};

function passingArtifact(): DocumentPipelineArtifact {
  const parent = "BAT-LOW-021 处理：连接交流电源并检查电池状态。仅授权服务人员执行";
  return {
    schema: "agent-evaluation.document-quality.artifact.v1",
    case_id: richCase.case_id,
    status: "ready",
    indexed: true,
    config_fingerprint: "sha256:baseline",
    blocks: [
      { block_type: "heading", text: "AED 设备故障排查", page: 1, confidence: 0.99 },
      { block_type: "paragraph", text: "型号：BeneHeart C2", page: 1, confidence: 0.98 },
      { block_type: "paragraph", text: parent, page: 1, confidence: 0.97 },
    ],
    cleaning: {
      removed_blocks: [{ block_type: "paragraph", text: "PulseCare Medical Devices", page: 1, reason: "repeated_header" }],
    },
    chunks: [{ chunk_id: "c1", parent_id: "p1", content: parent, parent_content: parent, source_page: 1 }],
    retrieval: [{ query_id: "q1", hits: [{ document_id: "manual-r1", source_page: 1, content: parent, score: 0.92 }] }],
  };
}

test("loads the frozen document quality dataset with source-grouped splits", async () => {
  const dataset = await loadDocumentQualityDataset("./datasets/raglab-document-quality-v1.json");
  assert.equal(dataset.cases.length, 17);
  assert.equal(dataset.cases.filter((item) => item.split === "development").length, 8);
  assert.equal(dataset.cases.filter((item) => item.split === "holdout").length, 3);
  assert.equal(dataset.cases.filter((item) => item.split === "regression").length, 6);
  assert.match(dataset.snapshot_id ?? "", /^sha256:[a-f0-9]{64}$/);
  for (const sourceGroup of new Set(dataset.cases.map((item) => item.source_group))) {
    assert.equal(new Set(dataset.cases.filter((item) => item.source_group === sourceGroup).map((item) => item.split)).size, 1);
  }
});

test("passes a complete OCR, cleaning, chunk and retrieval artifact", () => {
  const result = evaluateDocumentCase(richCase, passingArtifact());
  assert.equal(result.passed, true);
  assert.deepEqual(result.failure_layers, []);
  assert.equal(result.measurements.critical_matched, 2);
  assert.equal(result.measurements.spans_contained, 1);
  assert.equal(result.measurements.retrieval_hits, 1);
});

test("detects an identifier substitution as OCR instead of a prompt problem", () => {
  const artifact = passingArtifact();
  artifact.blocks[2].text = artifact.blocks[2].text.replace("BAT-LOW-021", "BAT-LOW-O21");
  artifact.chunks[0].content = artifact.chunks[0].content.replace("BAT-LOW-021", "BAT-LOW-O21");
  const result = evaluateDocumentCase(richCase, artifact);
  assert.equal(result.passed, false);
  assert.ok(result.failure_layers.includes("ocr"));
  assert.ok(result.checks.some((item) => item.name === "critical_field:BAT-LOW-021" && !item.passed));
});

test("detects protected text deletion as cleaning failure", () => {
  const artifact = passingArtifact();
  artifact.blocks[2].text = artifact.blocks[2].text.replace("。仅授权服务人员执行", "");
  artifact.cleaning.removed_blocks.push({ block_type: "paragraph", text: "仅授权服务人员执行", page: 1, reason: "fuzzy_duplicate" });
  const result = evaluateDocumentCase(richCase, artifact);
  assert.ok(result.failure_layers.includes("cleaning"));
  assert.ok(!result.failure_layers.includes("ocr"));
});

test("detects an answer span split across chunks", () => {
  const artifact = passingArtifact();
  const parent = artifact.chunks[0].parent_content ?? "";
  artifact.chunks = [
    { chunk_id: "c1", parent_id: "p1", content: "BAT-LOW-021 处理：", parent_content: parent },
    { chunk_id: "c2", parent_id: "p1", content: "连接交流电源并检查电池状态", parent_content: parent },
  ];
  const result = evaluateDocumentCase(richCase, artifact);
  assert.ok(result.failure_layers.includes("chunk"));
});

test("detects forbidden retrieval evidence and unsafe review publication", () => {
  const retrievalArtifact = passingArtifact();
  retrievalArtifact.retrieval[0].hits.unshift({ document_id: "wrong-manual", source_page: 1 });
  const retrievalResult = evaluateDocumentCase(richCase, retrievalArtifact);
  assert.ok(retrievalResult.failure_layers.includes("retrieval"));

  const reviewCase = { ...richCase, case_id: "review-001", expected_status: "review_required" as const };
  const reviewArtifact = { ...passingArtifact(), case_id: "review-001", status: "review_required" as const, indexed: true };
  const reviewResult = evaluateDocumentCase(reviewCase, reviewArtifact);
  assert.ok(reviewResult.failure_layers.includes("safety"));
});

test("rejects document-level hits whose evidence span is split across retrieved chunks", () => {
  const artifact = passingArtifact();
  artifact.retrieval[0].hits = [
    { document_id: "manual-r1", source_page: 1, content: "BAT-LOW-021 处理：连接交流电源" },
    { document_id: "manual-r1", source_page: 1, content: "并检查电池状态" },
  ];
  const result = evaluateDocumentCase(richCase, artifact, ["retrieval"]);
  assert.equal(result.measurements.retrieval_hits, 1);
  assert.equal(result.measurements.retrieval_evidence_spans_contained, 0);
  assert.ok(result.failure_layers.includes("retrieval"));
});

test("aggregates hard gates and keeps embedding amplification soft", () => {
  const dataset = {
    schema: "agent-evaluation.document-quality.dataset.v1",
    suite_id: "raglab.document-quality.test",
    dataset_id: "quality-test",
    version: "1",
    domain: "test",
    language: "zh-CN",
    provenance: "unit-test",
    contains_patient_data: false,
    description: "test",
    split_policy: {
      development: { purpose: "test", case_count: 1, prompt_visible: true },
      holdout: { purpose: "test", case_count: 0, prompt_visible: false },
      regression: { purpose: "test", case_count: 0, prompt_visible: true },
    },
    cases: [richCase],
    snapshot_id: "sha256:test",
  } satisfies DocumentQualityDataset;
  const artifact = passingArtifact();
  const report = evaluateDocumentQuality(dataset, [artifact], "development");
  assert.equal(report.gate_passed, true);
  assert.equal(report.cases_passed, 1);
  assert.equal(report.metrics.find((item) => item.name === "critical_field_exact_match")?.value, 1);

  const broken = passingArtifact();
  broken.blocks[2].text = broken.blocks[2].text.replace("BAT-LOW-021", "BAT-LOW-O21");
  const failed = evaluateDocumentQuality(dataset, [broken], "development");
  assert.equal(failed.gate_passed, false);
  assert.equal(failed.metrics.find((item) => item.name === "hard_case_failure_count")?.value, 1);
});

test("evaluates multiple competing documents as one case without losing document identity", () => {
  const multiCase: DocumentQualityCase = {
    ...richCase,
    case_id: "multi-document-001",
    expected_blocks: [],
    expected_reading_order: [],
    expected_removed_noise: [],
    forbidden_normalizations: [],
    critical_fields: ["VSM-410", "VSM-410 Pro", "PWR-017"],
    protected_text: ["标准电源模块", "增强电源模块"],
    required_chunk_spans: ["PWR-017 处理：检查增强电源模块"],
    retrieval_queries: [{
      query_id: "multi-q1",
      query: "VSM-410 Pro 的 PWR-017 怎么处理？",
      required_document_ids: ["vsm410-pro-r1"],
      forbidden_document_ids: ["vsm410-r1"],
      required_content_spans: ["PWR-017 处理：检查增强电源模块"],
    }],
  };
  const base = (documentID: string, text: string): DocumentPipelineArtifact => ({
    schema: "agent-evaluation.document-quality.artifact.v2",
    case_id: multiCase.case_id,
    document_id: documentID,
    source_file: `${documentID}.docx`,
    status: "ready",
    indexed: true,
    config_fingerprint: "sha256:multi",
    blocks: [{ block_type: "paragraph", text }],
    cleaning: { removed_blocks: [] },
    chunks: [{ chunk_id: `${documentID}#c1`, parent_id: documentID, content: text, parent_content: text }],
    retrieval: [{
      query_id: "multi-q1",
      hits: [{ document_id: "vsm410-pro-r1", content: "VSM-410 Pro PWR-017 处理：检查增强电源模块" }],
    }],
  });
  const dataset = {
    schema: "agent-evaluation.document-quality.dataset.v1",
    suite_id: "multi", dataset_id: "multi", version: "1", domain: "test", language: "zh-CN",
    provenance: "unit-test", contains_patient_data: false, description: "multi document",
    split_policy: {
      development: { purpose: "test", case_count: 1, prompt_visible: true },
      holdout: { purpose: "test", case_count: 0, prompt_visible: false },
      regression: { purpose: "test", case_count: 0, prompt_visible: true },
    },
    cases: [multiCase], snapshot_id: "sha256:multi",
  } satisfies DocumentQualityDataset;
  const report = evaluateDocumentQuality(dataset, [
    base("vsm410-r1", "VSM-410 PWR-017 处理：检查标准电源模块"),
    base("vsm410-pro-r1", "VSM-410 Pro PWR-017 处理：检查增强电源模块"),
  ], "development");
  assert.equal(report.gate_passed, true);
  assert.equal(report.metrics.find((item) => item.name === "wrong_document_count")?.value, 0);
});

test("computes Unicode character error rate deterministically", () => {
  assert.equal(characterErrorRate("授权服务人员", "授权服务人员"), 0);
  assert.equal(characterErrorRate("授权服务人员", "授权服务员"), 1 / 6);
  assert.equal(characterErrorRate("BAT-LOW-021", "BAT-LOW-O21"), 1 / 11);
});

test("reports an explicit document-only scope without pretending retrieval ran", () => {
  const artifact = passingArtifact();
  artifact.retrieval = [];
  artifact.indexed = false;
  const dataset = {
    schema: "agent-evaluation.document-quality.dataset.v1",
    suite_id: "raglab.document-quality.scope-test",
    dataset_id: "scope-test",
    version: "1",
    domain: "test",
    language: "zh-CN",
    provenance: "unit-test",
    contains_patient_data: false,
    description: "test",
    split_policy: {
      development: { purpose: "test", case_count: 1, prompt_visible: true },
      holdout: { purpose: "test", case_count: 0, prompt_visible: false },
      regression: { purpose: "test", case_count: 0, prompt_visible: true },
    },
    cases: [richCase],
    snapshot_id: "sha256:test",
  } satisfies DocumentQualityDataset;
  const report = evaluateDocumentQuality(dataset, [artifact], "development", ["ocr", "layout", "cleaning", "chunk"]);
  assert.equal(report.gate_passed, true);
  assert.deepEqual(report.evaluated_layers, ["ocr", "layout", "cleaning", "chunk"]);
  assert.equal(report.metrics.some((item) => item.name.startsWith("retrieval_")), false);
});

test("promotes a candidate that fixes a hard document case without regression", () => {
  const dataset = {
    schema: "agent-evaluation.document-quality.dataset.v1",
    suite_id: "raglab.document-quality.compare-test",
    dataset_id: "compare-test",
    version: "1",
    domain: "test",
    language: "zh-CN",
    provenance: "unit-test",
    contains_patient_data: false,
    description: "test",
    split_policy: {
      development: { purpose: "test", case_count: 1, prompt_visible: true },
      holdout: { purpose: "test", case_count: 0, prompt_visible: false },
      regression: { purpose: "test", case_count: 0, prompt_visible: true },
    },
    cases: [richCase],
    snapshot_id: "sha256:test",
  } satisfies DocumentQualityDataset;
  const passing = passingArtifact();
  const broken = passingArtifact();
  const parent = broken.chunks[0].parent_content;
  broken.chunks = [
    { ...broken.chunks[0], content: "BAT-LOW-021 处理：连接交流电源并", parent_content: parent },
    { ...broken.chunks[0], chunk_id: "c2", content: "连接交流电源并检查电池状态。仅授权服务人员执行", parent_content: parent },
  ];
  const layers = ["chunk"] as const;
  const baseline = evaluateDocumentQuality(dataset, [broken], "development", layers);
  const candidate = evaluateDocumentQuality(dataset, [passing], "development", layers);
  const comparison = compareDocumentQualityReports(baseline, candidate);
  assert.equal(comparison.promotable, true);
  assert.deepEqual(comparison.fixed_cases, [richCase.case_id]);
  assert.deepEqual(comparison.regressed_cases, []);
  assert.deepEqual(comparison.regressed_metrics, []);
});

test("holds a candidate when a quality metric regresses without crossing its gate", () => {
  const artifact = passingArtifact();
  const dataset = {
    schema: "agent-evaluation.document-quality.dataset.v1",
    suite_id: "raglab.document-quality.metric-regression",
    dataset_id: "metric-regression",
    version: "1",
    domain: "test",
    language: "zh-CN",
    provenance: "unit-test",
    contains_patient_data: false,
    description: "test",
    split_policy: {
      development: { purpose: "test", case_count: 1, prompt_visible: true },
      holdout: { purpose: "test", case_count: 0, prompt_visible: false },
      regression: { purpose: "test", case_count: 0, prompt_visible: true },
    },
    cases: [richCase],
    snapshot_id: "sha256:test",
  } satisfies DocumentQualityDataset;
  const baseline = evaluateDocumentQuality(dataset, [artifact], "development", ["chunk"]);
  const candidate = JSON.parse(JSON.stringify(baseline)) as typeof baseline;
  const amplification = candidate.metrics.find((metric) => metric.name === "mean_embedding_amplification");
  assert.ok(amplification);
  amplification.value = 1.2;
  amplification.passed = true;
  const comparison = compareDocumentQualityReports(baseline, candidate);
  assert.equal(comparison.promotable, false);
  assert.deepEqual(comparison.regressed_metrics, ["mean_embedding_amplification"]);
});
