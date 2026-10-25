import { describe, expect, it } from "vitest";

import { createOpenAICompatibleModelAdapter } from "./model-adapter.ts";

describe("createOpenAICompatibleModelAdapter", () => {
  it("discovers models and reports capabilities", async () => {
    const adapter = createOpenAICompatibleModelAdapter({
      providerId: "test-provider",
      apiUrl: "https://api.example.com/v1",
      apiKey: "test-key",
      defaultModel: "test-model",
      supportsTools: true,
      supportsStreaming: true,
      contextWindow: 128000,
      imageInput: false,
    });

    const catalog = await adapter.discoverModels();
    expect(catalog.default).toBe("test-model");
    expect(catalog.options).toHaveLength(1);

    const caps = adapter.capabilities("test-model");
    expect(caps.tools).toBe(true);
    expect(caps.streaming).toBe(true);
    expect(caps.contextWindow).toBe(128000);
    expect(caps.imageInput).toBe(false);
  });

  it("returns a stub response from generate", async () => {
    const adapter = createOpenAICompatibleModelAdapter({
      providerId: "test-provider",
      apiUrl: "https://api.example.com/v1",
      apiKey: "test-key",
      defaultModel: "test-model",
      supportsTools: true,
      supportsStreaming: true,
      contextWindow: 128000,
      imageInput: false,
    });

    const result = await adapter.generate({
      messages: [{ role: "user", content: "hello" }],
      model: "test-model",
      tools: [],
      signal: new AbortController().signal,
    });

    expect(result.text).toBe("Stub response from OpenAI-compatible adapter");
    expect(result.finishReason).toBe("stop");
  });
});