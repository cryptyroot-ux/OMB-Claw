import type { ModelCatalog } from "../contracts.ts";
import type { AgentEngine, ModelCapabilities } from "../agent-runtime/contracts.ts";
import { createAgentEngine } from "../agent-runtime/runtime.ts";
import { createOpenAICompatibleModelAdapter } from "../agent-runtime/model-adapter.ts";
import { createSqliteAgentRunStore } from "../agent-runtime/run-store.ts";

/** Chat-completions drivers share one native engine shape: an OpenAI-compatible adapter over the same catalog the
 * driver shows in Settings, and the OMB-owned run journal. Provider quirks stay in the adapter options, never in the
 * loop. */
export interface NativeChatEngineOptions {
  readonly providerId: string;
  readonly apiUrl: string;
  readonly apiKey: string;
  readonly catalog: () => ModelCatalog;
  readonly reasoning?: boolean;
  /** `config.tools === false` keeps tools unmounted; the model must not then be told it can call them. */
  readonly toolsEnabled?: boolean;
  readonly imageInput?: (modelId: string) => boolean;
  readonly audioInput?: (modelId: string) => boolean;
}

export function createNativeChatEngine(options: NativeChatEngineOptions): AgentEngine {
  const adapter = createOpenAICompatibleModelAdapter({
    providerId: options.providerId,
    apiUrl: options.apiUrl,
    apiKey: options.apiKey,
    catalog: options.catalog,
    reasoning: options.reasoning ?? false,
    capabilities: (modelId): ModelCapabilities => {
      const contextWindow = options.catalog().options.find((option) => option.id === modelId)?.contextWindow;
      return {
        tools: options.toolsEnabled === false ? "unsupported" : "supported",
        parallelTools: "unknown",
        streaming: "supported",
        contextWindow: contextWindow ? { status: "known", value: contextWindow } : { status: "unknown" },
        imageInput: options.imageInput?.(modelId) ? "supported" : "unsupported",
        imageOutput: "unsupported",
        audioInput: options.audioInput?.(modelId) ? "supported" : "unsupported",
        audioOutput: "unsupported",
        structuredOutput: "unsupported",
        toolSchemaLimit: { status: "unknown" },
      };
    },
  });
  return createAgentEngine({
    adapters: { resolve: () => adapter },
    store: createSqliteAgentRunStore(),
  });
}
