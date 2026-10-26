import { describe, expect, it } from "vitest";

import { createRunScopedCapabilitySession, InMemoryCapabilitySession } from "./capability-runtime.ts";
import type { AgentRunStore, AgentToolOutputRecord, CapabilityCall, CapabilityDescriptor, CapabilityGrant } from "./contracts.ts";

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

const descriptor = (id: string, overrides: Partial<CapabilityDescriptor> = {}): CapabilityDescriptor => ({
  id,
  name: id,
  description: `Fixture capability ${id}`,
  schema: { type: "object" },
  risk: "read",
  sideEffect: false,
  timeoutMs: 10_000,
  ...overrides,
});

const call = (callId: string, capabilityId: string): CapabilityCall => ({
  runId: "run-1",
  callId,
  capabilityId,
  arguments: {},
  botId: "bot-1",
  threadId: "thread-1",
});

describe("InMemoryCapabilitySession", () => {
  it("lists only granted capabilities", () => {
    const session = new InMemoryCapabilitySession();
    session.register(descriptor("read_file"), async (invoked) => ({ callId: invoked.callId, ok: true, content: "read" }));
    session.register(descriptor("write_file", { risk: "write", sideEffect: true }), async (invoked) => ({ callId: invoked.callId, ok: true, content: "write" }));

    expect(session.list(restrictedGrant).map((item) => item.id)).toEqual(["read_file"]);
    expect(session.list(grant).map((item) => item.id)).toEqual(["read_file", "write_file"]);
  });

  it("validates before invocation", () => {
    const session = new InMemoryCapabilitySession();
    session.register(descriptor("read_file"), async (invoked) => ({ callId: invoked.callId, ok: true, content: "read" }));

    expect(() => session.validate(call("c1", "unknown"), grant)).toThrow("Unknown capability: unknown");
    expect(() => session.validate(call("c2", "read_file"), restrictedGrant)).not.toThrow();
  });

  it("refuses out-of-scope calls", async () => {
    const session = new InMemoryCapabilitySession();
    session.register(descriptor("write_file", { risk: "write", sideEffect: true }), async (invoked) => ({ callId: invoked.callId, ok: true, content: "write" }));

    const result = await session.invoke(call("c1", "write_file"), { grant: restrictedGrant, signal: new AbortController().signal });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("denied");
  });

  it("closes the capability session and refuses later invocation", async () => {
    const session = new InMemoryCapabilitySession();
    session.register(descriptor("read_file"), async (invoked) => ({ callId: invoked.callId, ok: true, content: "read" }));

    await session.close();
    await session.close();
    const result = await session.invoke(call("c1", "read_file"), { grant, signal: new AbortController().signal });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("closed");
  });
});

describe("run-scoped tool output capability", () => {
  it("mounts, validates, invokes, and closes output reads under the run grant", async () => {
    const outputs = new Map<string, AgentToolOutputRecord>();
    const store: Pick<AgentRunStore, "recordToolOutput" | "readToolOutput"> = {
      recordToolOutput(record) {
        outputs.set(`${record.runId}:${record.callId}`, record);
      },
      readToolOutput(runId, callId) {
        return outputs.get(`${runId}:${callId}`);
      },
    };
    const base = new InMemoryCapabilitySession();
    base.register(descriptor("read_file"), async (invoked) => ({ callId: invoked.callId, ok: true, content: "read" }));
    const session = createRunScopedCapabilitySession(base, { runId: "run-1", store });
    const stored = session.recordToolOutput("source-call", "abcdefghijklmnopqrstuvwxyz");
    const outputCall: CapabilityCall = {
      runId: "run-1",
      callId: "reader-call",
      capabilityId: "tool_output_read",
      arguments: { callId: "source-call", offset: 5, limit: 4 },
      botId: "bot-1",
      threadId: "thread-1",
    };

    expect(stored).toBe(true);
    expect(session.list(grant).map((item) => item.id)).toEqual(["read_file", "tool_output_read"]);
    expect(session.list(restrictedGrant).map((item) => item.id)).toEqual(["read_file"]);
    expect(() => session.validate(outputCall, restrictedGrant)).toThrow("Capability not allowed: tool_output_read");
    expect(() => session.validate(outputCall, grant)).not.toThrow();

    const result = await session.invoke(outputCall, { grant, signal: new AbortController().signal });
    expect(result).toMatchObject({ callId: "reader-call", ok: true });
    expect(JSON.parse(result.content)).toEqual({ callId: "source-call", offset: 5, limit: 4, totalChars: 26, content: "fghi", nextOffset: 9 });

    await session.close();
    expect(session.list(grant)).toEqual([]);
  });
});
