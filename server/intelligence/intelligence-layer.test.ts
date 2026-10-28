import { describe, it, expect, vi } from "vitest";
import { IntelligenceLayer } from "./intelligence-layer.ts";

describe("IntelligenceLayer", () => {
  it("processes a brief end-to-end", async () => {
    const mockModel = vi.fn().mockResolvedValue(JSON.stringify({
      steps: [{ id: "s1", description: "step", type: "tool", expectedTools: [], dependencies: [], successCriteria: "done" }],
    }));
    const mockToolRunner = vi.fn().mockResolvedValue({ ok: true, text: "done" });
    const layer = new IntelligenceLayer({ modelCaller: mockModel, toolRunner: mockToolRunner });
    const result = await layer.process("Build a hello world API", "thread-1");
    expect(result.completed).toBe(true);
    expect(result.stepsCompleted).toBe(1);
  });

  it("returns failure when plan invalid", async () => {
    const mockModel = vi.fn().mockResolvedValue("garbage");
    const mockToolRunner = vi.fn();
    const layer = new IntelligenceLayer({ modelCaller: mockModel, toolRunner: mockToolRunner });
    const result = await layer.process("Build API", "thread-1");
    expect(result.completed).toBe(false);
    expect(result.error).toContain("plan");
  });
});
