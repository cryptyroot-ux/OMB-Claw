import { describe, expect, it } from "vitest";

import { probeLive } from "./capability-probe.ts";

describe("probeLive", () => {
  it("returns verified capabilities when the adapter succeeds", async () => {
    const adapter = {
      generate: async function* () {
        yield { type: "content.delta", kind: "assistant_text", delta: "ok" };
        yield { type: "completed", finishReason: "stop" };
      },
    };
    const result = await probeLive(adapter as any, "test-model");
    expect(result.streaming).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.error).toBeUndefined();
  });

  it("returns error when the adapter throws", async () => {
    const adapter = {
      generate: async function* () {
        yield { type: "content.delta", kind: "assistant_text", delta: "" };
        throw new Error("auth failed");
      },
    };
    const result = await probeLive(adapter as any, "test-model");
    expect(result.error).toContain("auth failed");
    expect(result.streaming).toBe(false);
  });

  it("detects tool support when the tool probe succeeds", async () => {
    const adapter = {
      generate: async function* (req: any) {
        if (req.tools?.length) {
          yield { type: "tool_calls", calls: [{ id: "noop", name: "noop", arguments: {} }] };
        }
        yield { type: "completed", finishReason: "stop" };
      },
    };
    const result = await probeLive(adapter as any, "test-model");
    expect(result.tools).toBe(true);
  });
});
