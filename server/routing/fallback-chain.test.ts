import { describe, it, expect, vi } from "vitest";
import { FallbackChain } from "./fallback-chain.ts";

describe("FallbackChain", () => {
  it("returns primary result on success", async () => {
    const executor = vi.fn().mockResolvedValue({ ok: true, text: "done" });
    const chain = new FallbackChain(executor, { maxRetries: 3 });
    const result = await chain.execute("model-a", ["model-b"], { messages: [] });
    expect(result.ok).toBe(true);
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it("falls back on primary failure", async () => {
    const executor = vi.fn()
      .mockRejectedValueOnce(new Error("primary failed"))
      .mockResolvedValue({ ok: true, text: "fallback done" });
    const chain = new FallbackChain(executor, { maxRetries: 3 });
    const result = await chain.execute("model-a", ["model-b"], { messages: [] });
    expect(result.ok).toBe(true);
    expect(executor).toHaveBeenCalledTimes(2);
  });

  it("throws after all fallbacks exhausted", async () => {
    const executor = vi.fn().mockRejectedValue(new Error("all fail"));
    const chain = new FallbackChain(executor, { maxRetries: 3 });
    await expect(chain.execute("model-a", ["model-b"], { messages: [] })).rejects.toThrow("all fail");
    expect(executor).toHaveBeenCalledTimes(2); // primary + 1 fallback
  });

  it("respects maxRetries", async () => {
    const executor = vi.fn().mockRejectedValue(new Error("fail"));
    const chain = new FallbackChain(executor, { maxRetries: 1 });
    await expect(chain.execute("model-a", ["model-b", "model-c"], { messages: [] })).rejects.toThrow();
    expect(executor).toHaveBeenCalledTimes(1); // only primary
  });
});