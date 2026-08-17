import { createModels, createProvider, envApiKeyAuth, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

import type { EvaluationConfig } from "./config.js";

export function createEvaluatorModel(config: EvaluationConfig) {
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
