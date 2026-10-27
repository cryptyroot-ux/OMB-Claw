import { describe, expect, it, beforeEach } from "vitest";

import { clearCapabilityProbeCache, probeCapabilities } from "./capability-probe.ts";
import type { ModelCatalog } from "./contracts.ts";

const catalog = (contextWindow?: number, modelId = "gpt-4o"): ModelCatalog => ({
  default: modelId,
  options: [{ id: modelId, label: modelId, ...(contextWindow ? { contextWindow } : {}) }],
});

describe("probeCapabilities", () => {
  beforeEach(() => clearCapabilityProbeCache());

  it("reads context window from the catalog", () => {
    const caps = probeCapabilities("gpt-4o", catalog(128_000));
    expect(caps.contextWindow).toEqual({ status: "known", value: 128_000 });
  });

  it("reports unknown context window when catalog lacks it", () => {
    const caps = probeCapabilities("gpt-4o", catalog());
    expect(caps.contextWindow).toEqual({ status: "unknown" });
  });

  it("marks known tool-capable families as supported", () => {
    for (const id of ["gpt-4o", "claude-3-5-sonnet", "gemini-1.5-pro", "mistral-large", "deepseek-chat", "grok-2"]) {
      expect(probeCapabilities(id, catalog(8_000)).tools).toBe("supported");
    }
  });

  it("marks non-tool models (embeddings, tts, whisper, dall-e) as unsupported", () => {
    for (const id of ["text-embedding-3-small", "tts-1", "whisper-1", "dall-e-3"]) {
      expect(probeCapabilities(id, catalog(8_000)).tools).toBe("unsupported");
    }
  });

  it("defaults to supported for unrecognized model ids (adapter fallback covers rejection)", () => {
    expect(probeCapabilities("totally-unknown-model-xyz", catalog(8_000)).tools).toBe("supported");
  });

  it("marks clearly non-tool models as unsupported", () => {
    expect(probeCapabilities("text-embedding-3-small", catalog(8_000)).tools).toBe("unsupported");
  });

  it("detects vision from model id patterns", () => {
    expect(probeCapabilities("gpt-4o", catalog(8_000)).imageInput).toBe("supported");
    expect(probeCapabilities("claude-3-5-sonnet", catalog(8_000)).imageInput).toBe("supported");
    expect(probeCapabilities("gpt-3.5-turbo", catalog(8_000)).imageInput).toBe("unsupported");
  });

  it("honours operator hints over heuristics", () => {
    const caps = probeCapabilities("gpt-3.5-turbo", catalog(8_000), {
      toolsEnabled: false,
      imageInput: () => true,
    });
    expect(caps.tools).toBe("unsupported");
    expect(caps.imageInput).toBe("supported");
  });

  it("caches results by model id", () => {
    const first = probeCapabilities("gpt-4o", catalog(128_000));
    const second = probeCapabilities("gpt-4o", catalog(1_000));
    expect(second).toBe(first);
    expect(second.contextWindow).toEqual({ status: "known", value: 128_000 });
  });
});
