
import { appendNative } from "../drivers/native.ts";
import type { Budget } from "../routing/types.ts";
import type { ModelRouter } from "../routing/model-router.ts";
import { ModelRouter as ModelRouterImpl } from "../routing/model-router.ts";
import type { BudgetGuard } from "../routing/budget-guard.ts";
import { BudgetGuard as BudgetGuardImpl } from "../routing/budget-guard.ts";
import type { FallbackChain } from "../routing/fallback-chain.ts";
import { FallbackChain as FallbackChainImpl } from "../routing/fallback-chain.ts";

import { classifyTask } from "./task-classifier.ts";
import { isIntelligenceEnabled } from "./feature-flag.ts";
import type { TaskType } from "./task-classifier.ts";
import { Planner } from "./planner.ts";
import { Executor } from "./executor.ts";
import type { ToolRunner } from "./executor.ts";
import { Verifier } from "./verifier.ts";
import type { Plan, ExecutionResult, StepExecutionOutcome } from "./types.ts";
type ConfigStatus = Record<string, unknown>;

export interface IntelligenceLayerResult {
  completed: boolean;
  stepsCompleted: number;
  stepsFailed: number;
  error?: string;
  cost: number;
}

export interface IntelligenceLayerDeps {
  modelCaller?: (prompt: string) => Promise<string>;
  model?: (prompt: string) => Promise<string>;
  llm?: (prompt: string) => Promise<string>;
  callModel?: (prompt: string) => Promise<string>;
  toolRunner?: ToolRunner;
  tool?: ToolRunner;
  runTool?: ToolRunner;
  tools?: ToolRunner;

  taskClassifier?: (brief: string) => TaskType;
  classifier?: (brief: string) => TaskType;
  classifyTask?: (brief: string) => TaskType;

  planner?: Planner;
  executor?: Executor;
  verifier?: Verifier | ((prompt: string) => Promise<string>) | Record<string, unknown>;
  verifierModelCaller?: (prompt: string) => Promise<string>;
  verifierModel?: (prompt: string) => Promise<string>;

  modelRouter?: ModelRouter;
  router?: ModelRouter;
  ModelRouter?: ModelRouter;
  modelRouterConfig?: ConstructorParameters<typeof ModelRouterImpl>[0];
  routerConfig?: ConstructorParameters<typeof ModelRouterImpl>[0];

  budgetGuard?: BudgetGuard;
  budget?: BudgetGuard | Budget | number;
  budgetLimits?: ConstructorParameters<typeof BudgetGuardImpl>[0];
  limits?: ConstructorParameters<typeof BudgetGuardImpl>[0];

  fallbackChain?: FallbackChain;
  fallback?: FallbackChain;
  FallbackChain?: FallbackChain;
  fallbackExecutor?: (model: string, input: unknown) => Promise<unknown>;
  fallbackOptions?: ConstructorParameters<typeof FallbackChainImpl>[1];

  routingBudget?: Budget;
  modelBudget?: Budget;

  config?: unknown;
  threadId?: string;
}

type AnyRecord = Record<string, unknown>;

function asFunction(value: unknown): ((...args: any[]) => any) | undefined {
  return typeof value === "function" ? (value as (...args: any[]) => any) : undefined;
}

function pickFunction(deps: IntelligenceLayerDeps, names: string[]): ((...args: any[]) => any) | undefined {
  const record = deps as unknown as AnyRecord;
  for (const name of names) {
    const fn = asFunction(record[name]);
    if (fn) return fn;
  }
  return undefined;
}

function isBudgetGuard(value: unknown): value is BudgetGuard {
  return !!value && typeof value === "object" && typeof (value as AnyRecord).check === "function" && typeof (value as AnyRecord).record === "function";
}

export class IntelligenceLayer {
  private readonly deps: IntelligenceLayerDeps;
  private readonly modelCaller: ((prompt: string) => Promise<string>) | undefined;
  private readonly toolRunner: ToolRunner | undefined;
  private readonly classifier: (brief: string) => TaskType;
  private planner: Planner | undefined;
  private executor: Executor | undefined;
  private verifier: Verifier | undefined;
  private modelRouter: ModelRouter | undefined;
  private budgetGuard: BudgetGuard;
  private fallbackChain: FallbackChain | undefined;
  private routingBudget: Budget;

