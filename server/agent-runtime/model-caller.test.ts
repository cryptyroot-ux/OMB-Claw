import { describe, it, expect } from "vitest";
import { createModelCaller } from "./model-caller.ts";

describe("createModelCaller", () => {
  it("collects deltas into a string", async () => {
    const adapter = {
      generate: async function* () {
        yield { type: "content.delta", kind: "assistant_text", delta: "hel" };
        yield { type: "content.delta", kind: "assistant_text", delta: "lo" };
        yield { type: "completed", finishReason: null };
      },
    } as any;
    const caller = createModelCaller(adapter, "m");
    expect(await caller("prompt")).toBe("hello");
  });

  it("returns collected text on error after some deltas", async () => {
    const adapter = {
      generate: async function* () {
        yield { type: "content.delta", kind: "assistant_text", delta: "partial" };
        throw new Error("boom");
      },
    } as any;
    const caller = createModelCaller(adapter, "m");
    expect(await caller("prompt")).toBe("partial");
  });
});
