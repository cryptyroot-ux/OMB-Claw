import { describe, expect, it, vi } from "vitest";

import { createAgentEngine } from "./runtime.ts";
import type {
  AgentEvent,
  CapabilityCall,
  CapabilityGrant,
  CapabilityRuntime,
  ModelAdapter,
  ModelGenerateRequest,
  ModelToolCall,
} from "./contracts.ts";

interface FakeModelAdapter extends ModelAdapter {
  readonly requests: ModelGenerateRequest[];
}

function fakeModelAdapter(toolCalls?: ModelToolCall[], toolCallText = "I will use a tool"): FakeModelAdapter {
  let callCount = 0;
  const requests: ModelGenerateRequest[] = [];
  return {
    providerId: "fake",
    requests,
    async discoverModels() {
      return { default: "fake-model", options: [{ id: "fake-model", label: "Fake Model" }] };
    },
    capabilities() {
      return { tools: true, parallelTools: false, streaming: false, contextWindow: 128000, imageInput: false, imageOutput: false, structuredOutput: false };
    },
    async generate(request: ModelGenerateRequest) {
      requests.push(request);
      callCount++;
      if (toolCalls && callCount === 1) {
        return { text: toolCallText, toolCalls, finishReason: "tool_calls" };
      }
      return { text: "Final answer after tool", toolCalls: [], finishReason: "stop" };
    },
  };
}

function fakeCapabilityRuntime(tools: string[] = []): CapabilityRuntime & { invocations: string[] } {
  const invocations: string[] = [];
  return {
    list() {
      return tools.map((name) => ({ id: name, name, description: `Tool ${name}`, schema: { type: "object" }, risk: "read" as const, sideEffect: false, timeoutMs: 10000 }));
    },
    async invoke(call: CapabilityCall) {
      invocations.push(call.capabilityId);
      return { callId: call.callId, ok: true, content: `Result for ${call.capabilityId}` };
    },
    async cancel(_callId) {},
    invocations,
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
    const events: AgentEvent[] = [];
    const unsub = engine.onEvent("thread-1", (e) => events.push(e));
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
    expect(events.some((e) => e.type === "run.started")).toBe(true);
    expect(events.some((e) => e.type === "turn.completed")).toBe(true);
    unsub();
    fetchSpy.mockRestore();
  });

  it("executes a multi-step tool call and returns a final answer", async () => {
    const engine = createAgentEngine();
    const events: AgentEvent[] = [];
    const unsub = engine.onEvent("thread-1", (e) => events.push(e));
    const capRuntime = fakeCapabilityRuntime(["read_file"]);
    const modelAdapter = fakeModelAdapter([{ id: "call-1", name: "read_file", arguments: { path: "/tmp/test.txt" } }], "");
    const { runId, done } = await engine.run({
      botId: "bot-1",
      threadId: "thread-1",
      text: "read a file",
      providerModel: { providerId: "fake", modelId: "fake-model" },
      modelAdapter,
      capabilityRuntime: capRuntime,
      grant,
      signal: new AbortController().signal,
    });
    await done;
    expect(runId).toBeTruthy();
    expect(events.some((e) => e.type === "tool.calls")).toBe(true);
    expect(events.some((e) => e.type === "tool.result")).toBe(true);
    expect(events.some((e) => e.type === "turn.completed" && e.ok === true)).toBe(true);
    expect(capRuntime.invocations).toContain("read_file");
    expect(modelAdapter.requests[1]?.messages[1]).toMatchObject({
      role: "assistant",
      content: null,
      toolCalls: [{ id: "call-1", name: "read_file" }],
    });
    expect(engine.getState(runId)).toMatchObject({ status: "completed", modelRounds: 2, toolCalls: 1 });
    unsub();
  });

  it("handles model returning no tools gracefully", async () => {
    const engine = createAgentEngine();
    const events: AgentEvent[] = [];
    const unsub = engine.onEvent("thread-1", (e) => events.push(e));
    const { done } = await engine.run({
      botId: "bot-1",
      threadId: "thread-1",
      text: "hello",
      providerModel: { providerId: "fake", modelId: "fake-model" },
      modelAdapter: fakeModelAdapter(),
      capabilityRuntime: fakeCapabilityRuntime(),
      grant,
      signal: new AbortController().signal,
    });
    await done;
    expect(events.some((e) => e.type === "turn.completed" && e.ok === true)).toBe(true);
    unsub();
  });
});