  constructor(deps: IntelligenceLayerDeps | ((prompt: string) => Promise<string>) = {}, toolRunner?: ToolRunner) {
    if (typeof deps === "function") {
      deps = { modelCaller: deps as (prompt: string) => Promise<string>, toolRunner };
    }
    deps = (deps ?? {}) as IntelligenceLayerDeps;
    if (toolRunner && !deps.toolRunner) deps.toolRunner = toolRunner;
    this.deps = deps;

    this.modelCaller =
      pickFunction(this.deps, ["modelCaller", "model", "llm", "callModel"]) as ((prompt: string) => Promise<string>) | undefined;

    this.toolRunner =
      (this.deps.toolRunner ?? this.deps.tool ?? this.deps.runTool ?? this.deps.tools) as ToolRunner | undefined;

    const classifierFn =
      this.deps.taskClassifier ?? this.deps.classifier ?? this.deps.classifyTask;
    this.classifier = typeof classifierFn === "function" ? classifierFn : classifyTask;

    // Planner
    if (this.deps.planner) {
      this.planner = this.deps.planner as Planner;
    }

    // Executor
    if (this.deps.executor) {
      this.executor = this.deps.executor as Executor;
    }

    // Verifier (resolve function or object, consistent with Executor)
    if (this.deps.verifier) {
      const v = this.deps.verifier;
      if (typeof v === "function") {
        this.verifier = new Verifier(v as (prompt: string) => Promise<string>);
      } else if (v && typeof v === "object") {
        const obj = v as unknown as AnyRecord;
        if (typeof obj.verify === "function") {
          this.verifier = v as Verifier;
        } else if (typeof obj.modelCaller === "function") {
          this.verifier = new Verifier(obj.modelCaller as (prompt: string) => Promise<string>);
        } else if (typeof obj.model === "function") {
          this.verifier = new Verifier(obj.model as (prompt: string) => Promise<string>);
        } else {
          this.verifier = new Verifier(v as unknown as (prompt: string) => Promise<string>);
        }
      }
    } else {
      const verifierCaller =
        pickFunction(this.deps, ["verifierModelCaller", "verifierModel"]) as ((prompt: string) => Promise<string>) | undefined;
      if (verifierCaller) {
        this.verifier = new Verifier(verifierCaller);
      }
    }

    // ModelRouter
    if (this.deps.modelRouter) {
      this.modelRouter = this.deps.modelRouter as ModelRouter;
    } else if (this.deps.router) {
      this.modelRouter = this.deps.router as ModelRouter;
    } else if (this.deps.ModelRouter) {
      this.modelRouter = this.deps.ModelRouter as ModelRouter;
    } else {
      const config = this.deps.modelRouterConfig ?? this.deps.routerConfig;
      if (config) {
        this.modelRouter = new ModelRouterImpl(config);
      }
    }

    // BudgetGuard
    if (this.deps.budgetGuard) {
      this.budgetGuard = this.deps.budgetGuard as BudgetGuard;
    } else {
    const budgetCandidate = this.deps.budget;
    if (isBudgetGuard(budgetCandidate)) {
      this.budgetGuard = budgetCandidate as BudgetGuard;
    } else if (this.deps.budgetLimits || this.deps.limits) {
      this.budgetGuard = new BudgetGuardImpl(this.deps.budgetLimits ?? this.deps.limits);
    } else if (typeof budgetCandidate === "number") {
      this.budgetGuard = new BudgetGuardImpl(budgetCandidate);
    } else if (budgetCandidate && typeof budgetCandidate === "object" && "maxCost" in (budgetCandidate as unknown as AnyRecord)) {
      // Treat as Budget, not guard; create default guard
      this.budgetGuard = new BudgetGuardImpl();
    } else {
      this.budgetGuard = new BudgetGuardImpl();
    }
    }
    // FallbackChain
    if (this.deps.fallbackChain) {
      this.fallbackChain = this.deps.fallbackChain as FallbackChain;
    } else if (this.deps.fallback) {
      this.fallbackChain = this.deps.fallback as FallbackChain;
    } else if (this.deps.FallbackChain) {
      this.fallbackChain = this.deps.FallbackChain as FallbackChain;
    } else if (this.deps.fallbackExecutor) {
      this.fallbackChain = new FallbackChainImpl(this.deps.fallbackExecutor, this.deps.fallbackOptions);
    }

    // Routing budget
    const rb = this.deps.routingBudget ?? this.deps.modelBudget;
    if (rb && typeof rb === "object" && "maxCost" in (rb as unknown as AnyRecord)) {
      this.routingBudget = rb as Budget;
    } else if (this.deps.budget && typeof this.deps.budget === "object" && "maxCost" in (this.deps.budget as unknown as AnyRecord)) {
      this.routingBudget = this.deps.budget as Budget;
    } else {
      this.routingBudget = { maxCost: Number.POSITIVE_INFINITY };
    }

    // Planner (lazy if modelCaller)
    if (!this.planner && this.modelCaller) {
      this.planner = new Planner(this.modelCaller, {
        modelRouter: this.modelRouter,
        budget: this.routingBudget,
      });
    }

    // Executor (lazy)
    if (!this.executor && this.toolRunner) {
      this.executor = new Executor(this.toolRunner, this.verifier);
    }
  }

