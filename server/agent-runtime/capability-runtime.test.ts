import { describe, expect, it } from "vitest";

import { InMemoryCapabilitySession } from "./capability-runtime.ts";
import type { CapabilityCall, CapabilityDescriptor, CapabilityGrant } from "./contracts.ts";

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
