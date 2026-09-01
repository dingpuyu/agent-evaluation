import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { runDocumentQualityExperiment, type DocumentArtifactBundle } from "../src/document-quality-platform.js";
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
  assert.equal(experiment.comparison.baseline.cases_passed, 3);
  assert.equal(experiment.comparison.candidate.cases_passed, 4);
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
