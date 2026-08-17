import { readFile } from "node:fs/promises";

import type { ProductionSampleCase } from "./contracts.js";

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
  cases: ProductionSampleCase[];
}

export async function loadDataset(path: string): Promise<EvaluationDataset> {
  const dataset = JSON.parse(await readFile(path, "utf8")) as EvaluationDataset;
  if (dataset.schema !== "agent-evaluation.dataset.v1") throw new Error("unsupported evaluation dataset schema");
  if (dataset.contains_patient_data) throw new Error("datasets containing patient data are not accepted by this local evaluator");
  if (!dataset.dataset_id || !Array.isArray(dataset.cases) || dataset.cases.length === 0) throw new Error("evaluation dataset is incomplete");
  const ids = new Set<string>();
  for (const item of dataset.cases) {
    if (!item.id || !item.query || !item.expected_decision) throw new Error("evaluation case is incomplete");
    if (ids.has(item.id)) throw new Error(`duplicate evaluation case id: ${item.id}`);
    ids.add(item.id);
  }
  return dataset;
}
