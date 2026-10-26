import {
  insertAgentCapabilityCall,
  insertAgentCompaction,
  insertAgentRun,
  readAgentRun,
  recoverUnsettledAgentRuns,
  transitionAgentRun,
  updateAgentCapabilityCall,
  updateAgentRunProgress,
} from "../message-db.ts";
import type {
  AgentCapabilityCallRecord,
  AgentRunRecord,
  AgentRunStatus,
  AgentRunStore,
  CapabilityCallStatus,
} from "./contracts.ts";

export function createSqliteAgentRunStore(options: { recoverAt?: number } = {}): AgentRunStore {
  recoverUnsettledAgentRuns(options.recoverAt ?? Date.now());
  return {
    createRun(record: AgentRunRecord): void {
      insertAgentRun(record);
    },
    getRun(runId: string): AgentRunRecord | undefined {
      return readAgentRun(runId);
    },
    updateRunProgress(runId, progress): void {
      updateAgentRunProgress(runId, progress);
    },
    transitionRun(runId: string, expected: AgentRunStatus, next: AgentRunStatus, updatedAt: number, failureCode?: string): boolean {
      return transitionAgentRun(runId, expected, next, updatedAt, failureCode);
    },
    beginCapabilityCall(record: AgentCapabilityCallRecord): void {
      insertAgentCapabilityCall(record);
    },
    settleCapabilityCall(runId: string, callId: string, status: CapabilityCallStatus, settledAt: number): void {
      updateAgentCapabilityCall(runId, callId, status, settledAt);
    },
    recoverUnsettledRuns(now: number): void {
      recoverUnsettledAgentRuns(now);
    },
    recordCompaction(record): void {
      insertAgentCompaction(record);
    },
  };
}
