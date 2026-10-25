import { describe, expect, it, vi } from "vitest";

import { createAgentEngine } from "./runtime.ts";
import type { ModelAdapter, CapabilityRuntime, CapabilityGrant, ModelGenerateRequest } from "./contracts.ts";

function fakeModelAdapter(toolCalls?: Array<{ id: string; name: string; arguments: unknown }>): ModelAdapter {
  let callCount = 0;
  return {
    providerId: "fake",
    async discoverModels() {
      return { default: "fake-model", options: [{ id: "fake-model", label: "Fake Model" }] };
    },
    capabilities() {
      return { tools: true, parallelTools: false, streaming: false, contextWindow: 128000, imageInput: false, imageOutput: false, structuredOutput: false };
    },
    async generate(_request: ModelGenerateRequest) {
      callCount++;
      if (toolCalls && callCount === 1) {
        return { text: "I will use a tool", toolCalls, finishReason: "tool_calls" };
      }
      return { text: "Final answer after tool", toolCalls: [], finishReason: "stop" };
    },
  };
}

function fakeCapabilityRuntime(tools: string[] = []): CapabilityRuntime {
  const invocations: string[] = [];
  return {
    list() {
      return tools.map((name) => ({ id: name, name, description: `Tool ${name}`, schema: { type: "object" }, risk: "read" as const, sideEffect: false, timeoutMs: 10000 }));
    },
    async invoke(call) {
      invocations.push(call.capabilityId);
      return { callId: call.callId, ok: true, content: `Result for ${call.capabilityId}` };
    },
    async cancel() {},
    invocations,
  } as any;
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
    const events: any[] = [];
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
    const events: any[] = [];
    const unsub = engine.onEvent("thread-1", (e) => events.push(e));
    const capRuntime = fakeCapabilityRuntime(["read_file"]);
    const { runId, done } = await engine.run({
      botId: "bot-1",
      threadId: "thread-1",
      text: "read a file",
      providerModel: { providerId: "fake", modelId: "fake-model" },
      modelAdapter: fakeModelAdapter([{ id: "call-1", name: "read_file", arguments: { path: "/tmp/test.txt" } }]),
      capabilityRuntime: capRuntime,
      grant,
      signal: new AbortController().signal,
    });
    await done;
    expect(runId).toBeTruthy();
    expect(events.some((e) => e.type === "tool.calls")).toBe(true);
    expect(events.some((e) => e.type === "tool.result")).toBe(true);
    expect(events.some((e) => e.type === "turn.completed" && e.ok === true)).toBe(true);
    expect((capRuntime as any).invocations).toContain("read_file");
    unsub();
  });

  it("handles model returning no tools gracefully", async () => {
    const engine = createAgentEngine();
    const events: any[] = [];
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