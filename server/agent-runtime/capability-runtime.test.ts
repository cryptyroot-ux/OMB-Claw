import { describe, expect, it } from "vitest";

import { InMemoryCapabilityRuntime } from "./capability-runtime.ts";
import type { CapabilityDescriptor, CapabilityGrant } from "./contracts.ts";

const grant: CapabilityGrant = {
  botId: "bot-1",
  threadId: "thread-1",
  approvalMode: "full",
  allowed: new Set(),
  denied: new Set(),
};

const restrictedGrant: CapabilityGrant = {
  botId: "bot-1",
  threadId: "thread-1",
  approvalMode: "full",
  allowed: new Set(["read_file"]),
  denied: new Set(["write_file"]),
};

describe("InMemoryCapabilityRuntime", () => {
  it("registers and lists capabilities", () => {
    const rt = new InMemoryCapabilityRuntime();
    const desc: CapabilityDescriptor = { id: "read_file", name: "read_file", description: "Read a file", schema: { type: "object" }, risk: "read", sideEffect: false, timeoutMs: 10000 };
    rt.register(desc, async (call) => ({ callId: call.callId, ok: true, content: "file contents" }));
    const listed = rt.list({ botId: "bot-1", threadId: "thread-1", grant });
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe("read_file");
  });

  it("invokes a registered capability", async () => {
    const rt = new InMemoryCapabilityRuntime();
    const desc: CapabilityDescriptor = { id: "read_file", name: "read_file", description: "Read a file", schema: { type: "object" }, risk: "read", sideEffect: false, timeoutMs: 10000 };
    rt.register(desc, async (call) => ({ callId: call.callId, ok: true, content: "file contents" }));
    const result = await rt.invoke({ callId: "c1", capabilityId: "read_file", arguments: {}, botId: "bot-1", threadId: "thread-1" }, { grant, signal: new AbortController().signal });
    expect(result.ok).toBe(true);
    expect(result.content).toBe("file contents");
  });

  it("returns error for unknown capability", async () => {
    const rt = new InMemoryCapabilityRuntime();
    const result = await rt.invoke({ callId: "c1", capabilityId: "unknown", arguments: {}, botId: "bot-1", threadId: "thread-1" }, { grant, signal: new AbortController().signal });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("unknown_capability");
  });

  it("respects allow/deny grants", async () => {
    const rt = new InMemoryCapabilityRuntime();
    const readDesc: CapabilityDescriptor = { id: "read_file", name: "read_file", description: "Read", schema: {}, risk: "read", sideEffect: false, timeoutMs: 10000 };
    const writeDesc: CapabilityDescriptor = { id: "write_file", name: "write_file", description: "Write", schema: {}, risk: "write", sideEffect: true, timeoutMs: 10000 };
    rt.register(readDesc, async (call) => ({ callId: call.callId, ok: true, content: "read" }));
    rt.register(writeDesc, async (call) => ({ callId: call.callId, ok: true, content: "write" }));

    const listed = rt.list({ botId: "bot-1", threadId: "thread-1", grant: restrictedGrant });
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe("read_file");

    const writeResult = await rt.invoke({ callId: "c2", capabilityId: "write_file", arguments: {}, botId: "bot-1", threadId: "thread-1" }, { grant: restrictedGrant, signal: new AbortController().signal });
    expect(writeResult.ok).toBe(false);
    expect(writeResult.error).toBe("denied");
  });
});