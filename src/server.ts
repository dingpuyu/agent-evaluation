import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";

import { RaglabAdapter, UpstreamError } from "./adapters/raglab.js";
import { loadConfig } from "./config.js";
import type { Identity } from "./contracts.js";
import { loadDataset } from "./dataset.js";
import { runPromptExperiment } from "./experiment.js";
import { buildEvaluationPlan, comparePilotRuns, createPilotRun, executePilotRun, platformOverview, RAGLAB_TARGET } from "./platform.js";
import { evaluateRagBadCase, RAG_BAD_CASE_SUITE_ID, RAG_BAD_CASE_SUITE_VERSION } from "./runner.js";
import { continueProjectDiscovery, createProjectWorkspace, EVALUATION_STUDIO_STAGES, runStagePromptExperiment } from "./studio.js";
import { RunStore } from "./store.js";

const config = loadConfig();
const baseAdapter = new RaglabAdapter(config.raglabAgentUrl, config.raglabApiUrl);
const store = new RunStore(config.dataDir);
const activeSubjects = new Set<string>();
const activePilots = new Set<string>();
const activeWorkspaces = new Set<string>();
const activeStageExperiments = new Set<string>();
const publicDir = join(process.cwd(), "public");

function writeJSON(response: ServerResponse, status: number, value: unknown) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(value));
}

async function readJSON(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 64 * 1024) throw new UpstreamError(413, "request body is too large");
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>; }
  catch { throw new UpstreamError(400, "request body must be valid JSON"); }
}

function applyCors(request: IncomingMessage, response: ServerResponse): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  if (!config.corsOrigins.has(origin)) return false;
  response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Vary", "Origin");
  response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  return true;
}

function authorization(request: IncomingMessage): string {
  const value = request.headers.authorization?.trim() ?? "";
  if (!value.toLowerCase().startsWith("bearer ")) throw new UpstreamError(401, "a Bearer token is required");
  return value;
}

async function adminContext(request: IncomingMessage): Promise<{ identity: Identity; adapter: RaglabAdapter; authorization: string }> {
  const bearer = authorization(request);
  const adapter = baseAdapter.withAuthorization(bearer);
  const identity = await adapter.identity();
  if (!identity.roles.some((role) => role === "admin" || role === "platform_admin")) {
    throw new UpstreamError(403, "Agent evaluation requires an administrator");
  }
  return { identity, adapter, authorization: bearer };
}

async function serveStatic(pathname: string, response: ServerResponse): Promise<boolean> {
  const requested = pathname === "/" ? "index.html" : pathname === "/studio" ? "studio.html" : pathname.slice(1);
  if (!/^(index\.html|app\.js|styles\.css|comparison\.css|platform\.css|studio\.html|studio\.js|studio\.css)$/.test(requested)) return false;
  try {
    const body = await readFile(join(publicDir, requested));
    const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" }[extname(requested)] ?? "application/octet-stream";
    response.statusCode = 200;
    response.setHeader("Content-Type", mime);
    response.setHeader("Cache-Control", "no-cache");
    response.end(body);
    return true;
  } catch { return false; }
}

