import assert from "node:assert/strict";
import test from "node:test";

import { casesForSplit, loadDataset, publicDatasetView } from "../src/dataset.js";

test("loads the versioned production-shaped dataset without patient data", async () => {
  const dataset = await loadDataset("./datasets/raglab-medical-sales-production-sample-v2.json");
  assert.equal(dataset.schema, "agent-evaluation.dataset.v1");
  assert.equal(dataset.contains_patient_data, false);
  assert.equal(dataset.cases.length, 28);
  assert.equal(casesForSplit(dataset, "development").length, 10);
  assert.equal(casesForSplit(dataset, "holdout").length, 8);
  assert.equal(casesForSplit(dataset, "regression").length, 10);
  assert.match(dataset.snapshot_id ?? "", /^sha256:[a-f0-9]{64}$/);
  assert.ok(dataset.cases.some((item) => item.safety_critical));
  const publicView = publicDatasetView(dataset);
  const hidden = publicView.cases.filter((item) => "hidden" in item && item.hidden);
  assert.equal(hidden.length, 8);
  assert.ok(hidden.every((item) => item.query === "运行前隐藏，防止针对留出集调 Prompt"));
});
