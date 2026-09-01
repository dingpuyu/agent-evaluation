#!/usr/bin/env -S npx tsx
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { DatasetSplit } from "../src/contracts.js";
import {
  evaluateDocumentQuality,
  loadDocumentQualityDataset,
  renderDocumentQualityMarkdown,
  type DocumentPipelineArtifact,
  DOCUMENT_FAILURE_LAYERS,
  type DocumentFailureLayer,
} from "../src/document-quality.js";

function argument(name: string, fallback = ""): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

async function main(): Promise<void> {
  const datasetPath = resolve(argument("--dataset", "datasets/raglab-document-quality-v1.json"));
  const artifactsPath = argument("--artifacts");
  if (!artifactsPath) throw new Error("--artifacts is required");
  const split = argument("--split", "all") as DatasetSplit | "all";
  if (!["development", "holdout", "regression", "all"].includes(split)) throw new Error(`invalid split: ${split}`);
  const layers = argument("--layers", DOCUMENT_FAILURE_LAYERS.join(",")).split(",").map((item) => item.trim()).filter(Boolean) as DocumentFailureLayer[];
  if (!layers.length || layers.some((layer) => !DOCUMENT_FAILURE_LAYERS.includes(layer))) throw new Error(`invalid layers: ${layers.join(",")}`);
  const jsonOutput = resolve(argument("--output-json", "data/document-quality/report-latest.json"));
  const markdownOutput = resolve(argument("--output-md", "data/document-quality/report-latest.md"));
  const dataset = await loadDocumentQualityDataset(datasetPath);
  const payload = JSON.parse(await readFile(resolve(artifactsPath), "utf8")) as {
    schema: string;
    artifacts: DocumentPipelineArtifact[];
  };
  if (payload.schema !== "agent-evaluation.document-quality.artifacts.v1" || !Array.isArray(payload.artifacts)) {
    throw new Error("unsupported document artifact bundle");
  }
  const report = evaluateDocumentQuality(dataset, payload.artifacts, split, layers);
  await atomicWrite(jsonOutput, `${JSON.stringify(report, null, 2)}\n`);
  await atomicWrite(markdownOutput, renderDocumentQualityMarkdown(report));
  console.log(JSON.stringify({
    status: report.gate_passed ? "passed" : "failed",
    split: report.split,
    evaluated_layers: report.evaluated_layers,
    cases: `${report.cases_passed}/${report.cases_total}`,
    json: jsonOutput,
    markdown: markdownOutput,
    failed_cases: report.failed_cases,
  }, null, 2));
  if (!report.gate_passed) process.exitCode = 2;
}

await main();
