import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { AgentRunRecord } from "./contracts.ts";

const dataDir = mkdtempSync(join(tmpdir(), "omb-agent-runs-"));
process.env.OMB_DATA_DIR = dataDir;

const { createSqliteAgentRunStore } = await import("./run-store.ts");
const { closeMessageDb, readAgentCapabilityCall } = await import("../message-db.ts");

const run = (runId: string, status: AgentRunRecord["status"] = "running"): AgentRunRecord => ({
  runId,
  botId: "bot-1",
  threadId: "thread-1",
  engineId: "omb-native",
  providerModel: { providerId: "fixture", modelId: "fixture-model" },
  status,
  startedAt: 1_000,
  updatedAt: 1_000,
  modelRounds: 0,
  toolCalls: 0,
});

afterAll(() => {
  closeMessageDb();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("createSqliteAgentRunStore", () => {
  it("persists run transitions and progress across a database reopen", () => {
    const store = createSqliteAgentRunStore();
    store.createRun(run("run-1"));

    store.updateRunProgress("run-1", { modelRounds: 2, toolCalls: 1, updatedAt: 1_100 });
    expect(store.transitionRun("run-1", "running", "completed", 1_200)).toBe(true);
    expect(store.transitionRun("run-1", "running", "failed", 1_300)).toBe(false);

    closeMessageDb();
    const reopened = createSqliteAgentRunStore();
    expect(reopened.getRun("run-1")).toMatchObject({
      runId: "run-1",
      status: "completed",
      updatedAt: 1_200,
      modelRounds: 2,
      toolCalls: 1,
    });
  });

  it("marks in-flight capability calls recovery required on store reopen", () => {
    const store = createSqliteAgentRunStore();
    store.createRun(run("run-2"));
    store.beginCapabilityCall({
      runId: "run-2",
      callId: "call-1",
      capabilityId: "write_file",
      risk: "write",
      status: "dispatching",
      startedAt: 2_000,
    });

    closeMessageDb();
    const reopened = createSqliteAgentRunStore();
    const recovered = readAgentCapabilityCall("run-2", "call-1");

    expect(reopened.getRun("run-2")).toMatchObject({ status: "recovery_required", failureCode: "uncertain_side_effect" });
    expect(recovered).toMatchObject({ status: "recovery_required" });
    expect(recovered?.settledAt).toEqual(expect.any(Number));

    reopened.recoverUnsettledRuns(4_000);
    expect(readAgentCapabilityCall("run-2", "call-1")).toMatchObject({
      status: "recovery_required",
      settledAt: recovered?.settledAt,
    });
  });

  it("marks an orphaned model run interrupted on store reopen", () => {
    const store = createSqliteAgentRunStore();
    store.createRun(run("run-3"));

    closeMessageDb();
    const reopened = createSqliteAgentRunStore();

    expect(reopened.getRun("run-3")).toMatchObject({ status: "interrupted", failureCode: "process_restarted" });
  });
});