  async process(brief: string, threadId: string = this.deps.threadId ?? ""): Promise<IntelligenceLayerResult> {
    const tid = threadId || "";
    // Feature flag gate: when a config is supplied and the layer is disabled, skip.
    if (this.deps.config != null && !isIntelligenceEnabled(this.deps.config as ConfigStatus | null | undefined)) {
      if (tid) appendNative(tid, { dir: "out", source: "feature-flag", msg: { enabled: false } });
      return { completed: false, stepsCompleted: 0, stepsFailed: 0, error: "intelligence layer disabled", cost: 0 };
    }
    let cost = 0;
    let assignment: ReturnType<ModelRouter["select"]> | undefined;

    try {
      // 1. classify
      const taskType = this.classifier(brief);
      if (tid) appendNative(tid, { dir: "out", source: "classifier", msg: { taskType } });

      // 2. route
      if (this.modelRouter) {
        try {
          assignment = this.modelRouter.select(taskType, this.routingBudget);
          cost += assignment?.primary?.estimatedCost ?? 0;
          if (tid) appendNative(tid, {
            dir: "out",
            source: "router",
            msg: { model: assignment?.primary?.model, fallbacks: assignment?.fallbacks },
          });

          // Budget check before model call
          const allowed = this.budgetGuard.check(assignment, tid);
          if (!allowed) {
            return { completed: false, stepsCompleted: 0, stepsFailed: 0, error: "budget exceeded", cost };
          }
          this.budgetGuard.record(assignment, tid);
        } catch (err) {
          // routing failure is non-fatal for planner if planner has no router
          if (tid) appendNative(tid, { dir: "out", source: "router", msg: { error: String(err) } });
        }
      }

      // 3. plan
      if (!this.planner) {
        throw new Error("No planner available");
      }
      const plan: Plan = await this.planner.plan(brief, taskType, tid);
      if (tid) appendNative(tid, { dir: "out", source: "planner", msg: { planId: plan.id, steps: plan.steps.length } });

      if (!this.executor) {
        throw new Error("No executor available");
      }

      // Ensure executor has verifier
      if (this.verifier && this.toolRunner) {
        // Rebuild executor with verifier if the current one lacks one
        this.executor = new Executor(this.toolRunner, this.verifier);
      }

      // 4. execute
      const execResult: ExecutionResult = await this.executor.execute(plan);

      // 5. verification logging
      for (const outcome of execResult.outcomes ?? execResult.steps ?? []) {
        const verification = (outcome as StepExecutionOutcome).verification;
        if (verification) {
          if (tid) appendNative(tid, {
            dir: "in",
            source: "verifier",
            msg: {
              stepId: outcome.stepId ?? outcome.id,
              verified: verification.verified,
              confidence: verification.confidence,
            },
          });
        }
      }

      // cost from plan metadata
      const planCost = typeof plan.metadata?.estimatedCost === "number" ? plan.metadata.estimatedCost : 0;
      if (planCost > 0) cost = planCost;

      const failed = execResult.failedSteps ?? 0;
      const completedSteps = execResult.completedSteps ?? 0;
      const success = execResult.success === true && failed === 0;

      // 6. fallback on failure
      if (!success && this.fallbackChain) {
        try {
          const chain = this.fallbackChain as unknown as { execute: (...args: any[]) => Promise<any> };
          await chain.execute(assignment ?? "", [], { threadId: tid });
        } catch {
          // ignore fallback failures
        }
      }

      let error: string | undefined;
      if (!success) {
        const firstFailed = (execResult.outcomes ?? execResult.steps ?? []).find((o: any) => o?.status === "failed" || o?.ok === false);
        error = (firstFailed as any)?.error ?? "execution failed";
      }

      return {
        completed: success,
        stepsCompleted: completedSteps,
        stepsFailed: failed,
        error,
        cost,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // If plan parsing failed, message from Planner is "Invalid plan"
      return {
        completed: false,
        stepsCompleted: 0,
        stepsFailed: 0,
        error: message,
        cost,
      };
    }
  }
}

// Barrel convenience
export default IntelligenceLayer;
