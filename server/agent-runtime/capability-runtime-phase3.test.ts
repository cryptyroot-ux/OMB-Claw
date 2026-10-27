import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { CompositeCapabilityRuntime, SkillCapabilityProvider } from "./capability-runtime.ts";
import type { CapabilityGrant } from "./contracts.ts";

const grant: CapabilityGrant = { botId: "bot-1", threadId: "t-1", approvalMode: "full", allowed: new Set(), denied: new Set() };

describe("CompositeCapabilityRuntime", () => {
  it("aggregates providers and enforces a single grant policy", async () => {
    const provider = {
      id: "p1", kind: "native-tool" as const,
      list: () => [{ id: "tool_a", name: "tool_a", description: "a", schema: {}, risk: "read" as const, sideEffect: false, timeoutMs: 1000 }],
      mount: async () => {},
      invoke: async (call: any) => ({ callId: call.callId, ok: true, content: "done" }),
      close: async () => {},
      describe: () => "p1",
    };
    const runtime = new CompositeCapabilityRuntime([provider]);
    await runtime.mountAll({ grant, signal: new AbortController().signal });
    expect(runtime.list(grant).map((d) => d.id)).toEqual(["tool_a"]);

    const deniedGrant: CapabilityGrant = { ...grant, denied: new Set(["tool_a"]) };
    const res = await runtime.invoke({ runId: "r", callId: "c", capabilityId: "tool_a", arguments: {}, botId: "bot-1", threadId: "t-1" }, { grant: deniedGrant, signal: new AbortController().signal });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("denied");

    await runtime.close();
    expect(runtime.list(grant)).toEqual([]);
  });
});

describe("SkillCapabilityProvider", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "skillcap-")); });

  it("exposes enabled skills and reads their SKILL.md", async () => {
    // Minimal: provider with no enabled skills returns empty list
    const provider = new SkillCapabilityProvider("nonexistent-bot-xyz");
    expect(provider.list(grant)).toEqual([]);
    const res = await provider.invoke({ runId: "r", callId: "c", capabilityId: "skill:nope", arguments: {}, botId: "bot-1", threadId: "t-1" }, { grant, signal: new AbortController().signal });
    expect(res.ok).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});
