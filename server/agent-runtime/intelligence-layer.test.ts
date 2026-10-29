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

describe("IntelligenceLayer processStream (Pivot-style)", () => {
  it("yields classify, route, plan, execute, verify, done phases", async () => {
    const planJson = JSON.stringify({
      steps: [{ id: "s1", description: "do thing", type: "think", expectedTools: [], dependencies: [], successCriteria: "done" }],
    });
    const verifyJson = JSON.stringify({ verified: true, evidence: "ok", confidence: 1 });

    let calls = 0;
    const modelCaller = async (_p: string) => { calls++; return calls === 1 ? planJson : verifyJson; };
    const toolRunner = async (_s: any) => ({ ok: true, text: "r" });

    const layer = createIntelligenceLayer({
      enabled: true,
      tiers: { cheap: [], standard: [], premium: [] },
      modelCaller,
      toolRunner,
      threadId: "",
    });

    const phases: string[] = [];
    for await (const chunk of layer.processStream("Write hello", "")) {
      phases.push(chunk.phase);
    }
    expect(phases).toContain("classify");
    expect(phases).toContain("done");
    expect(phases.length).toBeGreaterThanOrEqual(5);
  });

  it("process() completes end-to-end", async () => {
    const planJson = JSON.stringify({
      steps: [{ id: "s1", description: "do thing", type: "think", expectedTools: [], dependencies: [], successCriteria: "done" }],
    });
    const verifyJson = JSON.stringify({ verified: true, evidence: "ok", confidence: 1 });

    let calls = 0;
    const modelCaller = async (_p: string) => { calls++; return calls === 1 ? planJson : verifyJson; };
    const toolRunner = async (_s: any) => ({ ok: true, text: "result" });

    const layer = createIntelligenceLayer({
      enabled: true,
      tiers: { cheap: [], standard: [], premium: [] },
      modelCaller,
      toolRunner,
      threadId: "",
    });

    const result = await layer.process("Write a hello function", "");
    expect(result.completed).toBe(true);
    expect(result.stepsCompleted).toBe(1);
    expect(result.stepsFailed).toBe(0);
    expect(result.error).toBeUndefined();
  });

  it("returns disabled result when enabled is false", async () => {
    const layer = createIntelligenceLayer({
      enabled: false,
      tiers: { cheap: [], standard: [], premium: [] },
    });
    const result = await layer.process("hello", "");
    expect(result.completed).toBe(false);
    expect(result.error).toBe("intelligence layer disabled");
  });
});
