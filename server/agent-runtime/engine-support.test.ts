import { describe, expect, it } from "vitest";

import { isExternalAgentEngine, supportedAgentDrivers } from "./engine-support.ts";

describe("engine support policy", () => {
  it("marks CLI and ACP agent engines as external", () => {
    for (const kind of [
      "claudeAgent",
      "codex",
      "opencodeGo",
      "hermesAgent",
      "piAgent",
      "antigravityAgent",
      "customAcp",
      "grokAgent",
      "geminiAgent",
      "kimiAgent",
      "droidAgent",
      "cursorAgent",
      "qwenAgent",
      "clineAgent",
      "deepseekAgent",
      "museCode",
    ]) {
      expect(isExternalAgentEngine(kind), kind).toBe(true);
    }
  });

  it("keeps API model providers supported", () => {
    for (const kind of ["openai-compat", "grok", "minimax", "mistral", "cerebras", "groq", "meta"]) {
      expect(isExternalAgentEngine(kind), kind).toBe(false);
    }
  });

  it("filters external engines out of the registered driver list", () => {
    const drivers = [
      { driverKind: "openai-compat" },
      { driverKind: "claudeAgent" },
      { driverKind: "groq" },
      { driverKind: "codex" },
    ];

    expect(supportedAgentDrivers(drivers).map((driver) => driver.driverKind)).toEqual(["openai-compat", "groq"]);
  });
});
