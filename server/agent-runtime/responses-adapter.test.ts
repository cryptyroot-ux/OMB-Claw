import { describe, expect, it } from "vitest";

import { createResponsesModelAdapter } from "./responses-adapter.ts";
import type { ModelCatalog } from "./contracts.ts";

const catalog: ModelCatalog = { default: "gpt-4o", options: [{ id: "gpt-4o", label: "GPT-4o", contextWindow: 128_000 }] };

describe("createResponsesModelAdapter", () => {
  it("discovers models from catalog", async () => {
    const adapter = createResponsesModelAdapter({ providerId: "openai-responses", apiUrl: "https://api.openai.com/v1", apiKey: "sk-test", catalog, capabilities: () => ({ tools: "supported", parallelTools: "supported", streaming: "supported", contextWindow: { status: "known", value: 128_000 }, imageInput: "supported", imageOutput: "unsupported", audioInput: "unsupported", audioOutput: "unsupported", structuredOutput: "unknown", toolSchemaLimit: { status: "unknown" } }) });
    const discovered = await adapter.discoverModels();
    expect(discovered.options[0]?.id).toBe("gpt-4o");
  });

  it("generates text from a non-streaming response", async () => {
    const fetcher = async () => new Response(JSON.stringify({
      output: [{ type: "message", content: [{ type: "output_text", text: "Hello from Responses." }] }],
      status: "completed",
      usage: { input_tokens: 10, output_tokens: 5 },
    }), { status: 200, headers: { "content-type": "application/json" } });
    const adapter = createResponsesModelAdapter({ providerId: "openai-responses", apiUrl: "https://api.openai.com/v1", apiKey: "sk-test", catalog, capabilities: () => ({ tools: "supported", parallelTools: "supported", streaming: "unsupported", contextWindow: { status: "known", value: 128_000 }, imageInput: "supported", imageOutput: "unsupported", audioInput: "unsupported", audioOutput: "unsupported", structuredOutput: "unknown", toolSchemaLimit: { status: "unknown" } }), fetcher: fetcher as any, timeoutMs: 5_000 });
    const events: any[] = [];
    for await (const e of adapter.generate({ messages: [{ role: "user", content: "hi" }], model: "gpt-4o", tools: [], signal: new AbortController().signal })) events.push(e);
    expect(events.some((e) => e.type === "content.delta" && e.delta === "Hello from Responses.")).toBe(true);
    expect(events.some((e) => e.type === "completed")).toBe(true);
  });

  it("generates tool calls from a non-streaming response", async () => {
    const fetcher = async () => new Response(JSON.stringify({
      output: [{ type: "function_call", call_id: "call_1", name: "read_file", arguments: JSON.stringify({ path: "/tmp/x" }) }],
      status: "completed",
      usage: { input_tokens: 10, output_tokens: 5 },
    }), { status: 200, headers: { "content-type": "application/json" } });
    const adapter = createResponsesModelAdapter({ providerId: "openai-responses", apiUrl: "https://api.openai.com/v1", apiKey: "sk-test", catalog, capabilities: () => ({ tools: "supported", parallelTools: "supported", streaming: "unsupported", contextWindow: { status: "known", value: 128_000 }, imageInput: "supported", imageOutput: "unsupported", audioInput: "unsupported", audioOutput: "unsupported", structuredOutput: "unknown", toolSchemaLimit: { status: "unknown" } }), fetcher: fetcher as any, timeoutMs: 5_000 });
    const events: any[] = [];
    for await (const e of adapter.generate({ messages: [{ role: "user", content: "read" }], model: "gpt-4o", tools: [{ id: "read_file", name: "read_file", description: "read", schema: { type: "object" }, risk: "read", sideEffect: false, timeoutMs: 1000 }], signal: new AbortController().signal })) events.push(e);
    const tc = events.find((e) => e.type === "tool_calls");
    expect(tc).toBeTruthy();
    expect(tc.calls[0].name).toBe("read_file");
  });

  it("throws on HTTP error", async () => {
    const fetcher = async () => new Response("bad key", { status: 401 });
    const adapter = createResponsesModelAdapter({ providerId: "openai-responses", apiUrl: "https://api.openai.com/v1", apiKey: "sk-test", catalog, capabilities: () => ({ tools: "supported", parallelTools: "supported", streaming: "unsupported", contextWindow: { status: "known", value: 128_000 }, imageInput: "supported", imageOutput: "unsupported", audioInput: "unsupported", audioOutput: "unsupported", structuredOutput: "unknown", toolSchemaLimit: { status: "unknown" } }), fetcher: fetcher as any, timeoutMs: 5_000 });
    await expect(async () => {
      for await (const _e of adapter.generate({ messages: [{ role: "user", content: "hi" }], model: "gpt-4o", tools: [], signal: new AbortController().signal })) { /* drain */ }
    }).rejects.toThrow();
  });
});
