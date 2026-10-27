import type { ProviderDriver } from "../contracts.ts";
import { createOpenAIChatRuntime } from "./openai-chat.ts";
import { createNativeChatEngine } from "./native-engine.ts";
import { createResponsesModelAdapter } from "../agent-runtime/responses-adapter.ts";
import { probeCapabilities } from "../agent-runtime/capability-probe.ts";

const DRIVER_KIND = "openai-responses";
const DEFAULT_URL = "https://api.openai.com/v1";
const MODELS = {
  default: "gpt-4o",
  options: [
    { id: "gpt-4o", label: "GPT-4o", contextWindow: 128_000 },
    { id: "gpt-4o-mini", label: "GPT-4o mini", contextWindow: 128_000 },
    { id: "gpt-5", label: "GPT-5", contextWindow: 400_000 },
  ],
};

export interface OpenAIResponsesConfig {
  tools?: boolean;
  url: string;
  apiKeyEnv: string;
  maxOutputTokens?: number;
}

function decodeConfig(raw: unknown): OpenAIResponsesConfig {
  const config = (raw ?? {}) as Record<string, unknown>;
  if (config.tools !== undefined && typeof config.tools !== "boolean") throw new Error("tools must be a boolean");
  if (config.maxOutputTokens !== undefined && typeof config.maxOutputTokens !== "number") throw new Error("maxOutputTokens must be a number");
  return {
    ...(config.tools !== undefined ? { tools: config.tools as boolean } : {}),
    ...(config.maxOutputTokens !== undefined ? { maxOutputTokens: config.maxOutputTokens as number } : {}),
    url: typeof config.url === "string" ? config.url : DEFAULT_URL,
    apiKeyEnv: typeof config.apiKeyEnv === "string" ? config.apiKeyEnv : "OPENAI_API_KEY",
  };
}

export const OpenAIResponsesDriver: ProviderDriver<OpenAIResponsesConfig> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "OpenAI (Responses API)", supportsMultipleInstances: true },
  models: MODELS,
  decodeConfig,
  defaultConfig: () => decodeConfig({}),

  async create(input) {
    const { config } = input;
    const apiKey = input.environment[config.apiKeyEnv] ?? process.env[config.apiKeyEnv] ?? "";
    const modelAdapter = createResponsesModelAdapter({
      providerId: DRIVER_KIND,
      apiUrl: config.url,
      apiKey,
      catalog: () => MODELS,
      capabilities: (modelId) => probeCapabilities(modelId, () => MODELS, { toolsEnabled: config.tools !== false && String(config.tools) !== "false", imageInput: () => true }),
      maxOutputTokens: config.maxOutputTokens,
    });
    const nativeAgentEngine = createNativeChatEngine({
      providerId: DRIVER_KIND,
      apiUrl: config.url,
      apiKey,
      catalog: () => MODELS,
      toolsEnabled: config.tools !== false && String(config.tools) !== "false",
      imageInput: () => true,
      httpErrorLabel: "OpenAI",
      modelAdapter,
    });
    return createOpenAIChatRuntime({
      input,
      driverKind: DRIVER_KIND,
      nativeAgentEngine,
      modelAdapter,
      apiKey,
      apiUrl: config.url,
      tools: config.tools,
      models: () => MODELS,
      requestBody: (model, messages, stream) => ({ model, messages, stream }),
      httpErrorLabel: "OpenAI",
      missingKeyError: `Save an OpenAI API key in Settings → API keys, or set ${config.apiKeyEnv}.`,
      unavailableReason: "No OpenAI API key — open Settings → API keys.",
      timeoutMs: 120_000,
      generateModel: () => "gpt-4o-mini",
      nativeLog: {
        source: "openai.responses",
        outgoing: (_turn, messages, model) => ({ model, messageCount: messages.length }),
        incoming: ({ text, usage }) => ({ text, usage }),
      },
    });
  },
};

export { createResponsesModelAdapter, probeCapabilities };
