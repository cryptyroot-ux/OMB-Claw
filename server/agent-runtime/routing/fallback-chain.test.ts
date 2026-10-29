import { describe, it, expect } from "vitest";
import { FallbackChain } from "./fallback-chain.ts";

describe("FallbackChain", () => {
  it("returns result from primary model on success", async () => {
    const calls: string[] = [];
    const chain = new FallbackChain(async (model) => {
      calls.push(model);
      return { ok: true, model };
    });
    const result = await chain.execute("primary", ["fallback1", "fallback2"]);
    expect(result).toEqual({ ok: true, model: "primary" });
    expect(calls).toEqual(["primary"]);
  });

  it("tries fallbacks when primary returns failure", async () => {
    const calls: string[] = [];
    const chain = new FallbackChain(async (model) => {
      calls.push(model);
      if (model === "primary") return { ok: false, error: "boom" };
      return { ok: true, model };
    });
    const result = await chain.execute("primary", ["fallback1", "fallback2"]);
    expect(result).toEqual({ ok: true, model: "fallback1" });
    expect(calls).toEqual(["primary", "fallback1"]);
  });

  it("tries fallbacks when primary throws", async () => {
    const calls: string[] = [];
    const chain = new FallbackChain(async (model) => {
      calls.push(model);
      if (model === "primary") throw new Error("down");
      return { ok: true, model };
    });
    const result = await chain.execute({ primary: { model: "primary", estimatedCost: 0 } as any, fallbacks: ["fb1"] });
    expect(result).toEqual({ ok: true, model: "fb1" });
    expect(calls).toEqual(["primary", "fb1"]);
  });

  it("throws when all models fail", async () => {
    const chain = new FallbackChain(async () => {
      throw new Error("down");
    });
    await expect(chain.execute("primary", ["fb1"])).rejects.toThrow("down");
  });

  it("tracks lastSucceededModel", async () => {
    const chain = new FallbackChain(async (model) => {
      if (model === "primary") return { ok: false, error: "boom" };
      return { ok: true, model };
    });
    await chain.execute("primary", ["fb1"]);
    expect(chain.lastSucceededModel).toBe("fb1");
  });
});
