import type { ModelCatalog } from "../contracts.ts";
import type { AgentEngine, ModelAdapter, ModelCapabilities } from "../agent-runtime/contracts.ts";
import { createAgentEngine } from "../agent-runtime/runtime.ts";
import { createOpenAICompatibleModelAdapter } from "../agent-runtime/model-adapter.ts";
import { probeCapabilities } from "../agent-runtime/capability-probe.ts";
import { probeLive } from "../agent-runtime/capability-probe.ts";
import { heuristicVerifier } from "../agent-runtime/verifier.ts";
import { createIntelligenceLayer } from "../agent-runtime/intelligence-layer.ts";
import { defaultModelTiers } from "../agent-runtime/model-router.ts";
import { createPluginRegistry, validateManifest, loadPlugin } from "../agent-runtime/plugin-loader.ts";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
  /** Optional pre-built adapter (e.g. Anthropic Messages). When provided, the OpenAI-compatible adapter is not created. */
  readonly modelAdapter?: ModelAdapter;
}

export async function createNativeChatEngine(options: NativeChatEngineOptions): Promise<AgentEngine> {
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
  // Load plugins from plugins directory (if exists).
  const pluginRegistry = createPluginRegistry();
  const pluginsDir = join(process.cwd(), "plugins");
  if (existsSync(pluginsDir)) {
    for (const entry of readdirSync(pluginsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestPath = join(pluginsDir, entry.name, "plugin.json");
      if (!existsSync(manifestPath)) continue;
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        if (validateManifest(manifest)) {
          const plugin = await loadPlugin(manifest, join(pluginsDir, entry.name));
          pluginRegistry.register(plugin);
        }
      } catch {
        // Skip invalid plugins.
      }
    }
  }

  return createAgentEngine({
    adapters: { resolve: () => adapter },
    store: createSqliteAgentRunStore(),
    cacheEnabled: true,
    plugins: pluginRegistry,
    intelligence: {
      enabled: true,
      decide: (input) => createIntelligenceLayer({ enabled: true, tiers: defaultModelTiers({ providerId: options.providerId, modelId: options.catalog().default }) }).decide(input as any),
      verify: heuristicVerifier,
    },
    ...(options.apiKey
      ? {
          probe: {
            run: async (adapter, modelId) => {
              const result = await probeLive(adapter, modelId);
              return result.error ? null : result;
            },
          },
        }
      : {}),
  });
}
