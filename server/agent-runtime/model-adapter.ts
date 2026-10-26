import type { ModelAdapter, ModelCatalog, ModelGenerateRequest } from "./contracts.ts";

export interface OpenAICompatibleModelAdapterConfig {
  providerId: string;
  apiUrl: string;
  apiKey: string;
  defaultModel: string;
  supportsTools: boolean;
  supportsStreaming: boolean;
  contextWindow: number;
  imageInput: boolean;
}

export function createOpenAICompatibleModelAdapter(config: OpenAICompatibleModelAdapterConfig): ModelAdapter {
  return {
    providerId: config.providerId,

    async discoverModels(): Promise<ModelCatalog> {
      // In a real implementation, this would fetch from the provider's /models endpoint.
      // For now, return the configured default.
      return {
        default: config.defaultModel,
        options: [{ id: config.defaultModel, label: config.defaultModel, contextWindow: config.contextWindow }],
      };
    },

    capabilities(_modelId: string): import("./contracts.ts").ModelCapabilities {
      // Capabilities are per-model; in a real implementation, this would come from
      // a model catalog or a capability probe. Here we use the config defaults.
      return {
        tools: config.supportsTools,
        parallelTools: false,
        streaming: config.supportsStreaming,
        contextWindow: config.contextWindow,
        imageInput: config.imageInput,
        imageOutput: false,
        structuredOutput: false,
      };
    },

    async generate(_request: ModelGenerateRequest) {
      // This is a stub that would be replaced with actual HTTP calls to the provider.
      // The real implementation would use fetch to call /chat/completions.
      // For now, return a simple response.
      return {
        text: "Stub response from OpenAI-compatible adapter",
        toolCalls: [],
        finishReason: "stop",
        usage: { input: 0, output: 0 },
      };
    },
  };
}