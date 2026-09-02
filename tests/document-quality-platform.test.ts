import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  completeDocumentQualityHoldoutGate,
  completeDocumentQualityRetrievalExperiment,
  prepareDocumentQualityHoldoutGate,
  prepareDocumentQualityRetrievalExperiment,
  runDocumentQualityExperiment,
  type DocumentArtifactBundle,
  type RetrievalSandboxRequest,
  type RetrievalSandboxRun,
} from "../src/document-quality-platform.js";
import { loadDocumentQualityDataset, type DocumentPipelineArtifact } from "../src/document-quality.js";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function candidateBundle(): Promise<DocumentArtifactBundle> {
  const fixture = JSON.parse(await readFile("./tests/fixtures/document-quality-development-pass.json", "utf8")) as { artifacts: DocumentPipelineArtifact[] };
  return {
    schema: "agent-evaluation.document-quality.artifacts.v1",
    config: { max_runes: 700, overlap_runes: 80 },
    artifacts: fixture.artifacts.map((artifact) => ({ ...clone(artifact), indexed: false, retrieval: [] })),
  };
}

function holdoutBundle(maxRunes: number, overlapRunes: number): DocumentArtifactBundle {
  const artifact = (caseID: string, status: "ready" | "review_required", blocks: DocumentPipelineArtifact["blocks"], chunks: DocumentPipelineArtifact["chunks"]): DocumentPipelineArtifact => ({
    schema: "agent-evaluation.document-quality.artifact.v1",
    case_id: caseID,
    status,
    indexed: false,
    config_fingerprint: `test:${maxRunes}-${overlapRunes}`,
    blocks,
    cleaning: { removed_blocks: [] },
    chunks,
    retrieval: [],
  });
  return {
    schema: "agent-evaluation.document-quality.artifacts.v1",
    config: { max_runes: maxRunes, overlap_runes: overlapRunes },
    artifacts: [
      artifact("holdout-rotated-manual-001", "ready", [
        { block_type: "heading", text: "BeneFusion uVP", page: 1 },
        { block_type: "paragraph", text: "INF-OCC-017", page: 1 },
        { block_type: "paragraph", text: "INF-OCC-017 停止输注并检查管路", page: 1 },
      ], [{ chunk_id: `pump-${maxRunes}`, parent_id: "pump", content: "BeneFusion uVP INF-OCC-017 停止输注并检查管路", parent_content: "BeneFusion uVP INF-OCC-017 停止输注并检查管路", source_page: 1 }]),
      artifact("holdout-low-dpi-review-002", "review_required", [
        { block_type: "paragraph", text: "BeneVision N1" },
      ], [{ chunk_id: `review-${maxRunes}`, parent_id: "review", content: "BeneVision N1", parent_content: "BeneVision N1" }]),
      artifact("holdout-docx-structure-003", "ready", [
        { block_type: "heading", text: "维护前检查", heading_path: ["维护前检查"] },
        { block_type: "list", text: "确认设备已退出临床使用", heading_path: ["维护前检查"] },
        { block_type: "table", text: "C2 | 2.6", heading_path: ["维护前检查"] },
        { block_type: "paragraph", text: "MAINT-003 仅授权服务人员执行", heading_path: ["维护前检查"] },
      ], [{ chunk_id: `aed-${maxRunes}`, parent_id: "aed", content: "维护前检查 C2 2.6 MAINT-003 仅授权服务人员执行", parent_content: "维护前检查 C2 2.6 MAINT-003 仅授权服务人员执行", heading_path: ["维护前检查"] }]),
    ],
  };
}

test("runs and diagnoses a single-variable development document experiment", async () => {
  const dataset = await loadDocumentQualityDataset("./datasets/raglab-document-quality-v1.json");
  const candidate = await candidateBundle();
  const baseline = clone(candidate);
  baseline.config = { max_runes: 400, overlap_runes: 100 };
  const longCase = baseline.artifacts.find((artifact) => artifact.case_id === "dev-chunk-long-procedure-004");
  assert.ok(longCase);
  const parent = longCase.chunks[0]?.parent_content ?? longCase.blocks[0]?.text ?? "";
  longCase.config_fingerprint = "test:400-100";
  longCase.chunks = [
    { chunk_id: "long#c001", parent_id: "long#p001", content: parent.slice(0, 70), parent_content: parent },
    { chunk_id: "long#c002", parent_id: "long#p001", content: parent.slice(60), parent_content: parent },
  ];
  const experiment = runDocumentQualityExperiment({
    identity: { subject: "alice", tenant_id: "tenant_a", roles: ["admin"] },
    dataset,
    split: "development",
    evaluated_layers: ["ocr", "layout", "cleaning", "chunk"],
    intervention: { variable: "chunk_profile", baseline: "400/100", candidate: "700/80" },
    baseline_artifacts: baseline,
    candidate_artifacts: candidate,
  });

  assert.equal(experiment.promotion_status, "development_passed");
  assert.equal(experiment.comparison.baseline.cases_passed, 4);
  assert.equal(experiment.comparison.candidate.cases_passed, 5);
  assert.deepEqual(experiment.comparison.fixed_cases, ["dev-chunk-long-procedure-004"]);
  assert.equal(experiment.diagnosis.root_cause_layer, "chunk");
  assert.equal(experiment.production_mutation, false);
  assert.equal(experiment.raw_artifacts_persisted, false);
  assert.equal("baseline_artifacts" in experiment, false);
});

