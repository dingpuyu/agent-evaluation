import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { DatasetSplit, ProductionSampleCase } from "./contracts.js";

export interface DatasetSplitPolicy {
  purpose: string;
  prompt_visible: boolean;
  case_count: number;
}

export interface EvaluationDataset {
  schema: "agent-evaluation.dataset.v1";
  dataset_id: string;
  name: string;
  version: string;
  domain: string;
  language: string;
  provenance: string;
  contains_patient_data: boolean;
  description: string;
  frozen_at?: string;
  snapshot_id?: string;
  selected_split?: DatasetSplit;
  split_policy: Record<DatasetSplit, DatasetSplitPolicy>;
  cases: ProductionSampleCase[];
}

export const DATASET_SPLITS: DatasetSplit[] = ["development", "holdout", "regression"];

export function casesForSplit(dataset: EvaluationDataset, split: DatasetSplit): ProductionSampleCase[] {
  return dataset.cases.filter((item) => item.split === split);
}

export function datasetForSplit(dataset: EvaluationDataset, split: DatasetSplit): EvaluationDataset {
  return { ...dataset, selected_split: split, cases: casesForSplit(dataset, split) };
}

export function datasetSplitSummary(dataset: EvaluationDataset) {
  return Object.fromEntries(DATASET_SPLITS.map((split) => [split, {
    ...dataset.split_policy[split],
    actual_case_count: casesForSplit(dataset, split).length,
  }])) as Record<DatasetSplit, DatasetSplitPolicy & { actual_case_count: number }>;
}

export function publicDatasetView(dataset: EvaluationDataset) {
  let hiddenIndex = 0;
  return {
    ...dataset,
    split_summary: datasetSplitSummary(dataset),
    cases: dataset.cases.map((item) => item.split === "holdout" ? {
      id: `holdout-hidden-${String(++hiddenIndex).padStart(2, "0")}`,
      split: item.split,
      segment: "blind_holdout",
      hidden: true,
      query: "运行前隐藏，防止针对留出集调 Prompt",
      expected_decision: "hidden",
      safety_critical: Boolean(item.safety_critical),
    } : item),
  };
}

export async function loadDataset(path: string): Promise<EvaluationDataset> {
  const source = await readFile(path, "utf8");
  const dataset = JSON.parse(source) as EvaluationDataset;
  if (dataset.schema !== "agent-evaluation.dataset.v1") throw new Error("unsupported evaluation dataset schema");
  if (dataset.contains_patient_data) throw new Error("datasets containing patient data are not accepted by this local evaluator");
  if (!dataset.dataset_id || !Array.isArray(dataset.cases) || dataset.cases.length === 0) throw new Error("evaluation dataset is incomplete");
  const legacyDataset = !dataset.split_policy;
  if (legacyDataset) {
    for (const item of dataset.cases) item.split = "development";
    dataset.split_policy = {
      development: { purpose: "Legacy dataset compatibility", prompt_visible: true, case_count: dataset.cases.length },
      holdout: { purpose: "Not configured in legacy dataset", prompt_visible: false, case_count: 0 },
      regression: { purpose: "Not configured in legacy dataset", prompt_visible: true, case_count: 0 },
    };
  }
  const ids = new Set<string>();
  for (const item of dataset.cases) {
    if (!item.id || !item.query || !item.expected_decision) throw new Error("evaluation case is incomplete");
    if (!DATASET_SPLITS.includes(item.split)) throw new Error(`evaluation case has invalid split: ${item.id}`);
    if (ids.has(item.id)) throw new Error(`duplicate evaluation case id: ${item.id}`);
    ids.add(item.id);
  }
  for (const split of DATASET_SPLITS) {
    const actual = casesForSplit(dataset, split).length;
    if (!legacyDataset && actual === 0) throw new Error(`evaluation dataset split is empty: ${split}`);
    if (dataset.split_policy[split]?.case_count !== actual) throw new Error(`evaluation dataset split count mismatch: ${split}`);
  }
  dataset.snapshot_id = `sha256:${createHash("sha256").update(source).digest("hex")}`;
  return dataset;
}
