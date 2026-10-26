import { describe, expect, it } from "vitest";

import { createAgentEngine } from "./runtime.ts";
import type {
  AgentEvent,
  AgentRunRecord,
  AgentRunStore,
  CapabilityCallStatus,
  CapabilityDescriptor,
  CapabilityGrant,
  CapabilitySession,
  ModelAdapter,
  ModelAdapterError,
  ModelAdapterRegistry,
  ModelCapabilities,
  ModelEvent,
  ModelGenerateRequest,
  ModelMessage,
} from "./contracts.ts";

interface TestRunStore extends AgentRunStore {
  readonly runs: Map<string, AgentRunRecord>;
  readonly calls: Map<string, { readonly status: CapabilityCallStatus }>;
}

function testRunStore(): TestRunStore {
  const runs = new Map<string, AgentRunRecord>();
  const calls = new Map<string, { readonly status: CapabilityCallStatus }>();
  return {
    runs,
    calls,
    createRun(record) {
      runs.set(record.runId, record);
    },
    getRun(runId) {
      return runs.get(runId);
    },
    updateRunProgress(runId, progress) {
      const current = runs.get(runId);
      if (current) runs.set(runId, { ...current, ...progress });
    },
    transitionRun(runId, expected, next, updatedAt, failureCode) {
      const current = runs.get(runId);
      if (!current || current.status !== expected) return false;
      runs.set(runId, { ...current, status: next, updatedAt, ...(failureCode ? { failureCode } : {}) });
      return true;
    },
    beginCapabilityCall(record) {
      calls.set(`${record.runId}:${record.callId}`, { status: record.status });
    },
    settleCapabilityCall(runId, callId, status) {
      calls.set(`${runId}:${callId}`, { status });
    },
    recoverUnsettledRuns() {},
  };
}

const supportedCapabilities: ModelCapabilities = {
  tools: "supported",
  parallelTools: "supported",
  streaming: "supported",
  contextWindow: { status: "known", value: 128_000 },
  imageInput: "unsupported",
  imageOutput: "unsupported",
  audioInput: "unsupported",
  audioOutput: "unsupported",
  structuredOutput: "supported",
  toolSchemaLimit: { status: "known", value: 64_000 },
};

function descriptor(id: string): CapabilityDescriptor {
  return {
    id,
    name: id,
    description: `Fixture capability ${id}`,
    schema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
    risk: "read",
    sideEffect: false,
    timeoutMs: 5_000,
  };
}

interface TestCapabilitySession extends CapabilitySession {
  readonly validations: string[];
  readonly invocations: string[];
  readonly closeCount: number;
}

function testCapabilitySession(
  descriptors: readonly CapabilityDescriptor[],
  invalidCallIds: ReadonlySet<string> = new Set(),
  uncertainCallIds: ReadonlySet<string> = new Set(),
  throwingCallIds: ReadonlySet<string> = new Set(),
  imageCallIds: ReadonlySet<string> = new Set(),
): TestCapabilitySession {
  const validations: string[] = [];
  const invocations: string[] = [];
  let closeCount = 0;
  return {
    validations,
    invocations,
    get closeCount() { return closeCount; },
    list(grant) {
      return descriptors.filter((item) => grant.allowed.has(item.id) && !grant.denied.has(item.id));
    },
    validate(call) {
      validations.push(call.callId);
      if (!descriptors.some((item) => item.id === call.capabilityId)) throw new Error("unknown capability");
      if (invalidCallIds.has(call.callId)) throw new Error("invalid fixture arguments");
    },
    async invoke(call, { grant, signal }) {
      signal.throwIfAborted();
      if (grant.denied.has(call.capabilityId) || !grant.allowed.has(call.capabilityId)) {
        return { callId: call.callId, ok: false, content: "denied", error: "denied" };
      }
      invocations.push(call.callId);
      if (throwingCallIds.has(call.callId)) throw new Error("fixture lost the result after dispatch");
      if (uncertainCallIds.has(call.callId)) return { callId: call.callId, ok: false, content: "result uncertain", error: "uncertain", uncertain: true };
      if (imageCallIds.has(call.callId)) return { callId: call.callId, ok: true, content: "Screenshot captured", images: [{ mimeType: "image/png", data: "fixture" }] };
      return { callId: call.callId, ok: true, content: `Result for ${call.capabilityId}` };
    },
    async close() {
      closeCount++;
    },
  };
}

