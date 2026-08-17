import assert from "node:assert/strict";
import test from "node:test";

import { loadDataset } from "../src/dataset.js";

test("loads the versioned production-shaped dataset without patient data", async () => {
  const dataset = await loadDataset("./datasets/raglab-medical-sales-production-sample-v1.json");
  assert.equal(dataset.schema, "agent-evaluation.dataset.v1");
  assert.equal(dataset.contains_patient_data, false);
  assert.ok(dataset.cases.length >= 8);
  assert.ok(dataset.cases.some((item) => item.safety_critical));
});