test("locks holdout and rejects multi-variable document comparisons", async () => {
  const dataset = await loadDocumentQualityDataset("./datasets/raglab-document-quality-v1.json");
  const candidate = await candidateBundle();
  const baseline = clone(candidate);
  baseline.config = { max_runes: 400, overlap_runes: 100 };
  assert.throws(() => runDocumentQualityExperiment({
    identity: { subject: "alice", tenant_id: "tenant_a", roles: ["admin"] }, dataset, split: "holdout",
    intervention: { variable: "chunk_profile", baseline: "400/100", candidate: "700/80" },
    baseline_artifacts: baseline, candidate_artifacts: candidate,
  }), /restricted to the development split/);

  baseline.artifacts[0].blocks[0].text = "changed OCR output";
  assert.throws(() => runDocumentQualityExperiment({
    identity: { subject: "alice", tenant_id: "tenant_a", roles: ["admin"] }, dataset,
    intervention: { variable: "chunk_profile", baseline: "400/100", candidate: "700/80" },
    baseline_artifacts: baseline, candidate_artifacts: candidate,
  }), /not a single-variable chunk experiment/);
});

function sandboxResult(request: RetrievalSandboxRequest): RetrievalSandboxRun {
  const documentByQuery = new Map([
    ["dev-aed-code-query", "synthetic-aed-troubleshooting-r1"],
    ["dev-version-table-query", "synthetic-vsm-compatibility-r1"],
    ["dev-long-procedure-query", "synthetic-long-service-procedure-r1"],
    ["holdout-pump-occlusion-query", "synthetic-pump-manual-r1"],
    ["holdout-aed-maintenance-query", "synthetic-aed-maintenance-r2"],
  ]);
  return {
    schema: "raglab.retrieval-sandbox.run.v1",
    run_id: request.run_id,
    variant: request.variant,
    collection_scope: "temporary-isolated",
    embedder: "openai-compatible/text-embedding-v4",
    dimensions: 1024,
    reranker: "qwen3-rerank",
    retrieval: "exact+bm25+dense+rrf+rerank",
    index: "HNSW/COSINE+SPARSE_INVERTED_INDEX/BM25",
    chunks_indexed: request.chunks.length,
    index_build_latency_ms: 10,
    total_latency_ms: 20,
    cleanup_completed: true,
    production_mutation: false,
    queries: request.queries.map((query) => {
      const documentID = documentByQuery.get(query.query_id) ?? "missing";
      const candidates = request.chunks.filter((chunk) => chunk.document_id === documentID);
      const hit = candidates.find((chunk) => query.query_id !== "dev-long-procedure-query" || chunk.content.includes("最后把测量值")) ?? candidates[0];
      assert.ok(hit);
      return {
        query_id: query.query_id,
        query: query.query,
        embedding_latency_ms: 2,
        search_latency_ms: 3,
        rerank_latency_ms: 4,
        hits: [{
          chunk_id: hit.chunk_id,
          document_id: hit.document_id,
          content: hit.content,
          source_file: hit.source_file,
          source_page: hit.source_page,
          source_sheet: query.query_id === "dev-version-table-query" ? "兼容矩阵" : hit.source_sheet,
          source_cell_range: query.query_id === "dev-version-table-query" ? "A1:C1,A3:C3" : hit.source_cell_range,
          heading_path: query.query_id === "dev-version-table-query" ? ["兼容矩阵"] : hit.heading_path,
          pre_rerank_rank: 2,
          post_rerank_rank: 1,
          fusion_score: 0.02,
          rerank_score: 0.97,
        }],
      };
    }),
  };
}

test("runs a frozen one-time Holdout gate and blocks non-ready artifacts from indexing", async () => {
  const dataset = await loadDocumentQualityDataset("./datasets/raglab-document-quality-v1.json");
  const developmentCandidate = await candidateBundle();
  const developmentBaseline = clone(developmentCandidate);
  developmentBaseline.config = { max_runes: 400, overlap_runes: 100 };
  const developmentPrepared = prepareDocumentQualityRetrievalExperiment({
    dataset,
    intervention: { variable: "chunk_profile", baseline: "400/100", candidate: "700/80" },
    baseline_artifacts: developmentBaseline,
    candidate_artifacts: developmentCandidate,
  });
  const parent = completeDocumentQualityRetrievalExperiment({
    identity: { subject: "alice", tenant_id: "tenant_a", roles: ["admin"] },
    dataset,
    prepared: developmentPrepared,
    baseline_retrieval: sandboxResult(developmentPrepared.baseline_request),
    candidate_retrieval: sandboxResult(developmentPrepared.candidate_request),
  });
  assert.equal(parent.promotion_status, "retrieval_passed");

  const baseline = holdoutBundle(400, 100);
  const candidate = holdoutBundle(700, 80);
  const prepared = prepareDocumentQualityHoldoutGate({
    dataset,
    parent_experiment: parent,
    intervention: { variable: "chunk_profile", baseline: "400/100", candidate: "700/80" },
    baseline_artifacts: baseline,
    candidate_artifacts: candidate,
  });
  assert.equal(prepared.baseline_request.chunks.some((item) => item.chunk_id.startsWith("review-")), false);
  const result = completeDocumentQualityHoldoutGate({
    identity: { subject: "alice", tenant_id: "tenant_a", roles: ["admin"] },
    dataset,
    prepared,
    baseline_retrieval: sandboxResult(prepared.baseline_request),
    candidate_retrieval: sandboxResult(prepared.candidate_request),
  });
  assert.equal(result.dataset.split, "holdout");
  assert.equal(result.promotion_status, "holdout_passed");
  assert.equal(result.release_gate?.verdict, "pass");
  assert.equal(result.candidate_report.metrics.find((item) => item.name === "unsafe_publish_count")?.value, 0);
  assert.equal(result.retrieval_sandbox?.candidate.chunks_indexed, 2);
});

