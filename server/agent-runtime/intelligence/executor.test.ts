import { describe, it, expect, vi } from "vitest";
import { Executor } from "./executor.ts";
import type { Plan, PlanStep } from "./types.ts";

describe("Executor", () => {
  it("executes plan steps in dependency order", async () => {
    const toolRunner = vi.fn().mockResolvedValue({ ok: true, text: "done" });
    const executor = new Executor(toolRunner);
    const plan: Plan = {
      id: "p1", threadId: "t1", goal: "test", status: "pending",
      steps: [
        { id: "s1", description: "step1", type: "tool", expectedTools: ["write"], dependencies: [], successCriteria: "done" },
        { id: "s2", description: "step2", type: "tool", expectedTools: ["write"], dependencies: ["s1"], successCriteria: "done" },
      ],
      metadata: { estimatedCost: 0, estimatedDuration: 0, requiredCapabilities: [], modelAssignments: {} },
    };
    const result = await executor.execute(plan);
    expect(result.completedSteps).toBe(2);
    expect(result.failedSteps).toBe(0);
    expect(toolRunner).toHaveBeenCalledTimes(2);
  });

  it("skips steps with unmet dependencies", async () => {
    const toolRunner = vi.fn().mockResolvedValue({ ok: true, text: "done" });
    const executor = new Executor(toolRunner);
    const plan: Plan = {
      id: "p1", threadId: "t1", goal: "test", status: "pending",
      steps: [
        { id: "s1", description: "step1", type: "tool", expectedTools: [], dependencies: [], successCriteria: "done" },
        { id: "s2", description: "step2", type: "tool", expectedTools: [], dependencies: ["s1"], successCriteria: "done" },
      ],
      metadata: { estimatedCost: 0, estimatedDuration: 0, requiredCapabilities: [], modelAssignments: {} },
    };
    // Make s1 fail so s2 is skipped
    toolRunner.mockImplementationOnce((step: PlanStep) => {
      if (step.id === "s1") return Promise.resolve({ ok: false, text: "fail" });
      return Promise.resolve({ ok: true, text: "done" });
    });
    const result = await executor.execute(plan);
    expect(result.failedSteps).toBeGreaterThanOrEqual(1);
  });

  it("marks step failed when tool returns error", async () => {
    const toolRunner = vi.fn().mockResolvedValue({ ok: false, error: "boom" });
    const executor = new Executor(toolRunner);
    const plan: Plan = {
      id: "p1", threadId: "t1", goal: "test", status: "pending",
      steps: [{ id: "s1", description: "step1", type: "tool", expectedTools: [], dependencies: [], successCriteria: "done" }],
      metadata: { estimatedCost: 0, estimatedDuration: 0, requiredCapabilities: [], modelAssignments: {} },
    };
    const result = await executor.execute(plan);
    expect(result.failedSteps).toBe(1);
    expect(result.success).toBe(false);
  });
});