interface TestModelAdapter extends ModelAdapter {
  readonly requests: ModelGenerateRequest[];
}

function testModelAdapter(
  rounds: ReadonlyArray<ReadonlyArray<ModelEvent>>,
  modelCapabilities: ModelCapabilities = supportedCapabilities,
): TestModelAdapter {
  const requests: ModelGenerateRequest[] = [];
  return {
    providerId: "fixture",
    requests,
    async discoverModels() {
      return { default: "fixture-model", options: [{ id: "fixture-model", label: "Fixture Model" }] };
    },
    capabilities() {
      return modelCapabilities;
    },
    async *generate(request) {
      const round = requests.length;
      requests.push(request);
      for (const event of rounds[round] ?? []) yield event;
    },
  };
}

function registryFor(adapter: ModelAdapter): ModelAdapterRegistry {
  return { resolve: () => adapter };
}

class FixtureModelAdapterError extends Error implements ModelAdapterError {
  readonly code: ModelAdapterError["code"];
  readonly retryable: boolean;
  readonly retrySafe: boolean;
  readonly requestStarted: boolean;

  constructor(
    message: string,
    code: ModelAdapterError["code"],
    retryable: boolean,
    retrySafe: boolean,
    requestStarted: boolean,
  ) {
    super(message);
    this.code = code;
    this.retryable = retryable;
    this.retrySafe = retrySafe;
    this.requestStarted = requestStarted;
  }
}

const grant: CapabilityGrant = {
  botId: "bot-1",
  threadId: "thread-1",
  approvalMode: "full",
  allowed: new Set(["read-a", "read-b"]),
  denied: new Set(),
};

const userMessages: ReadonlyArray<ModelMessage> = [{ role: "system", content: "Use only the supplied fixture tools." }];

