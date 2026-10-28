import { randomUUID } from "node:crypto";

import type {
  AgentEngine,
  AgentEvent,
  AgentRunRequest,
  ModelMessage,
  Orchestrator,
  OrchestratorContext,
  OrchestratorStore,
  OrchestrationEvent,
  PlanId,
  PlanResult,
  PlanStep,
  StepId,
  StepRecord,
  StepStatus,
} from "./contracts.ts";

/** Builds the message list for an engine run, injecting context variables as a leading system message. */
function buildMessagesWithContext(step: PlanStep, contextVariables: ReadonlyMap<string, string>): ReadonlyArray<ModelMessage> {
  const contextLines: string[] = [];
  for (const [key, value] of contextVariables) {
    contextLines.push(`${key}: ${value}`);
  }

  const prefix = contextLines.length > 0 ? `Context from prior steps:\n${contextLines.join("\n")}\n\n` : "";

  return [{ role: "system", content: prefix + step.text }];
}

type Gate = { readonly resolve: () => void; readonly reject: (reason: string) => void };

export function createOrchestrator(dependencies: {
  readonly engine: AgentEngine;
  readonly store: OrchestratorStore;
  readonly intelligence?: {
    readonly enabled: boolean;
    readonly decide: (input: { text: string; messageCount?: number; toolCount?: number; hasImages?: boolean; hasCode?: boolean; messages: ReadonlyArray<{ content: string | null | undefined }>; primaryModel: import("./contracts.ts").ProviderModelRef }) => { readonly allowed: boolean; readonly reason?: string; readonly route: { readonly candidates: ReadonlyArray<import("./contracts.ts").ProviderModelRef> } };
  };
}): Orchestrator {
  const listeners = new Map<string, Set<(event: OrchestrationEvent) => void>>();
  const active = new Map<string, {
    readonly planId: PlanId;
    readonly controller: AbortController;
    readonly steps: ReadonlyArray<PlanStep>;
    readonly contextVariables: Map<string, string>;
    readonly context: OrchestratorContext;
  }>();
  const planApprovalGate = new Map<string, Gate | undefined>();
  const stepApprovalGate = new Map<string, Gate | undefined>();

  const emit = (planId: string, event: OrchestrationEvent) => {
    for (const listener of Array.from(listeners.get(planId) ?? [])) listener(event);
  };

  const recordStep = (
    planId: string,
    step: PlanStep,
    status: StepStatus,
    result?: PlanResult,
  ): void => {
    const existing = dependencies.store.getStep(step.id);
    if (existing) {
      dependencies.store.updateStepStatus(step.id, status, Date.now(), result);
    } else {
      dependencies.store.createStep({
        stepId: step.id,
        planId,
        status,
        result,
        ...(status !== "pending" ? { startedAt: Date.now() } : {}),
        ...(status === "completed" || status === "failed" || status === "skipped" ? { completedAt: Date.now() } : {}),
      });
    }
  };

  async function runPlanLoop(planId: string): Promise<void> {
    try {
      const activePlan = active.get(planId);
      if (!activePlan) return;
      const { steps, contextVariables, context, controller } = activePlan;

      emit(planId, { type: "plan.started", planId, stepCount: steps.length });

      // Plan-level approval gate.
      if (context.approvalMode === "ask") {
        emit(planId, { type: "plan.approval_required", planId });
        await new Promise<void>((resolve, reject) => {
          planApprovalGate.set(planId, { resolve, reject });
        });
        planApprovalGate.delete(planId);
      }

      let stepCursor = 0;
      while (stepCursor < steps.length) {
        if (controller.signal.aborted) {
          dependencies.store.updatePlanStatus(planId, "interrupted", Date.now());
          emit(planId, { type: "plan.interrupted", planId });
          return;
        }

        const step = steps[stepCursor]!;

        // Dependency check (future DAG support).
        if (step.dependsOn?.some((dep) => {
          const depStep = dependencies.store.getStep(dep);
          return !depStep || depStep.status !== "completed";
        })) {
          recordStep(planId, step, "skipped", {
            stepId: step.id,
            runId: "",
            status: "skipped",
            error: "dependency not completed",
          });
          stepCursor++;
          continue;
        }

        // Step-level approval gate.
        const stepApproval = step.approval ?? context.approvalMode;
        if (stepApproval === "ask") {
          recordStep(planId, step, "approval_required");
          emit(planId, { type: "step.approval_required", planId, stepId: step.id });

          // Wait for external approval via approve() or reject(). After the gate
          // resolves, fall through to execute this same step without re-checking.
          await new Promise<void>((resolve, reject) => {
            stepApprovalGate.set(planId, { resolve, reject });
          });
          stepApprovalGate.delete(planId);
        }

        recordStep(planId, step, "running");
        emit(planId, { type: "step.started", planId, stepId: step.id });

        // Intelligence Layer: classify, route, estimate cost before executing.
        let providerModel = step.providerModel;
        if (dependencies.intelligence?.enabled) {
          const decision = dependencies.intelligence.decide({
            text: step.text,
            messages: buildMessagesWithContext(step, contextVariables).map((m) => ({ content: typeof m.content === "string" ? m.content : null })),
            primaryModel: step.providerModel,
          });
          if (decision.route.candidates.length > 0) {
            providerModel = decision.route.candidates[0]!;
          }
          if (!decision.allowed) {
            recordStep(planId, step, "failed", {
              stepId: step.id,
              runId: "",
              status: "failed",
              error: decision.reason ?? "budget_exceeded",
            });
            emit(planId, { type: "step.failed", planId, stepId: step.id, error: decision.reason ?? "budget_exceeded" });
            dependencies.store.updatePlanStatus(planId, "failed", Date.now());
            emit(planId, { type: "plan.failed", planId, error: decision.reason ?? "budget_exceeded" });
            return;
          }
        }

        // Build engine request from step.
        const engineRequest: AgentRunRequest = {
          botId: step.grant.botId,
          threadId: step.grant.threadId,
          text: step.text,
          messages: buildMessagesWithContext(step, contextVariables),
          providerModel,
          grant: step.grant,
          capabilities: step.capabilities,
          signal: controller.signal,
          ...(step.budget ? { budget: step.budget } : {}),
        };

        const { runId, done: runDone } = await dependencies.engine.run(engineRequest);

        // Collect output from model delta events.
        let stepOutput = "";
        const unsubscribe = dependencies.engine.onEvent(engineRequest.threadId, (event: AgentEvent) => {
          if (event.type === "model.delta") {
            stepOutput += event.delta;
          }
        });

        await runDone;
        unsubscribe();

        const runRecord = dependencies.engine.getState(runId);
        const stepResult: PlanResult = {
          stepId: step.id,
          runId,
          status: runRecord?.status === "completed" ? "completed" : "failed",
          output: stepOutput.trim() || undefined,
          error: runRecord?.failureCode,
          modelRounds: runRecord?.modelRounds,
          toolCalls: runRecord?.toolCalls,
        };

        if (stepResult.output) {
          contextVariables.set(`step_${step.id}_output`, stepResult.output);
          emit(planId, { type: "context.variable.set", planId, key: `step_${step.id}_output`, value: stepResult.output });
        }

        recordStep(planId, step, stepResult.status, stepResult);
        if (stepResult.status === "completed") {
          emit(planId, { type: "step.completed", planId, stepId: step.id, runId });
        } else {
          emit(planId, { type: "step.failed", planId, stepId: step.id, error: stepResult.error ?? "unknown" });
        }

        if (stepResult.status === "failed") {
          // Stop plan on step failure.
          dependencies.store.updatePlanStatus(planId, "failed", Date.now());
          emit(planId, { type: "plan.failed", planId, error: stepResult.error ?? "step failed" });
          return;
        }

        stepCursor++;
      }

      dependencies.store.updatePlanStatus(planId, "completed", Date.now());
      emit(planId, { type: "plan.completed", planId });
    } catch (error) {
      dependencies.store.updatePlanStatus(planId, "failed", Date.now());
      emit(planId, { type: "plan.failed", planId, error: error instanceof Error ? error.message : String(error) });
    } finally {
      active.delete(planId);
      planApprovalGate.delete(planId);
      stepApprovalGate.delete(planId);
    }
  }

  function runPlan(steps: readonly PlanStep[], context: OrchestratorContext): { planId: PlanId; done: Promise<void> } {
    const planId = context.planId ?? randomUUID();
    const controller = new AbortController();
    const contextVariables = new Map(context.contextVariables);

    active.set(planId, { planId, controller, steps, contextVariables, context });

    dependencies.store.createPlan({
      planId,
      status: "running",
      steps: steps.map((s) => s.id),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      contextVariables,
    });

    const done = runPlanLoop(planId);

    return { planId, done };
  }

  function getPlanResults(planId: PlanId): readonly StepRecord[] | undefined {
    if (!dependencies.store.getPlan(planId)) return undefined;
    return dependencies.store.listSteps(planId);
  }

  function interrupt(planId: PlanId): void {
    active.get(planId)?.controller.abort();
  }

  function approve(planId: PlanId, _stepId?: StepId): void {
    const planGate = planApprovalGate.get(planId);
    if (planGate) {
      planGate.resolve();
      planApprovalGate.delete(planId);
      return;
    }
    const stepGate = stepApprovalGate.get(planId);
    if (stepGate) {
      stepGate.resolve();
      stepApprovalGate.delete(planId);
    }
  }

  function reject(planId: PlanId, _stepId?: StepId, reason?: string): void {
    const message = reason ?? "rejected";
    const planGate = planApprovalGate.get(planId);
    if (planGate) {
      planGate.reject(message);
      planApprovalGate.delete(planId);
    }
    const stepGate = stepApprovalGate.get(planId);
    if (stepGate) {
      stepGate.reject(message);
      stepApprovalGate.delete(planId);
    }
    active.get(planId)?.controller.abort(new DOMException(message, "AbortError"));
  }

  function onEvent(planId: string, listener: (event: OrchestrationEvent) => void): () => void {
    let set = listeners.get(planId);
    if (!set) {
      set = new Set();
      listeners.set(planId, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) listeners.delete(planId);
    };
  }

  return { engineId: dependencies.engine.engineId, runPlan, getPlanResults, interrupt, approve, reject, onEvent };
}
