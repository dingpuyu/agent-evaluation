#!/usr/bin/env -S npx tsx
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  compareDocumentQualityReports,
  renderDocumentQualityComparisonMarkdown,
  type DocumentQualityReport,
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
  const baselinePath = argument("--baseline");
  const candidatePath = argument("--candidate");
  if (!baselinePath || !candidatePath) throw new Error("--baseline and --candidate reports are required");
  const baseline = JSON.parse(await readFile(resolve(baselinePath), "utf8")) as DocumentQualityReport;
  const candidate = JSON.parse(await readFile(resolve(candidatePath), "utf8")) as DocumentQualityReport;
  const comparison = compareDocumentQualityReports(baseline, candidate);
  const jsonOutput = resolve(argument("--output-json", "data/document-quality/comparison-latest.json"));
  const markdownOutput = resolve(argument("--output-md", "data/document-quality/comparison-latest.md"));
  await atomicWrite(jsonOutput, `${JSON.stringify(comparison, null, 2)}\n`);
  await atomicWrite(markdownOutput, renderDocumentQualityComparisonMarkdown(comparison));
  console.log(JSON.stringify({
    decision: comparison.promotable ? "promote" : "hold",
    fixed_cases: comparison.fixed_cases,
    regressed_cases: comparison.regressed_cases,
    regressed_metrics: comparison.regressed_metrics,
    json: jsonOutput,
    markdown: markdownOutput,
  }, null, 2));
  if (!comparison.promotable) process.exitCode = 2;
}

await main();
