// server/intelligence/integration.ts
// Integration helper: creates an IntelligenceLayer from server config and runtime context.
// Usage: const layer = createIntelligenceLayer(cfg, modelCaller, toolRunner);

type ConfigStatus = Record<string, unknown>;
import { isIntelligenceEnabled } from "./feature-flag.ts";
import { IntelligenceLayer } from "./intelligence-layer.ts";
import type { IntelligenceLayerDeps } from "./intelligence-layer.ts";

export interface IntelligenceContext {
  modelCaller: (prompt: string) => Promise<string>;
  toolRunner: (step: any) => Promise<unknown>;
  threadId?: string;
}

export function createIntelligenceLayer(
  config: ConfigStatus | null | undefined,
  ctx: IntelligenceContext,
): IntelligenceLayer | null {
  if (!isIntelligenceEnabled(config)) return null;

  const deps: IntelligenceLayerDeps = {
    modelCaller: ctx.modelCaller,
    toolRunner: ctx.toolRunner,
    threadId: ctx.threadId,
    config: config ?? undefined,
  };

  return new IntelligenceLayer(deps);
}

export function isIntelligenceActive(config: ConfigStatus | null | undefined): boolean {
  return isIntelligenceEnabled(config);
}
