export interface EvaluationConfig {
  host: string;
  port: number;
  raglabAgentUrl: string;
  raglabApiUrl: string;
  modelApiKey: string;
  modelBaseUrl: string;
  model: string;
  maxTurns: number;
  maxToolCalls: number;
  timeoutMs: number;
  dataDir: string;
  datasetPath: string;
  corsOrigins: Set<string>;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): EvaluationConfig {
  return {
    host: env.AGENT_EVALUATION_HOST?.trim() || "0.0.0.0",
    port: positiveInt(env.AGENT_EVALUATION_INTERNAL_PORT || env.AGENT_EVALUATION_PORT, 8200),
    raglabAgentUrl: (env.RAGLAB_AGENT_URL || "http://127.0.0.1:8090").replace(/\/$/, ""),
    raglabApiUrl: (env.RAGLAB_API_URL || "http://127.0.0.1:18080").replace(/\/$/, ""),
    modelApiKey: (env.EVALUATION_MODEL_API_KEY || env.DEEPSEEK_API_KEY || env.RAGLAB_GENERATION_API_KEY || "").trim(),
    modelBaseUrl: (env.EVALUATION_MODEL_BASE_URL || env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/$/, ""),
    model: (env.EVALUATION_MODEL || env.DEEPSEEK_MODEL || "deepseek-chat").trim(),
    maxTurns: positiveInt(env.EVALUATION_MAX_TURNS, 6),
    maxToolCalls: positiveInt(env.EVALUATION_MAX_TOOL_CALLS, 8),
    timeoutMs: positiveInt(env.EVALUATION_TIMEOUT_MS, 90_000),
    dataDir: env.EVALUATION_DATA_DIR?.trim() || "./data",
    datasetPath: env.EVALUATION_DATASET_PATH?.trim() || "./datasets/raglab-medical-sales-production-sample-v2.json",
    corsOrigins: new Set((env.EVALUATION_CORS_ORIGINS || "http://localhost:18200,http://127.0.0.1:18200")
      .split(",").map((value) => value.trim()).filter(Boolean)),
  };
}