describe("createAgentEngine", () => {
  it("runs two tool rounds and returns a final answer", async () => {
    const modelAdapter = testModelAdapter([
      [
        { type: "tool_calls", calls: [{ id: "call-a", name: "read-a", arguments: { value: "a" } }] },
        { type: "completed", finishReason: "tool_calls" },
      ],
      [
        { type: "tool_calls", calls: [{ id: "call-b", name: "read-b", arguments: { value: "b" } }] },
        { type: "completed", finishReason: "tool_calls" },
      ],
      [
        { type: "content.delta", kind: "assistant_text", delta: "Both fixture values are verified." },
        { type: "completed", finishReason: "stop" },
      ],
    ]);
    const capabilities = testCapabilitySession([descriptor("read-a"), descriptor("read-b")]);
    const store = testRunStore();
    const engine = createAgentEngine({ adapters: registryFor(modelAdapter), store });
    const events: AgentEvent[] = [];
    const unsubscribe = engine.onEvent("thread-1", (event) => events.push(event));

    const { runId, done } = await engine.run({
      botId: "bot-1",
      threadId: "thread-1",
      text: "Read two fixture values.",
      messages: userMessages,
      providerModel: { providerId: "fixture", modelId: "fixture-model" },
      grant,
      capabilities,
      signal: new AbortController().signal,
    });
    await done;

    expect(modelAdapter.requests).toHaveLength(3);
    expect(modelAdapter.requests[1]?.messages).toContainEqual(expect.objectContaining({ role: "tool", toolCallId: "call-a" }));
    expect(modelAdapter.requests[2]?.messages).toContainEqual(expect.objectContaining({ role: "tool", toolCallId: "call-b" }));
    expect(capabilities.invocations).toEqual(["call-a", "call-b"]);
    expect(store.getRun(runId)).toMatchObject({ status: "completed", modelRounds: 3, toolCalls: 2 });
    expect(events.map((event) => event.type)).toEqual([
      "run.started",
      "tool.calls",
      "tool.result",
      "tool.calls",
      "tool.result",
      "model.delta",
      "turn.completed",
    ]);
    expect(capabilities.closeCount).toBe(1);
    unsubscribe();
  });

  it("blocks unknown model tool capability before the first model request", async () => {
    const unknownCapabilities: ModelCapabilities = { ...supportedCapabilities, tools: "unknown" };
    const modelAdapter = testModelAdapter([], unknownCapabilities);
    const capabilities = testCapabilitySession([descriptor("read-a")]);
    const store = testRunStore();
    const engine = createAgentEngine({ adapters: registryFor(modelAdapter), store });

    const { runId, done } = await engine.run({
      botId: "bot-1",
      threadId: "thread-1",
      text: "Read a fixture value.",
      messages: userMessages,
      providerModel: { providerId: "fixture", modelId: "unknown-tools" },
      grant,
      capabilities,
      signal: new AbortController().signal,
    });
    await done;

    expect(modelAdapter.requests).toHaveLength(0);
    expect(capabilities.invocations).toEqual([]);
    expect(store.getRun(runId)).toMatchObject({ status: "failed", failureCode: "unsupported_capability" });
  });

  it("rejects an invalid tool batch before any side effect", async () => {
    const batches = [
      {
        calls: [
          { id: "call-a", name: "read-a", arguments: { value: "a" } },
          { id: "call-b", name: "read-b", arguments: { value: "b" } },
        ],
        invalidCallIds: new Set(["call-b"]),
      },
      {
        calls: [
          { id: "same-id", name: "read-a", arguments: { value: "a" } },
          { id: "same-id", name: "read-b", arguments: { value: "b" } },
        ],
        invalidCallIds: new Set<string>(),
      },
      {
        calls: Array.from({ length: 201 }, (_, index) => ({
          id: `call-${index}`,
          name: "read-a",
          arguments: { value: String(index) },
        })),
        invalidCallIds: new Set<string>(),
      },
    ];

    for (const batch of batches) {
      const modelAdapter = testModelAdapter([[
        { type: "tool_calls", calls: batch.calls },
        { type: "completed", finishReason: "tool_calls" },
      ]]);
      const capabilities = testCapabilitySession([descriptor("read-a"), descriptor("read-b")], batch.invalidCallIds);
      const store = testRunStore();
      const engine = createAgentEngine({ adapters: registryFor(modelAdapter), store });
      const { runId, done } = await engine.run({
        botId: "bot-1",
        threadId: "thread-1",
        text: "Read fixture values.",
        messages: userMessages,
        providerModel: { providerId: "fixture", modelId: "fixture-model" },
        grant,
        capabilities,
        signal: new AbortController().signal,
      });
      await done;

      expect(capabilities.invocations).toEqual([]);
      expect(store.getRun(runId)).toMatchObject({ status: "failed" });
    }
  });

  it("retries a transient model error only before visible output", async () => {
    const requests: ModelGenerateRequest[] = [];
    let attempts = 0;
    const modelAdapter: TestModelAdapter = {
      ...testModelAdapter([]),
      requests,
      async *generate(request) {
        requests.push(request);
        attempts++;
        if (attempts === 1) throw new FixtureModelAdapterError("temporary refusal", "transient", true, true, false);
        yield { type: "content.delta", kind: "assistant_text", delta: "Recovered answer." };
        yield { type: "completed", finishReason: "stop" };
      },
    };
    const capabilities = testCapabilitySession([]);
    const store = testRunStore();
    const engine = createAgentEngine({ adapters: registryFor(modelAdapter), store });
    const { runId, done } = await engine.run({
      botId: "bot-1",
      threadId: "thread-1",
      text: "Answer safely.",
      messages: userMessages,
      providerModel: { providerId: "fixture", modelId: "fixture-model" },
      grant,
      capabilities,
      signal: new AbortController().signal,
    });
    await done;

    expect(requests).toHaveLength(2);
    expect(store.getRun(runId)).toMatchObject({ status: "completed", modelRounds: 2 });
  });

  it("does not retry a transient model error after visible output", async () => {
    const requests: ModelGenerateRequest[] = [];
    const modelAdapter: TestModelAdapter = {
      ...testModelAdapter([]),
      requests,
      async *generate(request) {
        requests.push(request);
        yield { type: "content.delta", kind: "assistant_text", delta: "Partial answer." };
        throw new FixtureModelAdapterError("connection dropped", "transient", true, false, true);
      },
    };
    const capabilities = testCapabilitySession([]);
    const store = testRunStore();
    const engine = createAgentEngine({ adapters: registryFor(modelAdapter), store });
    const { runId, done } = await engine.run({
      botId: "bot-1",
      threadId: "thread-1",
      text: "Answer safely.",
      messages: userMessages,
      providerModel: { providerId: "fixture", modelId: "fixture-model" },
      grant,
      capabilities,
      signal: new AbortController().signal,
    });
    await done;

    expect(requests).toHaveLength(1);
    expect(store.getRun(runId)).toMatchObject({ status: "failed", modelRounds: 1 });
  });

  it("stops before retry when interrupted during backoff", async () => {
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
    let requests = 0;
    const modelAdapter: TestModelAdapter = {
      ...testModelAdapter([]),
      requests: [],
      generate(request) {
        requests++;
        request.signal.throwIfAborted();
        notifyStarted();
        return {
          [Symbol.asyncIterator]() {
            return {
              next: async (): Promise<IteratorResult<ModelEvent>> => {
                throw new FixtureModelAdapterError("temporary refusal", "transient", true, true, false);
              },
            };
          },
        };
      },
    };
    const capabilities = testCapabilitySession([]);
    const store = testRunStore();
    const engine = createAgentEngine({ adapters: registryFor(modelAdapter), store });
    const { runId, done } = await engine.run({
      botId: "bot-1",
      threadId: "thread-1",
      text: "Answer safely.",
      messages: userMessages,
      providerModel: { providerId: "fixture", modelId: "fixture-model" },
      grant,
      capabilities,
      signal: new AbortController().signal,
    });
    await started;
    await engine.interrupt(runId);
    await done;

    expect(requests).toBe(1);
    expect(store.getRun(runId)).toMatchObject({ status: "interrupted" });
  });

  it("marks uncertain capability results recovery required without replay", async () => {
    const modelAdapter = testModelAdapter([[
      { type: "tool_calls", calls: [{ id: "call-uncertain", name: "read-a", arguments: { value: "a" } }] },
      { type: "completed", finishReason: "tool_calls" },
    ], [
      { type: "content.delta", kind: "assistant_text", delta: "Do not repeat." },
      { type: "completed", finishReason: "stop" },
    ]]);
    const capabilities = testCapabilitySession([descriptor("read-a")], new Set(), new Set(["call-uncertain"]));
    const store = testRunStore();
    const engine = createAgentEngine({ adapters: registryFor(modelAdapter), store });
    const events: AgentEvent[] = [];
    engine.onEvent("thread-1", (event) => events.push(event));

    const { runId, done } = await engine.run({
      botId: "bot-1",
      threadId: "thread-1",
      text: "Run the fixture operation once.",
      messages: userMessages,
      providerModel: { providerId: "fixture", modelId: "fixture-model" },
      grant,
      capabilities,
      signal: new AbortController().signal,
    });
    await done;

    expect(capabilities.invocations).toEqual(["call-uncertain"]);
    expect(modelAdapter.requests).toHaveLength(1);
    expect(store.calls.get(`${runId}:call-uncertain`)).toMatchObject({ status: "recovery_required" });
    expect(store.getRun(runId)).toMatchObject({ status: "recovery_required" });
    expect(events.some((event) => event.type === "run.recovery_required")).toBe(true);
  });

  it("fails closed when a dispatched capability throws", async () => {
    const modelAdapter = testModelAdapter([[
      { type: "tool_calls", calls: [{ id: "call-throws", name: "read-a", arguments: { value: "a" } }] },
      { type: "completed", finishReason: "tool_calls" },
    ], [
      { type: "content.delta", kind: "assistant_text", delta: "Do not retry." },
      { type: "completed", finishReason: "stop" },
    ]]);
    const capabilities = testCapabilitySession([descriptor("read-a")], new Set(), new Set(), new Set(["call-throws"]));
    const store = testRunStore();
    const engine = createAgentEngine({ adapters: registryFor(modelAdapter), store });
    const { runId, done } = await engine.run({
      botId: "bot-1",
      threadId: "thread-1",
      text: "Run the fixture operation once.",
      messages: userMessages,
      providerModel: { providerId: "fixture", modelId: "fixture-model" },
      grant,
      capabilities,
      signal: new AbortController().signal,
    });
    await done;

    expect(capabilities.invocations).toEqual(["call-throws"]);
    expect(modelAdapter.requests).toHaveLength(1);
    expect(store.calls.get(`${runId}:call-throws`)).toMatchObject({ status: "recovery_required" });
    expect(store.getRun(runId)).toMatchObject({ status: "recovery_required" });
  });

  it("fails closed when a capability returns images the model cannot receive", async () => {
    const modelAdapter = testModelAdapter([[
      { type: "tool_calls", calls: [{ id: "call-image", name: "read-a", arguments: { value: "a" } }] },
      { type: "completed", finishReason: "tool_calls" },
    ], [
      { type: "content.delta", kind: "assistant_text", delta: "Should not run." },
      { type: "completed", finishReason: "stop" },
    ]]);
    const capabilities = testCapabilitySession([descriptor("read-a")], new Set(), new Set(), new Set(), new Set(["call-image"]));
    const store = testRunStore();
    const engine = createAgentEngine({ adapters: registryFor(modelAdapter), store });
    const { runId, done } = await engine.run({
      botId: "bot-1",
      threadId: "thread-1",
      text: "Take a screenshot.",
      messages: userMessages,
      providerModel: { providerId: "fixture", modelId: "fixture-model" },
      grant,
      capabilities,
      signal: new AbortController().signal,
    });
    await done;

    expect(modelAdapter.requests).toHaveLength(1);
    expect(store.getRun(runId)).toMatchObject({ status: "failed", failureCode: "unsupported_capability" });
  });

  it("interrupts without retry after visible output", async () => {
    let signalSeen: AbortSignal | undefined;
    let deltaResolved!: () => void;
    const deltaSeen = new Promise<void>((resolve) => { deltaResolved = resolve; });
    const requests: ModelGenerateRequest[] = [];
    const modelAdapter: TestModelAdapter = {
      ...testModelAdapter([]),
      requests,
      async *generate(request) {
        requests.push(request);
        signalSeen = request.signal;
        yield { type: "content.delta", kind: "assistant_text", delta: "Partial answer" };
        deltaResolved();
        await new Promise<void>((resolve) => request.signal.addEventListener("abort", () => resolve(), { once: true }));
        request.signal.throwIfAborted();
        yield { type: "completed", finishReason: "stop" };
      },
    };
    const capabilities = testCapabilitySession([descriptor("read-a")]);
    const store = testRunStore();
    const engine = createAgentEngine({ adapters: registryFor(modelAdapter), store });
    const { runId, done } = await engine.run({
      botId: "bot-1",
      threadId: "thread-1",
      text: "Start a long answer.",
      messages: userMessages,
      providerModel: { providerId: "fixture", modelId: "fixture-model" },
      grant,
      capabilities,
      signal: new AbortController().signal,
    });
    const completedBeforeDelta = await Promise.race([deltaSeen.then(() => false), done.then(() => true)]);
    expect(completedBeforeDelta).toBe(false);
    expect(signalSeen?.aborted).toBe(false);

    await engine.interrupt(runId);
    await done;

    expect(requests).toHaveLength(1);
    expect(store.getRun(runId)).toMatchObject({ status: "interrupted" });
    expect(capabilities.invocations).toEqual([]);
    expect(signalSeen?.aborted).toBe(true);
  });
});
