import { describe, expect, it } from "vitest";

import { createResponseCache, cacheKey } from "./response-cache.ts";
import { planExecutionWaves, detectConflicts, resolveConsensus } from "./swarm.ts";
import { validateManifest, createPluginRegistry } from "./plugin-loader.ts";

describe("response-cache", () => {
  it("stores and retrieves values", () => {
    const cache = createResponseCache<string>({ maxSize: 10, defaultTtlMs: 60000 });
    cache.set("k1", "v1");
    expect(cache.get("k1")).toBe("v1");
    expect(cache.has("k1")).toBe(true);
  });
  it("evicts oldest when full", () => {
    const cache = createResponseCache<string>({ maxSize: 2, defaultTtlMs: 60000 });
    cache.set("a", "1");
    cache.set("b", "2");
    cache.set("c", "3");
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("c")).toBe("3");
  });
  it("expires entries by TTL", async () => {
    const cache = createResponseCache<string>({ maxSize: 10, defaultTtlMs: 1 });
    cache.set("k", "v", 1);
    await new Promise((r) => setTimeout(r, 5));
    expect(cache.get("k")).toBeUndefined();
  });
  it("generates cache keys", () => {
    const key = cacheKey({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }], tools: [] });
    expect(key).toContain("gpt-4o");
  });
});

describe("swarm", () => {
  it("plans execution waves by dependency", () => {
    const steps = [
      { id: "a", text: "a", providerModel: { providerId: "p", modelId: "m" }, grant: {} as any, capabilities: {} as any, agentId: "agent1" },
      { id: "b", text: "b", providerModel: { providerId: "p", modelId: "m" }, grant: {} as any, capabilities: {} as any, agentId: "agent2", dependsOn: ["a"] },
    ];
    const waves = planExecutionWaves(steps as any);
    expect(waves).toHaveLength(2);
    expect(waves[0]).toHaveLength(1);
    expect(waves[1]).toHaveLength(1);
  });
  it("resolves consensus by longest output", () => {
    const result = resolveConsensus([
      { stepId: "a", runId: "r1", status: "completed", output: "short" },
      { stepId: "b", runId: "r2", status: "completed", output: "a much longer output here" },
    ]);
    expect(result).toBe("a much longer output here");
  });
  it("detects no conflicts for identical outputs", () => {
    const conflicts = detectConflicts([
      { stepId: "a", runId: "r1", status: "completed", output: "yes" },
      { stepId: "b", runId: "r2", status: "completed", output: "yes" },
    ]);
    expect(conflicts).toHaveLength(0);
  });
});

describe("plugin-loader", () => {
  it("validates manifest", () => {
    expect(validateManifest({ name: "test", version: "1.0.0" })).toBe(true);
    expect(validateManifest({})).toBe(false);
    expect(validateManifest(null)).toBe(false);
  });
  it("creates plugin registry", () => {
    const registry = createPluginRegistry();
    expect(registry.size()).toBe(0);
    registry.register({ manifest: { name: "p1", version: "1.0" }, module: {}, capabilities: [], hooks: [] });
    expect(registry.size()).toBe(1);
    expect(registry.get("p1")).toBeDefined();
    expect(registry.unregister("p1")).toBe(true);
    expect(registry.size()).toBe(0);
  });
});