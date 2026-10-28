// Multi-agent swarm: multiple agents work on sub-tasks in parallel, share
// results via context variables, and merge. Builds on the existing orchestrator
// (PlanStep DAG) by adding agentId routing and a consensus mechanism.

import type { PlanStep, PlanResult } from "./contracts.ts";

export interface SwarmAgent {
  readonly id: string;
  readonly name: string;
}

export interface SwarmStep extends PlanStep {
  readonly agentId: string;
  readonly parallel?: boolean;
}

export interface SwarmPlan {
  readonly id: string;
  readonly steps: ReadonlyArray<SwarmStep>;
  readonly agents: ReadonlyArray<SwarmAgent>;
}

export interface SwarmResult {
  readonly planId: string;
  readonly stepResults: ReadonlyArray<PlanResult>;
  readonly consensus?: string;
  readonly conflicts: ReadonlyArray<{ readonly stepId: string; readonly reason: string }>;
}

export function createSwarmPlan(input: {
  readonly id: string;
  readonly agents: ReadonlyArray<SwarmAgent>;
  readonly steps: ReadonlyArray<SwarmStep>;
}): SwarmPlan {
  return { id: input.id, agents: input.agents, steps: input.steps };
}

// Group steps by dependency level for parallel execution.
export function planExecutionWaves(steps: ReadonlyArray<SwarmStep>): ReadonlyArray<ReadonlyArray<SwarmStep>> {
  const waves: SwarmStep[][] = [];
  const completed = new Set<string>();
  const remaining = [...steps];

  while (remaining.length > 0) {
    const wave: SwarmStep[] = [];
    const nextRemaining: SwarmStep[] = [];
    for (const step of remaining) {
      const deps = step.dependsOn ?? [];
      if (deps.every((d) => completed.has(d))) {
        wave.push(step);
      } else {
        nextRemaining.push(step);
      }
    }
    if (wave.length === 0 && nextRemaining.length > 0) {
      // Circular dependency or missing dep — push all remaining as one wave.
      waves.push(nextRemaining);
      break;
    }
    if (wave.length > 0) {
      waves.push(wave);
      for (const s of wave) completed.add(s.id);
    }
    remaining.splice(0, remaining.length, ...nextRemaining);
  }
  return waves;
}

// Detect conflicts: steps that produce contradictory outputs.
export function detectConflicts(results: ReadonlyArray<PlanResult>): ReadonlyArray<{ readonly stepId: string; readonly reason: string }> {
  const conflicts: { stepId: string; reason: string }[] = [];
  // Simple heuristic: if two steps output opposing boolean-like statements.
  for (let i = 0; i < results.length; i++) {
    for (let j = i + 1; j < results.length; j++) {
      const a = results[i]!;
      const b = results[j]!;
      if (a.output && b.output && a.output !== b.output) {
        // Check for obvious contradiction patterns.
        if (/\byes\b/i.test(a.output) && /\bno\b/i.test(b.output)) {
          conflicts.push({ stepId: b.stepId, reason: `Conflicts with ${a.stepId}` });
        }
      }
    }
  }
  return conflicts;
}

// Consensus: pick the most common output among steps.
export function resolveConsensus(results: ReadonlyArray<PlanResult>): string | undefined {
  const outputs = results.filter((r) => r.output).map((r) => r.output!);
  if (outputs.length === 0) return undefined;
  if (outputs.length === 1) return outputs[0];
  // Simple: return the longest output (most detailed).
  return outputs.reduce((a, b) => (a.length >= b.length ? a : b));
}