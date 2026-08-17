import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { EvaluationRun, PilotRun } from "../src/contracts.js";
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
  } finally { await rm(directory, { recursive: true, force: true }); }
});
