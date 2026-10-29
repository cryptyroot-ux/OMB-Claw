import { describe, it, expect, vi } from "vitest";
import { Planner } from "./planner.ts";

describe("Planner", () => {
  it("generates a plan with steps", async () => {
    const mockModel = vi.fn().mockResolvedValue(JSON.stringify({
      steps: [
        { id: "s1", description: "Create user model", type: "tool", expectedTools: ["write"], dependencies: [], successCriteria: "User model file created" },
        { id: "s2", description: "Write tests", type: "tool", expectedTools: ["write"], dependencies: ["s1"], successCriteria: "Tests pass" },
      ],
    }));
    const planner = new Planner(mockModel);
    const plan = await planner.plan("Build user registration API", "coding");
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[0].id).toBe("s1");
    expect(plan.steps[1].dependencies).toContain("s1");
  });

  it("validates plan schema", async () => {
    const mockModel = vi.fn().mockResolvedValue("not valid json");
    const planner = new Planner(mockModel);
    await expect(planner.plan("Build API", "coding")).rejects.toThrow("Invalid plan");
  });

  it("limits plan depth", async () => {
    const mockModel = vi.fn().mockResolvedValue(JSON.stringify({
      steps: Array.from({ length: 50 }, (_, i) => ({ id: `s${i}`, description: "step", type: "tool", expectedTools: [], dependencies: [], successCriteria: "done" })),
    }));
    const planner = new Planner(mockModel, { maxSteps: 10 });
    const plan = await planner.plan("Big task", "coding");
    expect(plan.steps.length).toBeLessThanOrEqual(10);
  });
});
