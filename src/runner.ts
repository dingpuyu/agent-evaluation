import { randomUUID } from "node:crypto";
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { createModels, createProvider, envApiKeyAuth, Type, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

import { RaglabAdapter, UpstreamError } from "./adapters/raglab.js";
import type { EvaluationConfig } from "./config.js";
import { ROOT_CAUSES, type BadCase, type DiagnosisReport, type EvaluationEvent, type EvaluationRun, type Identity, type ReplayResult } from "./contracts.js";
import { buildRunMetrics } from "./metrics.js";
import { ToolPolicy } from "./policy.js";

export const RAG_BAD_CASE_SUITE_ID = "raglab.medical.bad-case.v1";
export const RAG_BAD_CASE_SUITE_VERSION = "1.0.0";

interface RunContext {
  badCase: BadCase;
  replay?: ReplayResult;
  report?: DiagnosisReport;
}

function jsonResult(value: unknown, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details };
}

function createModel(config: EvaluationConfig) {
  const model: Model<"openai-completions"> = {
    id: config.model,
    name: config.model,
    api: "openai-completions",
    provider: "agent-evaluation-openai-compatible",
    baseUrl: config.modelBaseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 64_000,
    maxTokens: 4_096,
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsStrictMode: false,
      maxTokensField: "max_tokens",
    },
  };
  const provider = createProvider({
    id: "agent-evaluation-openai-compatible",
    name: "Agent Evaluation OpenAI-compatible Provider",
    baseUrl: config.modelBaseUrl,
    auth: { apiKey: envApiKeyAuth("Agent evaluator model API key", ["EVALUATION_MODEL_API_KEY", "DEEPSEEK_API_KEY", "RAGLAB_GENERATION_API_KEY"]) },
    models: [model],
    api: openAICompletionsApi(),
  });
  const models = createModels();
  models.setProvider(provider);
  return { model, models };
}

function createTools(adapter: RaglabAdapter, badCaseID: string, run: RunContext): AgentTool[] {
  return [
    {
      name: "get_bad_case",
      label: "Read evaluation subject",
      description: "Read the tenant-authorized Bad Case, human expectation, original output and lifecycle state. The subject ID is fixed by the harness.",
      parameters: Type.Object({}),
      executionMode: "sequential",
      execute: async () => jsonResult(run.badCase, { bad_case_id: badCaseID }),
    },
    {
      name: "get_bad_case_attempts",
      label: "Read historical attempts",
      description: "Read up to five recent human-triggered verification attempts for the fixed Bad Case.",
      parameters: Type.Object({}),
      executionMode: "sequential",
      execute: async () => jsonResult(await adapter.getAttempts(badCaseID), { bad_case_id: badCaseID }),
    },
    {
      name: "replay_bad_case",
      label: "Replay system under test",
      description: "Run one read-only retrieval replay with the fixed app, environment, query and device context. It creates an audit Trace but cannot change documents, indexes, permissions or release state.",
      parameters: Type.Object({}),
      executionMode: "sequential",
      execute: async () => {
        run.replay = await adapter.replay(run.badCase);
        return jsonResult(run.replay, { trace_id: run.replay.trace_id, metrics: run.replay.metrics });
      },
    },
    {
      name: "get_replay_trace",
      label: "Read replay trace",
      description: "Read only the Trace created by replay_bad_case. Arbitrary Trace IDs cannot be supplied or enumerated.",
      parameters: Type.Object({}),
      executionMode: "sequential",
      execute: async () => {
        if (!run.replay) throw new Error("replay_bad_case must run before get_replay_trace");
        return jsonResult(await adapter.getTrace(run.badCase, run.replay.trace_id), { trace_id: run.replay.trace_id });
      },
    },
    {
      name: "finish_diagnosis",
      label: "Submit model-assisted diagnosis",
      description: "Submit a structured evidence-backed diagnosis for human review. This does not mutate the system under test.",
      parameters: Type.Object({
        summary: Type.String({ minLength: 10, maxLength: 1200 }),
        root_cause: Type.Union(ROOT_CAUSES.map((value) => Type.Literal(value))),
        confidence: Type.Number({ minimum: 0, maximum: 1 }),
        evidence: Type.Array(Type.Object({
          observation: Type.String({ minLength: 3, maxLength: 800 }),
          supports: Type.String({ minLength: 3, maxLength: 160 }),
        }), { minItems: 1, maxItems: 10 }),
        recommendations: Type.Array(Type.Object({
          action: Type.String({ minLength: 3, maxLength: 800 }),
          layer: Type.Union(["corpus", "metadata", "retrieval", "rerank", "agent", "evaluation", "operations"].map((value) => Type.Literal(value))),
          expected_impact: Type.String({ minLength: 3, maxLength: 400 }),
          risk: Type.String({ minLength: 2, maxLength: 400 }),
        }), { minItems: 1, maxItems: 8 }),
        validation: Type.Object({
          executed: Type.Boolean(),
          passed: Type.Boolean(),
          trace_id: Type.String({ maxLength: 160 }),
          hit_at_5: Type.Number({ minimum: 0, maximum: 1 }),
          mrr: Type.Number({ minimum: 0, maximum: 1 }),
          notes: Type.String({ maxLength: 800 }),
        }),
        requires_human_review: Type.Literal(true),
      }),
      executionMode: "sequential",
      execute: async (_toolCallID, params) => {
        run.report = params as DiagnosisReport;
        return { ...jsonResult({ accepted: true, message: "diagnosis captured for human review" }, { report: run.report }), terminate: true };
      },
    },
  ];
}

