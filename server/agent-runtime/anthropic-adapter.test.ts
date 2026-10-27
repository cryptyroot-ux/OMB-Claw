import { describe, expect, it } from "vitest";

import { createAnthropicModelAdapter } from "./anthropic-adapter.ts";
import type { ModelCatalog } from "./contracts.ts";

const catalog: ModelCatalog = { default: "claude-3-5-sonnet-20241022", options: [{ id: "claude-3-5-sonnet-20241022", label: "Claude 3.5 Sonnet", contextWindow: 200_000 }] };

describe("createAnthropicModelAdapter", () => {
  it("discovers models from catalog", async () => {
    const adapter = createAnthropicModelAdapter({ providerId: "anthropic", apiUrl: "https://api.anthropic.com", apiKey: "sk-test", catalog, capabilities: () => ({ tools: "supported", parallelTools: "supported", streaming: "supported", contextWindow: { status: "known", value: 200_000 }, imageInput: "supported", imageOutput: "unsupported", audioInput: "unsupported", audioOutput: "unsupported", structuredOutput: "unknown", toolSchemaLimit: { status: "unknown" } }) });
    const discovered = await adapter.discoverModels();
    expect(discovered.options[0]?.id).toBe("claude-3-5-sonnet-20241022");
  });

  it("reports capabilities from config", () => {
    const caps = { tools: "supported" as const, parallelTools: "supported" as const, streaming: "supported" as const, contextWindow: { status: "known" as const, value: 200_000 }, imageInput: "supported" as const, imageOutput: "unsupported" as const, audioInput: "unsupported" as const, audioOutput: "unsupported" as const, structuredOutput: "unknown" as const, toolSchemaLimit: { status: "unknown" as const } };
    const adapter = createAnthropicModelAdapter({ providerId: "anthropic", apiUrl: "https://api.anthropic.com", apiKey: "sk-test", catalog, capabilities: () => caps });
    expect(adapter.capabilities("claude-3-5-sonnet-20241022")).toBe(caps);
  });

  it("generates text from a non-streaming response", async () => {
    const fetcher = async () => new Response(JSON.stringify({
      content: [{ type: "text", text: "Hello from Claude." }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
    }), { status: 200, headers: { "content-type": "application/json" } });
    const adapter = createAnthropicModelAdapter({ providerId: "anthropic", apiUrl: "https://api.anthropic.com", apiKey: "sk-test", catalog, capabilities: () => ({ tools: "supported", parallelTools: "supported", streaming: "unsupported", contextWindow: { status: "known", value: 200_000 }, imageInput: "supported", imageOutput: "unsupported", audioInput: "unsupported", audioOutput: "unsupported", structuredOutput: "unknown", toolSchemaLimit: { status: "unknown" } }), fetcher: fetcher as any, timeoutMs: 5_000 });
    const events: any[] = [];
    for await (const e of adapter.generate({ messages: [{ role: "user", content: "hi" }], model: "claude-3-5-sonnet-20241022", tools: [], signal: new AbortController().signal })) {
      events.push(e);
    }
    expect(events.some((e) => e.type === "content.delta" && e.delta === "Hello from Claude.")).toBe(true);
    expect(events.some((e) => e.type === "completed")).toBe(true);
    expect(events.some((e) => e.type === "usage" && e.input === 10)).toBe(true);
  });

  it("generates tool calls from a non-streaming response", async () => {
    const fetcher = async () => new Response(JSON.stringify({
      content: [{ type: "tool_use", id: "tool_1", name: "read_file", input: { path: "/tmp/x" } }],
      stop_reason: "tool_use",
      usage: { input_tokens: 10, output_tokens: 5 },
    }), { status: 200, headers: { "content-type": "application/json" } });
    const adapter = createAnthropicModelAdapter({ providerId: "anthropic", apiUrl: "https://api.anthropic.com", apiKey: "sk-test", catalog, capabilities: () => ({ tools: "supported", parallelTools: "supported", streaming: "unsupported", contextWindow: { status: "known", value: 200_000 }, imageInput: "supported", imageOutput: "unsupported", audioInput: "unsupported", audioOutput: "unsupported", structuredOutput: "unknown", toolSchemaLimit: { status: "unknown" } }), fetcher: fetcher as any, timeoutMs: 5_000 });
    const events: any[] = [];
    for await (const e of adapter.generate({ messages: [{ role: "user", content: "read" }], model: "claude-3-5-sonnet-20241022", tools: [{ id: "read_file", name: "read_file", description: "read", schema: { type: "object" }, risk: "read", sideEffect: false, timeoutMs: 1000 }], signal: new AbortController().signal })) {
      events.push(e);
    }
    const tc = events.find((e) => e.type === "tool_calls");
    expect(tc).toBeTruthy();
    expect(tc.calls[0].name).toBe("read_file");
  });

  it("throws on HTTP error", async () => {
    const fetcher = async () => new Response("bad key", { status: 401 });
    const adapter = createAnthropicModelAdapter({ providerId: "anthropic", apiUrl: "https://api.anthropic.com", apiKey: "sk-test", catalog, capabilities: () => ({ tools: "supported", parallelTools: "supported", streaming: "unsupported", contextWindow: { status: "known", value: 200_000 }, imageInput: "supported", imageOutput: "unsupported", audioInput: "unsupported", audioOutput: "unsupported", structuredOutput: "unknown", toolSchemaLimit: { status: "unknown" } }), fetcher: fetcher as any, timeoutMs: 5_000 });
    await expect(async () => {
      for await (const _e of adapter.generate({ messages: [{ role: "user", content: "hi" }], model: "claude-3-5-sonnet-20241022", tools: [], signal: new AbortController().signal })) { /* drain */ }
    }).rejects.toThrow();
  });
});
