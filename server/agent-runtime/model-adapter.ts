import type {
  ModelAdapter,
  ModelCapabilities,
  ModelCatalog,
  ModelEvent,
  ModelGenerateRequest,
} from "./contracts.ts";

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

function support(value: boolean): "supported" | "unsupported" {
  return value ? "supported" : "unsupported";
}

/**
 * Protocol placeholder for the OpenAI-compatible adapter. The real Chat
 * Completions transport arrives in the next milestone task; this class keeps
 * the contract honest and lets the Agent Runtime be tested without a network.
 */
export function createOpenAICompatibleModelAdapter(config: OpenAICompatibleModelAdapterConfig): ModelAdapter {
  return {
    providerId: config.providerId,

    async discoverModels(): Promise<ModelCatalog> {
      return {
        default: config.defaultModel,
        options: [{ id: config.defaultModel, label: config.defaultModel, contextWindow: config.contextWindow }],
      };
    },

    capabilities(_modelId: string): ModelCapabilities {
      return {
        tools: support(config.supportsTools),
        parallelTools: "unknown",
        streaming: support(config.supportsStreaming),
        contextWindow: { status: "known", value: config.contextWindow },
        imageInput: support(config.imageInput),
        imageOutput: "unsupported",
        audioInput: "unsupported",
        audioOutput: "unsupported",
        structuredOutput: "unsupported",
        toolSchemaLimit: { status: "unknown" },
      };
    },

    async *generate(request: ModelGenerateRequest): AsyncIterable<ModelEvent> {
      request.signal.throwIfAborted();
      yield { type: "content.delta", kind: "assistant_text", delta: "Stub response from OpenAI-compatible adapter" };
      request.signal.throwIfAborted();
      yield { type: "completed", finishReason: "stop" };
    },
  };
}
