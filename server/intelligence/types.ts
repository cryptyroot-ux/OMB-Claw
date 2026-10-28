// server/intelligence/types.ts

import type { ModelAssignment } from "../routing/types.ts";

export type PlanStatus = "pending" | "executing" | "verifying" | "completed" | "failed";

export type PlanStepType = "tool" | "think" | "delegate" | "verify";

export interface PlanStep {
  id: string;
  description: string;
  type: PlanStepType;
  assignedAgent?: string;
  dependencies: string[];
  expectedTools: string[];
  successCriteria: string;
  result?: unknown;
  verified?: boolean;
}

export interface Plan {
  id: string;
  threadId: string;
  goal: string;
  steps: PlanStep[];
  metadata: {
    estimatedCost: number;
    estimatedDuration: number;
    requiredCapabilities: string[];
    modelAssignments: Record<string, ModelAssignment>;
  };
  status: PlanStatus;
}

export interface VerificationResult {
  verified: boolean;
  evidence: string;
  confidence: number;
  reworkSuggestions?: string[];
}

export type StepExecutionStatus = "completed" | "failed" | "skipped";

export interface StepExecutionOutcome {
  stepId: string;
  id: string;
  status: StepExecutionStatus;
  ok: boolean;
  result?: unknown;
  output?: unknown;
  verification?: VerificationResult;
  verified?: boolean;
  error?: string;
  skippedReason?: string;
}

export interface ExecutionResult {
  planId: string;
  threadId: string;
  completedSteps: number;
  failedSteps: number;
  skippedSteps: number;
  totalSteps: number;
  success: boolean;
  ok: boolean;
  outcomes: StepExecutionOutcome[];
  stepResults: StepExecutionOutcome[];
  results: StepExecutionOutcome[];
  steps: StepExecutionOutcome[];
}
