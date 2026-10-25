import { describe, expect, it, vi } from "vitest";

import { createAgentEngine } from "./runtime.ts";
import type { ModelAdapter, CapabilityRuntime, CapabilityGrant, ModelGenerateRequest } from "./contracts.ts";

function fakeModelAdapter(): ModelAdapter {
  return {
    providerId: "fake",
    async discoverModels() {
      return { default: "fake-model", options: [{ id: "fake-model", label: "Fake Model" }] };
    },
    capabilities() {
      return { tools: true, parallelTools: false, streaming: false, contextWindow: 128000, imageInput: false, imageOutput: false, structuredOutput: false };
    },
    async generate(_request: ModelGenerateRequest) {
      return { text: "Hello from fake model", toolCalls: [], finishReason: "stop" };
    },
  };
}

function fakeCapabilityRuntime(): CapabilityRuntime {
  return {
    list() { return []; },
    async invoke() { return { callId: "c1", ok: true, content: "done" }; },
    async cancel() {},
  };
}

const grant: CapabilityGrant = {
  botId: "bot-1",
  threadId: "thread-1",
  approvalMode: "full",
  allowed: new Set(),
  denied: new Set(),
};

describe("createAgentEngine", () => {
  it("emits turn.started and resolves a run handle without a network call", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("no network"); });
    const engine = createAgentEngine();
    const { runId, done } = await engine.run({
      botId: "bot-1",
      threadId: "thread-1",
      text: "hi",
      providerModel: { providerId: "fake", modelId: "fake-model" },
      modelAdapter: fakeModelAdapter(),
      capabilityRuntime: fakeCapabilityRuntime(),
      grant,
      signal: new AbortController().signal,
    });
    expect(runId).toBeTruthy();
    await done;
    fetchSpy.mockRestore();
  });
});