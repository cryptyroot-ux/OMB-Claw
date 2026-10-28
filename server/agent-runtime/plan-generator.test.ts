import { describe, expect, it } from "vitest";

import { generatePlan, refinePlanSteps } from "./plan-generator.ts";

const grant = { botId: "b1", threadId: "t1", approvalMode: "full" as const, allowed: new Set<string>(), denied: new Set<string>() };
const caps = { list: () => [], validate: () => {}, invoke: async () => ({ callId: "", ok: true, content: "" }), close: async () => {} } as any;
const model = { providerId: "openai", modelId: "gpt-4o" };

describe("plan-generator", () => {
  it("generates single step for simple task", () => {
    const steps = generatePlan({ task: "Do something", providerModel: model, grant, capabilities: caps });
    expect(steps).toHaveLength(1);
    expect(steps[0]!.text).toBe("Do something");
  });

  it("decomposes multi-sentence task", () => {
    const steps = generatePlan({ task: "Read the file. Then summarize it. Finally write a report.", providerModel: model, grant, capabilities: caps });
    expect(steps.length).toBeGreaterThanOrEqual(2);
  });

  it("detects dependencies", () => {
    const steps = generatePlan({ task: "Read the file. Then summarize based on the previous output.", providerModel: model, grant, capabilities: caps });
    const lastStep = steps[steps.length - 1]!;
    expect(lastStep.dependsOn).toBeDefined();
  });

  it("caps at maxSteps", () => {
    const steps = generatePlan({ task: "a. b. c. d. e. f. g. h. i. j.", providerModel: model, grant, capabilities: caps, maxSteps: 3 });
    expect(steps.length).toBeLessThanOrEqual(3);
  });

  it("refines plan steps", () => {
    const steps = generatePlan({ task: "Do it", providerModel: model, grant, capabilities: caps });
    const refined = refinePlanSteps(steps, ["Do it better"]);
    expect(refined[0]!.text).toBe("Do it better");
  });
});