test("runs a real-provider retrieval contract without persisting raw chunks", async () => {
  const dataset = await loadDocumentQualityDataset("./datasets/raglab-document-quality-v1.json");
  const candidate = await candidateBundle();
  const baseline = clone(candidate);
  baseline.config = { max_runes: 400, overlap_runes: 100 };
  const longCase = baseline.artifacts.find((artifact) => artifact.case_id === "dev-chunk-long-procedure-004");
  assert.ok(longCase);
  const parent = longCase.chunks[0]?.parent_content ?? longCase.blocks[0]?.text ?? "";
  longCase.chunks = [
    { chunk_id: "long#c001", parent_id: "long#p001", content: parent.slice(0, 70), parent_content: parent },
    { chunk_id: "long#c002", parent_id: "long#p001", content: parent.slice(60), parent_content: parent },
  ];
  const prepared = prepareDocumentQualityRetrievalExperiment({
    dataset,
    intervention: { variable: "chunk_profile", baseline: "400/100", candidate: "700/80" },
    baseline_artifacts: baseline,
    candidate_artifacts: candidate,
  });
  const experiment = completeDocumentQualityRetrievalExperiment({
    identity: { subject: "alice", tenant_id: "tenant_a", roles: ["admin"] },
    dataset,
    prepared,
    baseline_retrieval: sandboxResult(prepared.baseline_request),
    candidate_retrieval: sandboxResult(prepared.candidate_request),
  });
  assert.equal(experiment.execution_stage, "retrieval-sandbox");
  assert.equal(experiment.promotion_status, "retrieval_passed");
  assert.equal(experiment.baseline_report.metrics.find((item) => item.name === "retrieval_evidence_span_containment")?.value, 0);
  assert.equal(experiment.candidate_report.metrics.find((item) => item.name === "retrieval_evidence_span_containment")?.value, 1);
  assert.equal(experiment.candidate_report.metrics.find((item) => item.name === "retrieval_source_locator_accuracy")?.value, 1);
  assert.equal(experiment.retrieval_sandbox?.candidate.cleanup_completed, true);
  const locatorHit = experiment.retrieval_sandbox?.candidate.queries.find((item) => item.query_id === "dev-version-table-query")?.hits[0];
  assert.equal(locatorHit?.source_sheet, "兼容矩阵");
  assert.equal(locatorHit?.source_cell_range, "A1:C1,A3:C3");
  assert.equal("baseline_bundle" in experiment, false);
  assert.equal("candidate_bundle" in experiment, false);
});

test("holds a candidate when the document is correct but the structured citation locator is wrong", async () => {
  const dataset = await loadDocumentQualityDataset("./datasets/raglab-document-quality-v1.json");
  const candidate = await candidateBundle();
  const baseline = clone(candidate);
  baseline.config = { max_runes: 400, overlap_runes: 100 };
  const prepared = prepareDocumentQualityRetrievalExperiment({
    dataset,
    intervention: { variable: "chunk_profile", baseline: "400/100", candidate: "700/80" },
    baseline_artifacts: baseline,
    candidate_artifacts: candidate,
  });
  const baselineRun = sandboxResult(prepared.baseline_request);
  const candidateRun = sandboxResult(prepared.candidate_request);
  const tableHit = candidateRun.queries.find((item) => item.query_id === "dev-version-table-query")?.hits[0];
  assert.ok(tableHit);
  tableHit.source_cell_range = "A1:C1,A2:C2";

  const experiment = completeDocumentQualityRetrievalExperiment({
    identity: { subject: "alice", tenant_id: "tenant_a", roles: ["admin"] },
    dataset,
    prepared,
    baseline_retrieval: baselineRun,
    candidate_retrieval: candidateRun,
  });
  assert.equal(experiment.promotion_status, "hold");
  assert.equal(experiment.candidate_report.metrics.find((item) => item.name === "retrieval_source_locator_accuracy")?.value, 0.5);
  assert.equal(experiment.candidate_report.results.find((item) => item.case_id === "dev-table-version-003")?.passed, false);
});
