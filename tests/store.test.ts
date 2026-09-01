import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { EvaluationRun, PilotRun, ProjectWorkspace, StagePromptExperiment } from "../src/contracts.js";
import type { DocumentQualityExperiment } from "../src/document-quality-platform.js";
import { RunStore } from "../src/store.js";

test("persists runs and preserves tenant isolation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-evaluation-"));
  try {
    const store = new RunStore(directory);
    const run = { run_id: `eval_${"a".repeat(32)}`, tenant_id: "tenant_a", started_at: new Date().toISOString() } as EvaluationRun;
    await store.save(run);
    assert.equal((await store.list({ subject: "alice", tenant_id: "tenant_a", roles: ["admin"] })).length, 1);
    assert.equal((await store.list({ subject: "bob", tenant_id: "tenant_b", roles: ["admin"] })).length, 0);
    assert.equal(await store.get(run.run_id, { subject: "bob", tenant_id: "tenant_b", roles: ["admin"] }), undefined);

    const pilot = { pilot_run_id: `pilot_${"b".repeat(32)}`, tenant_id: "tenant_a", started_at: new Date().toISOString() } as PilotRun;
    await store.savePilot(pilot);
    assert.equal((await store.listPilots({ subject: "alice", tenant_id: "tenant_a", roles: ["admin"] })).length, 1);
    assert.equal(await store.getPilot(pilot.pilot_run_id, { subject: "bob", tenant_id: "tenant_b", roles: ["admin"] }), undefined);

    const workspace = { workspace_id: `workspace_${"c".repeat(32)}`, tenant_id: "tenant_a", updated_at: new Date().toISOString() } as ProjectWorkspace;
    await store.saveWorkspace(workspace);
    assert.equal((await store.listWorkspaces({ subject: "alice", tenant_id: "tenant_a", roles: ["admin"] })).length, 1);
    assert.equal(await store.getWorkspace(workspace.workspace_id, { subject: "bob", tenant_id: "tenant_b", roles: ["admin"] }), undefined);

    const stageExperiment = { stage_experiment_id: `stageexp_${"d".repeat(32)}`, workspace_id: workspace.workspace_id, tenant_id: "tenant_a", started_at: new Date().toISOString() } as StagePromptExperiment;
    await store.saveStageExperiment(stageExperiment);
    assert.equal((await store.listStageExperiments({ subject: "alice", tenant_id: "tenant_a", roles: ["admin"] }, workspace.workspace_id)).length, 1);
    assert.equal((await store.listStageExperiments({ subject: "bob", tenant_id: "tenant_b", roles: ["admin"] }, workspace.workspace_id)).length, 0);

    const documentExperiment = { experiment_id: `docqexp_${"e".repeat(32)}`, tenant_id: "tenant_a", started_at: new Date().toISOString() } as DocumentQualityExperiment;
    await store.saveDocumentQualityExperiment(documentExperiment);
    assert.equal((await store.listDocumentQualityExperiments({ subject: "alice", tenant_id: "tenant_a", roles: ["admin"] })).length, 1);
    assert.equal(await store.getDocumentQualityExperiment(documentExperiment.experiment_id, { subject: "bob", tenant_id: "tenant_b", roles: ["admin"] }), undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
