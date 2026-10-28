// server/intelligence/planner.ts

import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Budget, ModelAssignment } from "../routing/types.ts";
import type { ModelRouter } from "../routing/model-router.ts";
import { extractJson } from "./extract-json.ts";
import { appendNative } from "../drivers/native.ts";
import type { TaskType } from "./task-classifier.ts";
import type { Plan, PlanStep, PlanStepType } from "./types.ts";

export interface PlannerOptions {
  maxSteps?: number;
  modelRouter?: ModelRouter;
  budget?: Budget;
}

const STEP_TYPES = ["tool", "think", "delegate", "verify"] as const;

const parsedStepSchema = z.object({
  id: z.string().min(1),
  description: z.string(),
  type: z.enum(STEP_TYPES),
  expectedTools: z.array(z.string()).default([]),
  dependencies: z.array(z.string()).default([]),
  successCriteria: z.string(),
  assignedAgent: z.string().optional(),
});

const parsedPlanSchema = z.object({
  steps: z.array(parsedStepSchema),
});

export class Planner {
  private readonly modelCaller: (prompt: string) => Promise<string>;
  private readonly maxSteps: number;
  private readonly modelRouter: ModelRouter | undefined;
  private readonly budget: Budget;

  constructor(modelCaller: (prompt: string) => Promise<string>, options: PlannerOptions = {}) {
    this.modelCaller = modelCaller;
    this.maxSteps = Number.isFinite(options.maxSteps) ? (options.maxSteps as number) : Number.POSITIVE_INFINITY;
    this.modelRouter = options.modelRouter;
    this.budget = options.budget ?? { maxCost: Number.POSITIVE_INFINITY };
  }

  async plan(goal: string, taskType: TaskType, threadId: string = ""): Promise<Plan> {
    const prompt = [
      "You are a planning agent. Generate a structured plan as JSON.",
      `Goal: ${goal}`,
      `Task type: ${taskType}`,
      "Return an object with a \"steps\" array. Each step must have: id, description, type (tool|think|delegate|verify), expectedTools (string[]), dependencies (string[] of step ids), successCriteria (string).",
      "Do not include any other text.",
    ].join("\n");

    const raw = await this.modelCaller(prompt);

    let parsed: unknown;
    try {
      parsed = extractJson(raw, "plan");
    } catch {
      throw new Error("Invalid plan");
    }

    const result = parsedPlanSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error("Invalid plan");
    }

    let stepsRaw = result.data.steps;
    if (Number.isFinite(this.maxSteps) && stepsRaw.length > this.maxSteps) {
      stepsRaw = stepsRaw.slice(0, this.maxSteps);
    }

    const steps: PlanStep[] = stepsRaw.map((step) => ({
      id: step.id,
      description: step.description,
      type: step.type as PlanStepType,
      assignedAgent: step.assignedAgent,
      dependencies: step.dependencies,
      expectedTools: step.expectedTools,
      successCriteria: step.successCriteria,
      verified: false,
    }));

    const modelAssignments: Record<string, ModelAssignment> = {};
    let estimatedCost = 0;
    if (this.modelRouter) {
      for (const step of steps) {
        const assignment = this.modelRouter.select(taskType, this.budget);
        const withStep: ModelAssignment = { ...assignment, stepId: step.id };
        modelAssignments[step.id] = withStep;
        estimatedCost += withStep.primary.estimatedCost;
      }
    }

    const requiredCapabilities = Array.from(
      new Set(steps.flatMap((step) => step.expectedTools)),
    );

    const plan: Plan = {
      id: randomUUID(),
      threadId,
      goal,
      steps,
      metadata: {
        estimatedCost,
        estimatedDuration: 0,
        requiredCapabilities,
        modelAssignments,
      },
      status: "pending",
    };

    if (threadId) {
      appendNative(threadId, { dir: "out", source: "planner", msg: { planId: plan.id, steps: plan.steps.length } });
    }
    return plan;
  }
}
