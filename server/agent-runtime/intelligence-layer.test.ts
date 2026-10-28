import { describe, expect, it } from "vitest";

import { classifyTask, complexityToTier } from "./task-classifier.ts";
import { createModelRouter, defaultModelTiers } from "./model-router.ts";
import { estimateCost, estimateTokens } from "./cost-estimator.ts";
import { runVerifyLoop, heuristicVerifier } from "./verifier.ts";
import { createIntelligenceLayer } from "./intelligence-layer.ts";
import type { ProviderModelRef } from "./contracts.ts";

const primary: ProviderModelRef = { providerId: "openai", modelId: "gpt-4o" };

describe("task-classifier", () => {
  it("classifies trivial greetings", () => {
    expect(classifyTask({ text: "hi" })).toBe("trivial");
    expect(classifyTask({ text: "hello" })).toBe("trivial");
  });
  it("classifies complex architecture tasks", () => {
    const level = classifyTask({ text: "Design a distributed system with concurrent processing and security audit", toolCount: 5 });
    expect(["complex", "expert"]).toContain(level);
  });
  it("maps to tiers", () => {
    expect(complexityToTier("trivial")).toBe("cheap");
    expect(complexityToTier("expert")).toBe("premium");
  });
});

describe("model-router", () => {
  it("routes based on complexity", () => {
    const router = createModelRouter({ tiers: defaultModelTiers(primary) });
    const decision = router.route({ text: "hi" });
    expect(decision.candidates).toHaveLength(1);
    expect(decision.candidates[0]).toEqual(primary);
  });
});

describe("cost-estimator", () => {
  it("estimates tokens", () => {
    expect(estimateTokens("hello world")).toBeGreaterThan(0);
  });
  it("estimates cost", () => {
    const est = estimateCost({ messages: [{ content: "hello" }], model: "gpt-4o" });
    expect(est.estimatedCostUsd).toBeGreaterThan(0);
    expect(est.model).toBe("gpt-4o");
  });
});

describe("verifier", () => {
  it("heuristic verifier rejects empty", () => {
    expect(heuristicVerifier("").ok).toBe(false);
    expect(heuristicVerifier("a long enough answer here").ok).toBe(true);
  });
  it("runVerifyLoop retries on failure", async () => {
    const result = await runVerifyLoop(
      async (attempt) => { return attempt === 0 ? "bad" : "good answer here"; },
      { maxRetries: 2, verify: (o) => ({ ok: o.includes("good"), feedback: "need good" }) },
    );
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
  });
  it("runVerifyLoop gives up after max retries", async () => {
    const result = await runVerifyLoop(
      async () => "bad",
      { maxRetries: 1, verify: () => ({ ok: false, feedback: "no" }) },
    );
    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(2);
  });
});

describe("intelligence-layer", () => {
  it("disabled layer passes through", () => {
    const layer = createIntelligenceLayer({ enabled: false, tiers: defaultModelTiers(primary) });
    const decision = layer.decide({ text: "hi", messages: [{ content: "hi" }], primaryModel: primary });
    expect(decision.allowed).toBe(true);
    expect(decision.route.candidates[0]).toEqual(primary);
  });
  it("enabled layer classifies and routes", () => {
    const layer = createIntelligenceLayer({ enabled: true, tiers: defaultModelTiers(primary), maxCostUsd: 10 });
    const decision = layer.decide({ text: "Design a distributed system", messages: [{ content: "Design a distributed system" }], primaryModel: primary });
    expect(decision.allowed).toBe(true);
    expect(decision.complexity).toBeDefined();
  });
  it("budget guard rejects over budget", () => {
    const layer = createIntelligenceLayer({ enabled: true, tiers: defaultModelTiers(primary), maxCostUsd: 0.000001 });
    const decision = layer.decide({ text: "hello", messages: [{ content: "a".repeat(10000) }], primaryModel: primary });
    expect(decision.allowed).toBe(false);
  });
  it("verify with disabled layer runs once", async () => {
    const layer = createIntelligenceLayer({ enabled: false, tiers: defaultModelTiers(primary) });
    const result = await layer.verify("out", async () => ({ ok: true, feedback: "" }), async () => "done");
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(1);
  });
});