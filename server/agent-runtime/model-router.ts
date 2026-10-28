// Model router: maps a task's complexity tier to a concrete provider/model,
// consulting a configurable routing table and falling back through candidates
// when a chosen model is unavailable or refuses.

import type { ProviderModelRef } from "./contracts.ts";
import { classifyTask, complexityToTier, type ComplexityLevel } from "./task-classifier.ts";

export interface ModelTier {
  readonly cheap: ReadonlyArray<ProviderModelRef>;
  readonly standard: ReadonlyArray<ProviderModelRef>;
  readonly premium: ReadonlyArray<ProviderModelRef>;
}

export interface ModelRouterConfig {
  readonly tiers: ModelTier;
  /** Optional per-complexity overrides. */
  readonly overrides?: Partial<Record<ComplexityLevel, ReadonlyArray<ProviderModelRef>>>;
}

export interface RouteDecision {
  readonly complexity: ComplexityLevel;
  readonly tier: "cheap" | "standard" | "premium";
  readonly candidates: ReadonlyArray<ProviderModelRef>;
}

export function createModelRouter(config: ModelRouterConfig) {
  return {
    route(signals: { text: string; messageCount?: number; toolCount?: number; hasImages?: boolean; hasCode?: boolean }): RouteDecision {
      const complexity = classifyTask(signals);
      const tier = complexityToTier(complexity);
      const override = config.overrides?.[complexity];
      const candidates = override && override.length > 0
        ? override
        : config.tiers[tier];
      return { complexity, tier, candidates };
    },
  };
}

export function defaultModelTiers(primary: ProviderModelRef): ModelTier {
  return {
    cheap: [primary],
    standard: [primary],
    premium: [primary],
  };
}