const server = createServer(async (request, response) => {
  if (!applyCors(request, response)) {
    writeJSON(response, 403, { error: { code: "origin_denied", message: "origin is not allowed" } });
    return;
  }
  if (request.method === "OPTIONS") { response.statusCode = 204; response.end(); return; }
  const url = new URL(request.url ?? "/", "http://localhost");
  try {
    if (request.method === "GET" && url.pathname === "/healthz") {
      writeJSON(response, 200, {
        status: "ok",
        version: "0.3.0",
        runtime: "pi-agent-core",
        model: config.model,
        model_configured: Boolean(config.modelApiKey),
        target: "rag-evolution-lab",
        mode: "external-agent-evaluation",
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/v1/catalog") {
      const dataset = await loadDataset(config.datasetPath);
      writeJSON(response, 200, {
        targets: [{ id: RAGLAB_TARGET.target_id, name: RAGLAB_TARGET.name, type: RAGLAB_TARGET.target_type, capabilities: RAGLAB_TARGET.capabilities }],
        suites: [
          { id: RAG_BAD_CASE_SUITE_ID, version: RAG_BAD_CASE_SUITE_VERSION, name: "RAG Bad Case Evidence Diagnosis", dimensions: ["task", "tool_use", "retrieval", "grounding", "safety", "observability", "performance"] },
          { id: "raglab.medical-sales.prompt-ab.v1", version: "1.0.0", name: "Medical Sales Agent Prompt A/B", dimensions: ["task", "grounding", "safety", "performance"] },
        ],
        datasets: [{ id: dataset.dataset_id, name: dataset.name, version: dataset.version, provenance: dataset.provenance, cases: dataset.cases.length }],
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/v1/session/login") {
      const body = await readJSON(request);
      const login = await baseAdapter.login(String(body.email ?? ""), String(body.password ?? ""));
      writeJSON(response, 200, login);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/v1/targets/raglab/contract") {
      const { adapter } = await adminContext(request);
      writeJSON(response, 200, await adapter.getEvaluationContract(url.searchParams.get("app_id") ?? ""));
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/v1/targets/raglab/bad-cases") {
      const { adapter } = await adminContext(request);
      const cases = await adapter.listBadCases();
      writeJSON(response, 200, { cases, total: cases.length });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/v1/datasets/production-sample") {
      await adminContext(request);
      writeJSON(response, 200, await loadDataset(config.datasetPath));
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/v1/platform/overview") {
      const { identity, adapter } = await adminContext(request);
      const dataset = await loadDataset(config.datasetPath);
      const plan = buildEvaluationPlan(await adapter.getEvaluationContract(), dataset);
      writeJSON(response, 200, platformOverview({ plans: [plan], pilotRuns: await store.listPilots(identity) }));
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/v1/studio/stages") {
      await adminContext(request);
      writeJSON(response, 200, { stages: EVALUATION_STUDIO_STAGES });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/v1/project-workspaces") {
      const { identity } = await adminContext(request);
      writeJSON(response, 200, { workspaces: await store.listWorkspaces(identity) });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/v1/project-workspaces") {
      const { identity, adapter } = await adminContext(request);
      const body = await readJSON(request);
      const name = String(body.name ?? "").trim();
      if (!name || name.length > 120) throw new UpstreamError(400, "project name must contain 1 to 120 characters");
      const dataset = await loadDataset(config.datasetPath);
      const plan = buildEvaluationPlan(await adapter.getEvaluationContract(String(body.app_id ?? "")), dataset);
      const workspace = createProjectWorkspace(identity, plan, name);
      await store.saveWorkspace(workspace);
      writeJSON(response, 201, workspace);
      return;
    }
    const workspaceMatch = url.pathname.match(/^\/api\/v1\/project-workspaces\/(workspace_[a-f0-9]{32})$/);
    if (request.method === "GET" && workspaceMatch?.[1]) {
      const { identity } = await adminContext(request);
      const workspace = await store.getWorkspace(workspaceMatch[1], identity);
      if (!workspace) throw new UpstreamError(404, "project workspace was not found or is not accessible");
      writeJSON(response, 200, workspace);
      return;
    }
    const messageMatch = url.pathname.match(/^\/api\/v1\/project-workspaces\/(workspace_[a-f0-9]{32})\/messages$/);
    if (request.method === "POST" && messageMatch?.[1]) {
      const { identity, adapter } = await adminContext(request);
      const workspace = await store.getWorkspace(messageMatch[1], identity);
      if (!workspace) throw new UpstreamError(404, "project workspace was not found or is not accessible");
      if (activeWorkspaces.has(workspace.workspace_id)) throw new UpstreamError(409, "this project workspace is already processing a message");
      const body = await readJSON(request);
      const message = String(body.message ?? "").trim();
      if (!message || message.length > 4000) throw new UpstreamError(400, "message must contain 1 to 4000 characters");
      activeWorkspaces.add(workspace.workspace_id);
      try {
        const dataset = await loadDataset(config.datasetPath);
        const updated = await continueProjectDiscovery({
          config,
          adapter,
          workspace,
          contract: await adapter.getEvaluationContract(),
          dataset,
          pilots: await store.listPilots(identity, 5),
          userMessage: message,
        });
        await store.saveWorkspace(updated);
        writeJSON(response, 200, updated);
      } finally { activeWorkspaces.delete(workspace.workspace_id); }
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/v1/stage-experiments") {
      const { identity } = await adminContext(request);
      writeJSON(response, 200, { experiments: await store.listStageExperiments(identity, url.searchParams.get("workspace_id") ?? "") });
      return;
    }
    const stageExperimentMatch = url.pathname.match(/^\/api\/v1\/project-workspaces\/(workspace_[a-f0-9]{32})\/stage-experiments$/);
    if (request.method === "POST" && stageExperimentMatch?.[1]) {
      const { identity, adapter } = await adminContext(request);
      const workspace = await store.getWorkspace(stageExperimentMatch[1], identity);
      if (!workspace) throw new UpstreamError(404, "project workspace was not found or is not accessible");
      const body = await readJSON(request);
      const stageID = String(body.stage_id ?? "").trim();
      const candidatePrompt = String(body.candidate_prompt ?? "").trim();
      const stage = EVALUATION_STUDIO_STAGES.find((item) => item.stage_id === stageID);
      if (!stage) throw new UpstreamError(400, "evaluation stage was not found");
      if (!stage.prompt_editable) throw new UpstreamError(400, "deterministic and runtime stages do not accept prompt overrides");
      if (!candidatePrompt || candidatePrompt.length > 5000) throw new UpstreamError(400, "candidate_prompt must contain 1 to 5000 characters");
      const activeKey = `${workspace.workspace_id}:${stageID}`;
      if (activeStageExperiments.has(activeKey)) throw new UpstreamError(409, "this stage experiment is already running");
      activeStageExperiments.add(activeKey);
      try {
        const dataset = await loadDataset(config.datasetPath);
        const contract = await adapter.getEvaluationContract(String(body.app_id ?? ""));
        const plan = buildEvaluationPlan(contract, dataset);
        const experiment = await runStagePromptExperiment({
          config,
          adapter,
          identity,
          workspace,
          dataset,
          appID: plan.app_id,
          environmentID: plan.environment_id,
          stageID,
          candidatePrompt,
          caseLimit: Number(body.case_limit ?? 4),
        });
        await store.saveStageExperiment(experiment);
        writeJSON(response, 200, experiment);
      } finally { activeStageExperiments.delete(activeKey); }
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/v1/plans/raglab-medical-sales-baseline-v1") {
      const { adapter } = await adminContext(request);
      const dataset = await loadDataset(config.datasetPath);
      writeJSON(response, 200, buildEvaluationPlan(await adapter.getEvaluationContract(), dataset));
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/v1/pilots") {
      const { identity } = await adminContext(request);
      writeJSON(response, 200, { runs: await store.listPilots(identity, Number.parseInt(url.searchParams.get("limit") ?? "20", 10)) });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/v1/pilots/compare") {
      const { identity } = await adminContext(request);
      const baselineID = url.searchParams.get("baseline_id") ?? "";
      const candidateID = url.searchParams.get("candidate_id") ?? "";
      const baseline = await store.getPilot(baselineID, identity);
      const candidate = await store.getPilot(candidateID, identity);
      if (!baseline || !candidate) throw new UpstreamError(404, "one or both pilot runs are not accessible");
      try { writeJSON(response, 200, comparePilotRuns(baseline, candidate)); }
      catch (error) { throw new UpstreamError(409, error instanceof Error ? error.message : "pilot runs are not comparable"); }
      return;
    }
    const pilotMatch = url.pathname.match(/^\/api\/v1\/pilots\/(pilot_[a-f0-9]{32})$/);
    if (request.method === "GET" && pilotMatch?.[1]) {
      const { identity } = await adminContext(request);
      const run = await store.getPilot(pilotMatch[1], identity);
      if (!run) throw new UpstreamError(404, "pilot run was not found or is not accessible");
      writeJSON(response, 200, run);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/v1/pilots/raglab-medical-sales-baseline-v1/runs") {
      const { identity, adapter } = await adminContext(request);
      const activeKey = `${identity.tenant_id}:raglab-medical-sales-baseline-v1`;
      if (activePilots.has(activeKey)) throw new UpstreamError(409, "this tenant pilot is already running");
      const dataset = await loadDataset(config.datasetPath);
      const plan = buildEvaluationPlan(await adapter.getEvaluationContract(), dataset);
      const run = createPilotRun(plan, identity);
      await store.savePilot(run);
      activePilots.add(activeKey);
      void executePilotRun({ run, plan, dataset, adapter, onProgress: (progress) => store.savePilot(progress) })
        .catch(async (error) => {
          run.status = "failed";
          run.error = error instanceof Error ? error.message.slice(0, 1200) : "pilot evaluation failed";
          run.completed_at = new Date().toISOString();
          await store.savePilot(run);
        })
        .finally(() => activePilots.delete(activeKey));
      writeJSON(response, 202, run);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/v1/evaluations/runs") {
      const { identity } = await adminContext(request);
      writeJSON(response, 200, { runs: await store.list(identity, Number.parseInt(url.searchParams.get("limit") ?? "30", 10)) });
      return;
    }
    const runMatch = url.pathname.match(/^\/api\/v1\/evaluations\/runs\/(eval_[a-f0-9]{32})$/);
    if (request.method === "GET" && runMatch?.[1]) {
      const { identity } = await adminContext(request);
      const run = await store.get(runMatch[1], identity);
      if (!run) throw new UpstreamError(404, "evaluation run was not found or is not accessible");
      writeJSON(response, 200, run);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/v1/evaluations/runs") {
      const { identity, adapter } = await adminContext(request);
      const body = await readJSON(request);
      const suiteID = String(body.suite_id ?? RAG_BAD_CASE_SUITE_ID);
      const subject = (body.subject ?? {}) as Record<string, unknown>;
      const badCaseID = String(subject.bad_case_id ?? body.bad_case_id ?? "");
      if (suiteID !== RAG_BAD_CASE_SUITE_ID) throw new UpstreamError(400, "unsupported evaluation suite");
      if (!/^[A-Za-z0-9_-]{1,160}$/.test(badCaseID)) throw new UpstreamError(400, "a valid bad_case_id is required");
      if (activeSubjects.has(badCaseID)) throw new UpstreamError(409, "this evaluation subject is already running");
      activeSubjects.add(badCaseID);
      try {
        const run = await evaluateRagBadCase(config, adapter, identity, badCaseID);
        await store.save(run);
        writeJSON(response, 200, run);
      } finally { activeSubjects.delete(badCaseID); }
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/v1/experiments/prompt-comparisons") {
      const { identity } = await adminContext(request);
      writeJSON(response, 200, { experiments: await store.listExperiments(identity) });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/v1/experiments/prompt-comparisons") {
      const { identity, adapter } = await adminContext(request);
      const body = await readJSON(request);
      const promptOverlay = String(body.prompt_overlay ?? "").trim();
      if (!promptOverlay || promptOverlay.length > 5000) throw new UpstreamError(400, "prompt_overlay must contain 1 to 5000 characters");
      const appID = String(body.app_id ?? `${identity.tenant_id}-medical-device-customer-agent`);
      const environmentID = String(body.environment_id ?? `${appID}-dev`);
      // Contract lookup authorizes the selected app before the comparison can incur model cost.
      await adapter.getEvaluationContract(appID);
      const experiment = await runPromptExperiment({
        adapter,
        identity,
        dataset: await loadDataset(config.datasetPath),
        appID,
        environmentID,
        promptOverlay,
        caseLimit: Number(body.case_limit ?? 4),
      });
      await store.saveExperiment(experiment);
      writeJSON(response, 200, experiment);
      return;
    }
    if (request.method === "GET" && await serveStatic(url.pathname, response)) return;
    writeJSON(response, 404, { error: { code: "not_found", message: "route not found" } });
  } catch (error) {
    const status = error instanceof UpstreamError ? error.status : error instanceof Error && error.message.includes("not configured") ? 503 : 502;
    const message = error instanceof Error ? error.message : "Agent evaluation request failed";
    writeJSON(response, status, { error: { code: "agent_evaluation_failed", message: message.slice(0, 1200) } });
  }
});

server.listen(config.port, config.host, () => {
  console.log(JSON.stringify({ event: "agent_evaluation_started", host: config.host, port: config.port, model: config.model, model_configured: Boolean(config.modelApiKey) }));
});
