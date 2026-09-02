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
  const artifact = (caseID: string, documentID: string, text: string): DocumentPipelineArtifact => ({
    schema: "agent-evaluation.document-quality.artifact.v2",
    case_id: caseID,
    document_id: documentID,
    source_file: `${documentID}.fixture`,
    status: "ready",
    indexed: false,
    config_fingerprint: "test:700-80",
    blocks: [{ block_type: "paragraph", text }],
    cleaning: { removed_blocks: [] },
    chunks: [{ chunk_id: `${documentID}#c1`, parent_id: documentID, content: text, parent_content: text }],
    retrieval: [],
  });
  return {
    schema: "agent-evaluation.document-quality.artifacts.v1",
    config: { max_runes: 700, overlap_runes: 80, pipeline_release: "release-v1", observed_parsers: ["ocr@1"] },
    artifacts: [
      ...fixture.artifacts.map((item) => ({ ...clone(item), indexed: false, retrieval: [] })),
      artifact("dev-version-scope-filter-006", "synthetic-vsm460-network-r4", "VSM-460 software 5.1 NET-SYNC-311: export diagnostics, renew the current certificate, verify gateway and time sync, then observe for 15 minutes."),
      artifact("dev-version-scope-filter-006", "synthetic-vsm460-network-r3", "VSM-460 software 4.7 NET-SYNC-311 Superseded by revision R4"),
      artifact("dev-model-suffix-filter-007", "synthetic-vsm420-pro-power-r1", "VSM-420 Pro PWR-017 处理：保留增强电源日志并检查双路冗余输入。"),
      artifact("dev-model-suffix-filter-007", "synthetic-vsm420-power-r1", "VSM-420 PWR-017 处理：检查标准电源模块和单路输入。"),
      artifact("dev-lot-scope-filter-008", "synthetic-c5-field-notice-r2", "BeneHeart C5 LOT-M2701 Quarantine sales stock and install insulation kit C5-M27."),
      artifact("dev-lot-scope-filter-008", "synthetic-c5-field-notice-r1", "BeneHeart C5 LOT-M2602 Historical lot only"),
    ],
  };
}

function holdoutBundle(dataset: Awaited<ReturnType<typeof loadDocumentQualityDataset>>, maxRunes: number, overlapRunes: number): DocumentArtifactBundle {
  const artifact = (caseID: string, documentID: string, blocks: DocumentPipelineArtifact["blocks"], chunks: DocumentPipelineArtifact["chunks"]): DocumentPipelineArtifact => ({
    schema: "agent-evaluation.document-quality.artifact.v2",
    case_id: caseID,
    document_id: documentID,
    source_file: `${documentID}.fixture`,
    status: "ready",
    indexed: false,
    config_fingerprint: `test:${maxRunes}-${overlapRunes}`,
    blocks,
    cleaning: { removed_blocks: [] },
    chunks,
    retrieval: [],
  });
  return {
    schema: "agent-evaluation.document-quality.artifacts.v2",
    config: { max_runes: maxRunes, overlap_runes: overlapRunes, pipeline_release: "release-v1", observed_parsers: ["native@1"] },
    artifacts: [
      ...(() => {
        const span = dataset.cases.find((item) => item.case_id === "holdout-version-conflict-004")?.required_chunk_spans?.[0] ?? "";
        const currentChunks = maxRunes < 700
          ? [
            { chunk_id: `vsm450-r3-${maxRunes}-a`, parent_id: "vsm450-r3", content: span.slice(0, 220), parent_content: span },
            { chunk_id: `vsm450-r3-${maxRunes}-b`, parent_id: "vsm450-r3", content: span.slice(180), parent_content: span },
          ]
          : [{ chunk_id: `vsm450-r3-${maxRunes}`, parent_id: "vsm450-r3", content: span, parent_content: span }];
        return [
          artifact("holdout-version-conflict-004", "synthetic-vsm450-network-r3", [
            { block_type: "paragraph", text: span },
          ], currentChunks),
          artifact("holdout-version-conflict-004", "synthetic-vsm450-network-r2", [
            { block_type: "paragraph", text: "VSM-450 软件 3.8 NET-LINK-204 此修订已被 4.2 网络恢复流程取代" },
          ], [{ chunk_id: `vsm450-r2-${maxRunes}`, parent_id: "vsm450-r2", content: "VSM-450 软件 3.8 NET-LINK-204 此修订已被 4.2 网络恢复流程取代", parent_content: "VSM-450 软件 3.8 NET-LINK-204 此修订已被 4.2 网络恢复流程取代" }]),
        ];
      })(),
      artifact("holdout-similar-model-005", "synthetic-vsm410-pro-power-r1", [
        { block_type: "paragraph", text: "VSM-410 Pro PWR-017 处理：保留增强电源模块日志并检查双路输入。" },
      ], [{ chunk_id: `pro-${maxRunes}`, parent_id: "pro", content: "VSM-410 Pro PWR-017 处理：保留增强电源模块日志并检查双路输入。", parent_content: "VSM-410 Pro PWR-017 处理：保留增强电源模块日志并检查双路输入。" }]),
      artifact("holdout-similar-model-005", "synthetic-vsm410-power-r1", [
        { block_type: "paragraph", text: "VSM-410 PWR-017 处理：检查标准电源模块和单路输入。" },
      ], [{ chunk_id: `base-${maxRunes}`, parent_id: "base", content: "VSM-410 PWR-017 处理：检查标准电源模块和单路输入。", parent_content: "VSM-410 PWR-017 处理：检查标准电源模块和单路输入。" }]),
      artifact("holdout-superseded-notice-006", "synthetic-c3-field-notice-r3", [
        { block_type: "paragraph", text: "BeneHeart C3 C3-FSN-026 Revision 3 当前有效 LOT-K2608 停止销售库存并由授权人员安装绝缘垫片套件 FSN-K26" },
      ], [{ chunk_id: `notice-r3-${maxRunes}`, parent_id: "notice-r3", content: "BeneHeart C3 C3-FSN-026 Revision 3 当前有效 LOT-K2608 停止销售库存并由授权人员安装绝缘垫片套件 FSN-K26", parent_content: "BeneHeart C3 C3-FSN-026 Revision 3 当前有效 LOT-K2608 停止销售库存并由授权人员安装绝缘垫片套件 FSN-K26" }]),
      artifact("holdout-superseded-notice-006", "synthetic-c3-field-notice-r1", [
        { block_type: "paragraph", text: "BeneHeart C3 C3-FSN-026 Revision 1 已被 Revision 3 取代 LOT-K2501" },
      ], [{ chunk_id: `notice-r1-${maxRunes}`, parent_id: "notice-r1", content: "BeneHeart C3 C3-FSN-026 Revision 1 已被 Revision 3 取代 LOT-K2501", parent_content: "BeneHeart C3 C3-FSN-026 Revision 1 已被 Revision 3 取代 LOT-K2501" }]),
    ],
  };
}

