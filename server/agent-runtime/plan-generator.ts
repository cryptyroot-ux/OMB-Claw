// Plan generator: decomposes a high-level task description into a sequence of
// PlanSteps that the orchestrator can execute. Uses a heuristic decomposition
// (split by sentences/conjunctions) with optional LLM-based refinement.
//
// The generated plan is a starting point; the orchestrator's self-correction
// loop (verifier) can adjust steps at runtime.

import type { PlanStep, ProviderModelRef, CapabilityGrant, CapabilitySession } from "./contracts.ts";

export type TaskType = "coding" | "reasoning" | "creative" | "analysis" | "conversation" | "research";

export interface PlanGeneratorInput {
  readonly task: string;
  readonly providerModel: ProviderModelRef;
  readonly grant: CapabilityGrant;
  readonly capabilities: CapabilitySession;
  readonly maxSteps?: number;
}

// Heuristic: split task into sub-tasks by sentence boundaries and conjunctions.
function decomposeTask(task: string, maxSteps: number): string[] {
  const cleaned = task.trim();
  if (!cleaned) return [];

  // Split by sentence boundaries, then by "and"/"then"/"also".
  const sentences = cleaned
    .split(/[.!?;]\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const steps: string[] = [];
  for (const sentence of sentences) {
    // Further split long sentences by "and then", "then", "also", "and".
    const parts = sentence
      .split(/\b(?:and then|then|also|additionally|furthermore)\b/i)
      .map((s) => s.trim())
      .filter((s) => s.length > 5);
    if (parts.length > 1) {
      steps.push(...parts);
    } else {
      steps.push(sentence);
    }
  }

  // Cap at maxSteps.
  if (steps.length > maxSteps) {
    // Merge excess into the last step.
    const kept = steps.slice(0, maxSteps - 1);
    const merged = steps.slice(maxSteps - 1).join("; ");
    kept.push(merged);
    return kept;
  }
  return steps;
}

// Detect simple dependencies: a step that references "result of", "output of",
// "based on", "using" a prior step depends on it.
function detectDependencies(steps: string[]): ReadonlyArray<ReadonlyArray<number>> {
  const deps: number[][] = steps.map(() => []);
  for (let i = 1; i < steps.length; i++) {
    const lower = steps[i]!.toLowerCase();
    if (/\b(result of|output of|based on|using|from previous|after)\b/.test(lower)) {
      // Depends on the immediately preceding step.
      deps[i]!.push(i - 1);
    }
  }
  return deps;
}

export function generatePlan(input: PlanGeneratorInput): PlanStep[] {
  const maxSteps = input.maxSteps ?? 8;
  const subTasks = decomposeTask(input.task, maxSteps);
  if (subTasks.length === 0) {
    return [{
      id: "step-1",
      text: input.task,
      providerModel: input.providerModel,
      grant: input.grant,
      capabilities: input.capabilities,
    }];
  }

  const deps = detectDependencies(subTasks);
  return subTasks.map((text, idx) => ({
    id: `step-${idx + 1}`,
    text,
    providerModel: input.providerModel,
    grant: input.grant,
    capabilities: input.capabilities,
    dependsOn: deps[idx]!.map((d) => `step-${d + 1}`),
    approval: "auto" as const,
  }));
}

// LLM-based plan refinement: takes a raw generated plan and refines step text
// for clarity. Pure function; callers provide the refined text.
export function refinePlanSteps(steps: PlanStep[], refinements: ReadonlyArray<string>): PlanStep[] {
  return steps.map((step, idx) => ({
    ...step,
    text: refinements[idx] ?? step.text,
  }));
}