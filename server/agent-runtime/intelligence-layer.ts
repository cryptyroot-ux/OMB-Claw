// Intelligence Layer: composes Task Classifier + Model Router + Cost Estimator +
// Verifier + Budget Guard into a single entry point that the orchestrator calls
// before executing a plan. Gated behind a feature flag so it can be disabled
// without touching the base engine.

import type { ProviderModelRef } from "./contracts.ts";
import { type ComplexityLevel } from "./task-classifier.ts";
import { createModelRouter, type ModelTier, type RouteDecision } from "./model-router.ts";
import { estimateCost, type CostEstimate } from "./cost-estimator.ts";
import { runVerifyLoop, type VerifyLoopResult } from "./verifier.ts";

export interface IntelligenceConfig {
  readonly enabled: boolean;
  readonly tiers: ModelTier;
  readonly overrides?: Partial<Record<ComplexityLevel, ReadonlyArray<ProviderModelRef>>>;
  readonly maxRetries?: number;
  readonly maxCostUsd?: number;
}

export interface IntelligenceDecision {
  readonly complexity: ComplexityLevel;
  readonly route: RouteDecision;
  readonly costEstimate: CostEstimate;
  readonly allowed: boolean;
  readonly reason?: string;
}

export function createIntelligenceLayer(config: IntelligenceConfig) {
  const router = createModelRouter({ tiers: config.tiers, overrides: config.overrides });

  return {
    enabled: config.enabled,

    decide(input: { text: string; messageCount?: number; toolCount?: number; hasImages?: boolean; hasCode?: boolean; messages: ReadonlyArray<{ content: string | null | undefined }>; primaryModel: ProviderModelRef }): IntelligenceDecision {
      if (!config.enabled) {
        return {
          complexity: "medium",
          route: { complexity: "medium", tier: "standard", candidates: [input.primaryModel] },
          costEstimate: estimateCost({ messages: input.messages, model: input.primaryModel.modelId }),
          allowed: true,
        };
      }
      const route = router.route({
        text: input.text,
        messageCount: input.messageCount,
        toolCount: input.toolCount,
        hasImages: input.hasImages,
        hasCode: input.hasCode,
      });
      const candidate = route.candidates[0] ?? input.primaryModel;
      const costEstimate = estimateCost({ messages: input.messages, model: candidate.modelId });
      const allowed = config.maxCostUsd === undefined || costEstimate.estimatedCostUsd <= config.maxCostUsd;
      return {
        complexity: route.complexity,
        route,
        costEstimate,
        allowed,
        reason: allowed ? undefined : `Estimated cost ${costEstimate.estimatedCostUsd.toFixed(4)} exceeds budget ${config.maxCostUsd}`,
      };
    },

    async verify(_output: string, verifyFn: (o: string) => Promise<{ ok: boolean; feedback: string }>, execute: (attempt: number, feedback?: string) => Promise<string>): Promise<VerifyLoopResult> {
      if (!config.enabled) {
        const o = await execute(0);
        return { ok: true, attempts: 1, lastFeedback: "", outputs: [o] };
      }
      return runVerifyLoop(execute, { maxRetries: config.maxRetries ?? 2, verify: verifyFn });
    },
  };
}