function fallbackReport(run: RunContext, assistantText: string): DiagnosisReport {
  const metrics = run.replay?.metrics;
  return {
    summary: assistantText.trim() || "Evaluator did not submit the required structured report; inspect the event timeline before retrying.",
    root_cause: "other",
    confidence: 0,
    evidence: [{ observation: "finish_diagnosis was not completed", supports: "incomplete_evaluator_run" }],
    recommendations: [{ action: "Inspect model tool-calling compatibility and retry the evaluation", layer: "operations", expected_impact: "Restore structured evaluation output", risk: "Do not change the target system based on this incomplete result" }],
    validation: {
      executed: Boolean(run.replay),
      passed: metrics?.hit_at_5 === 1,
      trace_id: run.replay?.trace_id ?? "",
      hit_at_5: metrics?.hit_at_5 ?? 0,
      mrr: metrics?.mrr ?? 0,
      notes: "Structured model-assisted diagnosis did not complete",
    },
    requires_human_review: true,
  };
}

export async function evaluateRagBadCase(
  config: EvaluationConfig,
  adapter: RaglabAdapter,
  identity: Identity,
  badCaseID: string,
): Promise<EvaluationRun> {
  if (!config.modelApiKey) throw new Error("evaluation model API key is not configured");
  const startedAt = new Date();
  const started = performance.now();
  const runID = `eval_${randomUUID().replaceAll("-", "")}`;
  // Resource authorization happens before any model tokens are spent.
  const badCase = await adapter.getBadCase(badCaseID);
  if (badCase.layer !== "rag") throw new UpstreamError(409, "the first suite supports retrieval-layer Bad Cases only");
  if (badCase.tenant_id && !identity.roles.includes("platform_admin") && badCase.tenant_id !== identity.tenant_id) {
    throw new UpstreamError(404, "evaluation subject was not found or is not accessible");
  }

  const run: RunContext = { badCase };
  const policy = new ToolPolicy(config.maxToolCalls);
  const toolCalls: string[] = [];
  const events: EvaluationEvent[] = [];
  let turnCount = 0;
  let assistantText = "";
  const { model, models } = createModel(config);
  const agent = new Agent({
    initialState: {
      systemPrompt: `You are an Agent Evaluation Engineer. Diagnose one fixed evaluation subject using only auditable evidence from the registered tools. You evaluate the target system; you do not answer the user's original medical question.

Required sequence: get_bad_case, get_bad_case_attempts, replay_bad_case once, get_replay_trace, finish_diagnosis.

Safety rules: never bypass tenant or dataset filters; never claim you changed configuration; never publish an index; never treat a similarity score as business truth; requires_human_review must be true. Separate the historical root cause from the current replay state. Regression assets must be retained even after the target system is fixed. Recommendations are experiment hypotheses, not production actions.`,
      model,
      tools: createTools(adapter, badCaseID, run),
      messages: [],
    },
    streamFn: (selectedModel, context, options) => models.streamSimple(selectedModel, context, { ...options, apiKey: config.modelApiKey }),
    toolExecution: "sequential",
    beforeToolCall: async ({ toolCall }) => {
      const decision = policy.authorize(toolCall.name);
      if (!decision.allowed) return { block: true, reason: decision.reason, terminate: decision.terminate };
      toolCalls.push(toolCall.name);
      return undefined;
    },
    shouldStopAfterTurn: async () => turnCount >= config.maxTurns || Boolean(run.report),
  });

  agent.subscribe((event) => {
    if (event.type === "turn_start") turnCount += 1;
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") assistantText += event.assistantMessageEvent.delta;
    if (event.type === "tool_execution_start") {
      events.push({ sequence: events.length + 1, type: event.type, name: event.toolName, status: "running", timestamp: new Date().toISOString() });
    } else if (event.type === "tool_execution_end") {
      events.push({ sequence: events.length + 1, type: event.type, name: event.toolName, status: event.isError ? "error" : "completed", timestamp: new Date().toISOString() });
    } else if (["agent_start", "turn_start", "turn_end", "agent_end"].includes(event.type)) {
      events.push({ sequence: events.length + 1, type: event.type, timestamp: new Date().toISOString() });
    }
  });

  const timer = setTimeout(() => agent.abort(), config.timeoutMs);
  try {
    await agent.prompt(`Evaluate Bad Case ${badCaseID}. Collect tool evidence, perform exactly one current replay, and submit a structured diagnosis.`);
  } finally {
    clearTimeout(timer);
  }
  const durationMs = Math.round(performance.now() - started);
  const report = run.report ?? fallbackReport(run, assistantText);
  const completed = Boolean(run.report);
  return {
    run_id: runID,
    suite_id: RAG_BAD_CASE_SUITE_ID,
    suite_version: RAG_BAD_CASE_SUITE_VERSION,
    target_id: "rag-evolution-lab",
    subject_id: badCaseID,
    tenant_id: identity.tenant_id,
    requested_by: identity.subject,
    status: completed ? "completed" : "incomplete",
    started_at: startedAt.toISOString(),
    completed_at: new Date().toISOString(),
    model: config.model,
    duration_ms: durationMs,
    tool_calls: toolCalls,
    metrics: buildRunMetrics({ badCase, replay: run.replay, report, toolCalls, durationMs, completed }),
    report,
    events,
  };
}
