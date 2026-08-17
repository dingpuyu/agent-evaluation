import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { EvaluationRun, Identity, PromptExperiment } from "./contracts.js";

export class RunStore {
  private readonly runsDir: string;
  private readonly experimentsDir: string;

  constructor(dataDir: string) {
    this.runsDir = join(dataDir, "runs");
    this.experimentsDir = join(dataDir, "experiments");
  }

  private path(runID: string): string {
    if (!/^eval_[a-f0-9]{32}$/.test(runID)) throw new Error("invalid evaluation run id");
    return join(this.runsDir, `${runID}.json`);
  }

  async save(run: EvaluationRun): Promise<void> {
    await mkdir(this.runsDir, { recursive: true });
    const target = this.path(run.run_id);
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(run, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, target);
  }

  private canRead(run: EvaluationRun, identity: Identity): boolean {
    return identity.roles.includes("platform_admin") || run.tenant_id === identity.tenant_id;
  }

  async get(runID: string, identity: Identity): Promise<EvaluationRun | undefined> {
    try {
      const run = JSON.parse(await readFile(this.path(runID), "utf8")) as EvaluationRun;
      return this.canRead(run, identity) ? run : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async list(identity: Identity, limit = 30): Promise<EvaluationRun[]> {
    await mkdir(this.runsDir, { recursive: true });
    const entries = (await readdir(this.runsDir)).filter((name) => /^eval_[a-f0-9]{32}\.json$/.test(name));
    const runs = await Promise.all(entries.map(async (name) => JSON.parse(await readFile(join(this.runsDir, name), "utf8")) as EvaluationRun));
    return runs.filter((run) => this.canRead(run, identity))
      .sort((left, right) => right.started_at.localeCompare(left.started_at))
      .slice(0, Math.max(1, Math.min(limit, 100)));
  }

  private experimentPath(experimentID: string): string {
    if (!/^experiment_[a-f0-9]{32}$/.test(experimentID)) throw new Error("invalid prompt experiment id");
    return join(this.experimentsDir, `${experimentID}.json`);
  }

  async saveExperiment(experiment: PromptExperiment): Promise<void> {
    await mkdir(this.experimentsDir, { recursive: true });
    const target = this.experimentPath(experiment.experiment_id);
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(experiment, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, target);
  }

  async listExperiments(identity: Identity, limit = 20): Promise<PromptExperiment[]> {
    await mkdir(this.experimentsDir, { recursive: true });
    const entries = (await readdir(this.experimentsDir)).filter((name) => /^experiment_[a-f0-9]{32}\.json$/.test(name));
    const experiments = await Promise.all(entries.map(async (name) => JSON.parse(await readFile(join(this.experimentsDir, name), "utf8")) as PromptExperiment));
    return experiments.filter((item) => identity.roles.includes("platform_admin") || item.tenant_id === identity.tenant_id)
      .sort((left, right) => right.started_at.localeCompare(left.started_at))
      .slice(0, Math.max(1, Math.min(limit, 100)));
  }
}
