import assert from "node:assert/strict";
import test from "node:test";

import { ToolPolicy } from "../src/policy.js";

test("rejects tools outside the evaluation allowlist", () => {
  const result = new ToolPolicy(8).authorize("publish_index");
  assert.equal(result.allowed, false);
});

test("allows exactly one system replay", () => {
  const policy = new ToolPolicy(8);
  assert.equal(policy.authorize("replay_bad_case").allowed, true);
  assert.equal(policy.authorize("replay_bad_case").allowed, false);
});

test("enforces the total tool budget", () => {
  const policy = new ToolPolicy(1);
  assert.equal(policy.authorize("get_bad_case").allowed, true);
  assert.equal(policy.authorize("get_bad_case_attempts").allowed, false);
});
