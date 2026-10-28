import type { ModelCatalog } from "../contracts.ts";
import type { AgentEngine, ModelAdapter, ModelCapabilities } from "../agent-runtime/contracts.ts";
import { createAgentEngine } from "../agent-runtime/runtime.ts";
import { createOpenAICompatibleModelAdapter } from "../agent-runtime/model-adapter.ts";
import { probeCapabilities } from "../agent-runtime/capability-probe.ts";
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
  readonly httpErrorLabel?: string;
  /** `config.tools === false` keeps tools unmounted; the model must not then be told it can call them. */
  readonly toolsEnabled?: boolean;
  readonly imageInput?: (modelId: string) => boolean;
  readonly audioInput?: (modelId: string) => boolean;
  /** Label used in HTTP error messages, e.g. "xAI" or "upstream". */
  readonly httpErrorLabel?: string;
  /** Optional pre-built adapter (e.g. Anthropic Messages). When provided, the OpenAI-compatible adapter is not created. */
  readonly modelAdapter?: ModelAdapter;
}

export function createNativeChatEngine(options: NativeChatEngineOptions): AgentEngine {
  const adapter = options.modelAdapter ?? createOpenAICompatibleModelAdapter({
    providerId: options.providerId,
    apiUrl: options.apiUrl,
    apiKey: options.apiKey,
    catalog: options.catalog,
    reasoning: options.reasoning ?? false,
    httpErrorLabel: options.httpErrorLabel,
    capabilities: (modelId): ModelCapabilities => probeCapabilities(modelId, options.catalog, {
      toolsEnabled: options.toolsEnabled,
      imageInput: options.imageInput,
      audioInput: options.audioInput,
    }),
  });
  return createAgentEngine({
    adapters: { resolve: () => adapter },
    store: createSqliteAgentRunStore(),
  });
}
