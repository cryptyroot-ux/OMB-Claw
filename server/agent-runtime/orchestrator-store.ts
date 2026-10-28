import {
  insertOrchestratorPlan,
  listOrchestratorSteps,
  readOrchestratorPlan,
  readOrchestratorStep,
  recoverUnsettledOrchestratorPlans,
  insertOrchestratorStep,
  updateOrchestratorPlanStatus,
  updateOrchestratorStepStatus,
} from "../message-db.ts";
import type {
  OrchestratorStore,
  PlanRecord,
  PlanResult,
  PlanStatus,
  StepRecord,
  StepStatus,
} from "./contracts.ts";

export function createOrchestratorStore(options: { recoverAt?: number } = {}): OrchestratorStore {
  recoverUnsettledOrchestratorPlans(options.recoverAt ?? Date.now());
  return {
    createPlan(record: PlanRecord): void {
      insertOrchestratorPlan(record);
    },
    getPlan(planId: string): PlanRecord | undefined {
      return readOrchestratorPlan(planId);
    },
    updatePlanStatus(planId: string, status: PlanStatus, updatedAt: number): boolean {
      return updateOrchestratorPlanStatus(planId, status, updatedAt);
    },
    createStep(record: StepRecord): void {
      insertOrchestratorStep(record);
    },
    getStep(stepId: string): StepRecord | undefined {
      return readOrchestratorStep(stepId);
    },
    updateStepStatus(stepId: string, status: StepStatus, updatedAt: number, result?: PlanResult): boolean {
      return updateOrchestratorStepStatus(stepId, status, updatedAt, result);
    },
    listSteps(planId: string): StepRecord[] {
      return listOrchestratorSteps(planId);
    },
    recoverUnsettledPlans(now: number): void {
      recoverUnsettledOrchestratorPlans(now);
    },
  };
}
