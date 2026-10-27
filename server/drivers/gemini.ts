import type { ProviderDriver } from "../contracts.ts";
import { createOpenAIChatRuntime } from "./openai-chat.ts";
import { createNativeChatEngine } from "./native-engine.ts";
import { createGeminiModelAdapter } from "../agent-runtime/gemini-adapter.ts";
import { probeCapabilities } from "../agent-runtime/capability-probe.ts";

const DRIVER_KIND = "gemini";
const DEFAULT_URL = "https://generativelanguage.googleapis.com/v1beta";
const MODELS = {
  default: "gemini-2.0-flash",
  options: [
    { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash", contextWindow: 1_000_000 },
    { id: "gemini-1.5-pro", label: "Gemini 1.5 Pro", contextWindow: 2_000_000 },
    { id: "gemini-1.5-flash", label: "Gemini 1.5 Flash", contextWindow: 1_000_000 },
  ],
};

export interface GeminiConfig {
  tools?: boolean;
  url: string;
  apiKeyEnv: string;
  maxOutputTokens?: number;
}

function decodeConfig(raw: unknown): GeminiConfig {
  const config = (raw ?? {}) as Record<string, unknown>;
  if (config.tools !== undefined && typeof config.tools !== "boolean") throw new Error("tools must be a boolean");
  if (config.maxOutputTokens !== undefined && typeof config.maxOutputTokens !== "number") throw new Error("maxOutputTokens must be a number");
  return {
    ...(config.tools !== undefined ? { tools: config.tools as boolean } : {}),
    ...(config.maxOutputTokens !== undefined ? { maxOutputTokens: config.maxOutputTokens as number } : {}),
    url: typeof config.url === "string" ? config.url : DEFAULT_URL,
    apiKeyEnv: typeof config.apiKeyEnv === "string" ? config.apiKeyEnv : "GEMINI_API_KEY",
  };
}

export const GeminiDriver: ProviderDriver<GeminiConfig> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Gemini (API)", supportsMultipleInstances: true },
  models: MODELS,
  decodeConfig,
  defaultConfig: () => decodeConfig({}),

  async create(input) {
    const { config } = input;
    const apiKey = input.environment[config.apiKeyEnv] ?? process.env[config.apiKeyEnv] ?? "";
    const modelAdapter = createGeminiModelAdapter({
      providerId: DRIVER_KIND,
      apiUrl: config.url,
      apiKey,
      catalog: () => MODELS,
      capabilities: (modelId) => probeCapabilities(modelId, () => MODELS, { toolsEnabled: config.tools !== false, imageInput: () => true }),
      maxOutputTokens: config.maxOutputTokens,
    });
    const nativeAgentEngine = createNativeChatEngine({
      providerId: DRIVER_KIND,
      apiUrl: config.url,
      apiKey,
      catalog: () => MODELS,
      toolsEnabled: config.tools !== false,
      imageInput: () => true,
      modelAdapter,
    });
    return createOpenAIChatRuntime({
      input,
      driverKind: DRIVER_KIND,
      nativeAgentEngine,
      apiKey,
      apiUrl: config.url,
      tools: config.tools,
      models: () => MODELS,
      requestBody: (model, messages, stream) => ({ model, messages, stream }),
      httpErrorLabel: "Gemini",
      missingKeyError: `Save a Gemini API key in Settings → API keys, or set ${config.apiKeyEnv}.`,
      unavailableReason: "No Gemini API key — open Settings → API keys.",
      timeoutMs: 120_000,
      generateModel: () => "gemini-1.5-flash",
      nativeLog: {
        source: "gemini.generateContent",
        outgoing: (_turn, messages, model) => ({ model, messageCount: messages.length }),
        incoming: ({ text, usage }) => ({ text, usage }),
      },
    });
  },
};

export { createGeminiModelAdapter, probeCapabilities };