test("runs and diagnoses a single-variable development document experiment", async () => {
  const dataset = await loadDocumentQualityDataset("./datasets/raglab-document-quality-v1.json");
  const candidate = await candidateBundle();
  const baseline = clone(candidate);
  baseline.config = { ...candidate.config, max_runes: 400, overlap_runes: 100 };
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
  assert.equal(experiment.comparison.baseline.cases_passed, 7);
  assert.equal(experiment.comparison.candidate.cases_passed, 8);
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
  baseline.config = { ...candidate.config, max_runes: 400, overlap_runes: 100 };
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
    ["dev-vsm460-current-version-scope-query", "synthetic-vsm460-network-r4"],
    ["dev-vsm420-pro-model-scope-query", "synthetic-vsm420-pro-power-r1"],
    ["dev-c5-current-lot-scope-query", "synthetic-c5-field-notice-r2"],
    ["holdout-vsm450-current-version-query", "synthetic-vsm450-network-r3"],
    ["holdout-vsm410-pro-power-query", "synthetic-vsm410-pro-power-r1"],
    ["holdout-c3-current-notice-query", "synthetic-c3-field-notice-r3"],
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
  dataset.split_policy.holdout.status = "sealed";
  const developmentCandidate = await candidateBundle();
  const developmentBaseline = clone(developmentCandidate);
  developmentBaseline.config = { ...developmentCandidate.config, max_runes: 400, overlap_runes: 100 };
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

  const baseline = holdoutBundle(dataset, 400, 100);
  const candidate = holdoutBundle(dataset, 700, 80);
  const prepared = prepareDocumentQualityHoldoutGate({
    dataset,
    parent_experiment: parent,
    intervention: { variable: "chunk_profile", baseline: "400/100", candidate: "700/80" },
    baseline_artifacts: baseline,
    candidate_artifacts: candidate,
  });
  assert.equal(prepared.baseline_request.chunks.length > prepared.candidate_request.chunks.length, true);
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
  assert.equal(result.retrieval_sandbox?.candidate.chunks_indexed, 6);
  dataset.split_policy.holdout.status = "exposed";
  assert.throws(() => prepareDocumentQualityHoldoutGate({
    dataset,
    parent_experiment: parent,
    intervention: { variable: "chunk_profile", baseline: "400/100", candidate: "700/80" },
    baseline_artifacts: baseline,
    candidate_artifacts: candidate,
  }), /exposed and cannot be reused/);
});

test("runs a real-provider retrieval contract without persisting raw chunks", async () => {
  const dataset = await loadDocumentQualityDataset("./datasets/raglab-document-quality-v1.json");
  const candidate = await candidateBundle();
  const baseline = clone(candidate);
  baseline.config = { ...candidate.config, max_runes: 400, overlap_runes: 100 };
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
  assert.equal(experiment.baseline_report.metrics.find((item) => item.name === "retrieval_evidence_span_containment")?.value, 0.75);
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
  baseline.config = { ...candidate.config, max_runes: 400, overlap_runes: 100 };
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
