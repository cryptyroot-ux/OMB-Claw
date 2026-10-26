import { describe, expect, it } from "vitest";

import { createOpenAICompatibleModelAdapter } from "./model-adapter.ts";
import type { ModelEvent } from "./contracts.ts";

const config = {
  providerId: "test-provider",
  apiUrl: "https://api.example.com/v1",
  apiKey: "test-key",
  defaultModel: "test-model",
  supportsTools: true,
  supportsStreaming: true,
  contextWindow: 128_000,
  imageInput: false,
};

describe("createOpenAICompatibleModelAdapter", () => {
  it("discovers the configured model and reports explicit capabilities", async () => {
    const adapter = createOpenAICompatibleModelAdapter(config);

    const catalog = await adapter.discoverModels();
    expect(catalog.default).toBe("test-model");
    expect(catalog.options.map((option) => option.id)).toEqual(["test-model"]);

    expect(adapter.capabilities("test-model")).toMatchObject({
      tools: "supported",
      parallelTools: "unknown",
      streaming: "supported",
      contextWindow: { status: "known", value: 128_000 },
      imageInput: "unsupported",
      structuredOutput: "unsupported",
    });
  });

  it("streams stub content and completion events", async () => {
    const adapter = createOpenAICompatibleModelAdapter(config);
    const events: ModelEvent[] = [];

    for await (const event of adapter.generate({
      messages: [{ role: "user", content: "hello" }],
      model: "test-model",
      tools: [],
      signal: new AbortController().signal,
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "content.delta", kind: "assistant_text", delta: "Stub response from OpenAI-compatible adapter" },
      { type: "completed", finishReason: "stop" },
    ]);
  });
});
