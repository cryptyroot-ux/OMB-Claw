// server/intelligence/executor.test.ts
import { describe, it, expect, vi } from "vitest";
import { Executor } from "./executor.ts";

describe("Executor", () => {
  it("executes plan steps in dependency order", async () => {
    const toolRunner = vi.fn().mockResolvedValue({ ok: true, text: "done" });
    const executor = new Executor(toolRunner);
    const plan = {
      id: "p1", threadId: "t1", goal: "test", status: "pending" as const,
      steps: [
        { id: "s1", description: "step1", type: "tool" as const, expectedTools: ["write"], dependencies: [], successCriteria: "done" },
        { id: "s2", description: "step2", type: "tool" as const, expectedTools: ["write"], dependencies: ["s1"], successCriteria: "done" },
      ],
      metadata: { estimatedCost: 0, estimatedDuration: 0, requiredCapabilities: [], modelAssignments: {} },
    };
    const result = await executor.execute(plan);
    expect(result.completedSteps).toBe(2);
    expect(result.failedSteps).toBe(0);
  });

  it("skips steps with unmet dependencies", async () => {
    const toolRunner = vi.fn().mockResolvedValue({ ok: false, text: "fail" });
    const executor = new Executor(toolRunner);
    const plan = {
      id: "p1", threadId: "t1", goal: "test", status: "pending" as const,
      steps: [
        { id: "s1", description: "step1", type: "tool" as const, expectedTools: [], dependencies: [], successCriteria: "done" },
        { id: "s2", description: "step2", type: "tool" as const, expectedTools: [], dependencies: ["s1"], successCriteria: "done" },
      ],
      metadata: { estimatedCost: 0, estimatedDuration: 0, requiredCapabilities: [], modelAssignments: {} },
    };
    const result = await executor.execute(plan);
    expect(result.failedSteps).toBeGreaterThanOrEqual(1);
  });
});
