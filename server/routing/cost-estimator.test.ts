// server/routing/cost-estimator.test.ts
import { describe, it, expect } from "vitest";
import { estimateCost } from "./cost-estimator.ts";

describe("estimateCost", () => {
  it("estimates input + output cost", () => {
    const messages = [
      { role: "user", content: "Hello" },  // ~1 token
    ];
    const cost = estimateCost(messages, "gpt-4o", 100); // 100 output tokens
    expect(cost).toBeGreaterThan(0);
    expect(cost).toBeLessThan(1);
  });

  it("handles empty messages", () => {
    expect(estimateCost([], "gpt-4o", 0)).toBe(0);
  });

  it("uses cost table for unknown model", () => {
    const cost = estimateCost([{ role: "user", content: "Hi" }], "unknown-model", 50);
    expect(cost).toBe(0); // unknown = 0 cost (free/unknown)
  });
});