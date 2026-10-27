import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { createOpenAICompatibleModelAdapter } from "./model-adapter.ts";
import type {
  CapabilitySupport,
  ModelAdapterError,
  ModelCapabilities,
  ModelCatalog,
  ModelEvent,
} from "./contracts.ts";

const catalog: ModelCatalog = {
  default: "fixture-model",
  options: [{ id: "fixture-model", label: "Fixture Model" }],
};

function capabilities(
  tools: CapabilitySupport = "supported",
  streaming: CapabilitySupport = "supported",
): ModelCapabilities {
  return {
    tools,
    parallelTools: "unknown",
    streaming,
    contextWindow: { status: "known", value: 128_000 },
    imageInput: "unsupported",
    imageOutput: "unsupported",
    audioInput: "unsupported",
    audioOutput: "unsupported",
    structuredOutput: "unsupported",
    toolSchemaLimit: { status: "unknown" },
  };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(handler: (request: IncomingMessage, response: ServerResponse, body: string) => void) {
  const requests: string[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const part of request) body += part.toString();
    requests.push(body);
    handler(request, response, body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture did not bind TCP");
  const origin = `http://127.0.0.1:${address.port}`;
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { origin, requests };
}

function json(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function sse(response: ServerResponse, chunks: unknown[]): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  response.end("data: [DONE]\n\n");
}

function adapter(origin: string, streaming: CapabilitySupport = "supported", reasoning = false) {
  return createOpenAICompatibleModelAdapter({
    providerId: "fixture",
    apiUrl: `${origin}/v1`,
    apiKey: "fixture-secret",
    catalog,
    capabilities: () => capabilities("supported", streaming),
    reasoning,
  });
}

async function collect(iterable: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

async function failure(iterable: AsyncIterable<ModelEvent>): Promise<ModelAdapterError> {
  try {
    await collect(iterable);
  } catch (error) {
    return error as ModelAdapterError;
  }
  throw new Error("Expected the adapter to fail");
}

describe("createOpenAICompatibleModelAdapter", () => {
  it("maps a JSON tool completion to normalized events", async () => {
    const f = await fixture((_request, response) => {
      json(response, {
        choices: [{
          message: {
            content: "Checking the file.",
            tool_calls: [{
              id: "call-1",
              type: "function",
              function: { name: "read_file", arguments: '{"path":"/tmp/a"}' },
            }],
          },
          finish_reason: "tool_calls",
        }],
        usage: { prompt_tokens: 11, completion_tokens: 7 },
      });
    });

    const events = await collect(adapter(f.origin, "unsupported").generate({
      messages: [
        { role: "system", content: "Use tools." },
        { role: "user", content: "Read the file." },
      ],
      model: "fixture-model",
      tools: [{
        id: "read_file",
        name: "read_file",
        description: "Read a file",
        schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        risk: "read",
        sideEffect: false,
        timeoutMs: 5_000,
      }],
      signal: new AbortController().signal,
    }));

    expect(events).toEqual([
      { type: "content.delta", kind: "assistant_text", delta: "Checking the file." },
      { type: "tool_calls", calls: [{ id: "call-1", name: "read_file", arguments: { path: "/tmp/a" } }] },
      { type: "usage", input: 11, output: 7 },
      { type: "completed", finishReason: "tool_calls" },
    ]);
    expect(JSON.parse(f.requests[0]!)).toMatchObject({
      model: "fixture-model",
      stream: false,
      messages: [
        { role: "system", content: "Use tools." },
        { role: "user", content: "Read the file." },
      ],
      tools: [{ type: "function", function: { name: "read_file" } }],
    });
  });

  it("serializes neutral image parts as image_url content", async () => {
    const f = await fixture((_request, response) => {
      json(response, { choices: [{ message: { content: "Seen." }, finish_reason: "stop" }] });
    });

    await collect(adapter(f.origin, "unsupported").generate({
      messages: [
        { role: "system", content: "Look." },
        {
          role: "user",
          content: [
            { type: "text", text: "What is this?" },
            { type: "image", mimeType: "image/png", data: "fixture" },
          ],
        },
      ],
      model: "fixture-model",
      tools: [],
      signal: new AbortController().signal,
    }));

    expect(JSON.parse(f.requests[0]!).messages[1]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "What is this?" },
        { type: "image_url", image_url: { url: "data:image/png;base64,fixture" } },
      ],
    });
  });

  it("maps SSE deltas, usage, and fragmented tool calls", async () => {
    const f = await fixture((_request, response) => {
      sse(response, [
        { choices: [{ index: 0, delta: { content: "Hel" } }] },
        { choices: [{ index: 0, delta: { content: "lo" }, finish_reason: null }] },
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call-2", type: "function", function: { name: "read_file", arguments: '{"path":' } }] } }] },
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"/tmp/b"}' } }] } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
        { choices: [], usage: { prompt_tokens: 5, completion_tokens: 6 } },
      ]);
    });

    const events = await collect(adapter(f.origin).generate({
      messages: [{ role: "user", content: "Read the file." }],
      model: "fixture-model",
      tools: [],
      signal: new AbortController().signal,
    }));

    expect(events).toEqual([
      { type: "content.delta", kind: "assistant_text", delta: "Hel" },
      { type: "content.delta", kind: "assistant_text", delta: "lo" },
      { type: "tool_calls", calls: [{ id: "call-2", name: "read_file", arguments: { path: "/tmp/b" } }] },
      { type: "usage", input: 5, output: 6 },
      { type: "completed", finishReason: "tool_calls" },
    ]);
    expect(JSON.parse(f.requests[0]!).stream).toBe(true);
  });

  it("classifies 429 and 5xx as transient before output", async () => {
    for (const status of [429, 503]) {
      const f = await fixture((_request, response) => json(response, { error: "temporary" }, status));
      const error = await failure(adapter(f.origin).generate({
        messages: [{ role: "user", content: "hello" }],
        model: "fixture-model",
        tools: [],
        signal: new AbortController().signal,
      }));

      expect(error).toBeInstanceOf(Error);
      expect(error).toMatchObject({ code: "transient", retryable: false, retrySafe: false, requestStarted: false });
    }
  });

  it("does not include a provider response body in the error", async () => {
    const f = await fixture((_request, response) => json(response, { secret: "fixture-secret-value" }, 500));
    const error = await failure(adapter(f.origin).generate({
      messages: [{ role: "user", content: "hello" }],
      model: "fixture-model",
      tools: [],
      signal: new AbortController().signal,
    }));

    expect(error).toBeInstanceOf(Error);
    expect(error.message).not.toContain("fixture-secret-value");
    expect(error.message).not.toContain("secret");
  });

  it("classifies an unreadable JSON response as terminal", async () => {
    const f = await fixture((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{not-json");
    });
    const error = await failure(adapter(f.origin, "unsupported").generate({
      messages: [{ role: "user", content: "hello" }],
      model: "fixture-model",
      tools: [],
      signal: new AbortController().signal,
    }));

    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ code: "terminal", retryable: false, retrySafe: false, requestStarted: false });
  });

  it("classifies an invalid request as non-retryable", async () => {
    const f = await fixture((_request, response) => json(response, { error: "bad request" }, 400));
    const error = await failure(adapter(f.origin).generate({
      messages: [{ role: "user", content: "hello" }],
      model: "fixture-model",
      tools: [],
      signal: new AbortController().signal,
    }));

    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ code: "invalid_request", retryable: false, retrySafe: false, requestStarted: false });
  });

  it("classifies an oversized request with its encoded size", async () => {
    const f = await fixture((_request, response) => {
      response.writeHead(413, { "content-type": "text/plain" });
      response.end("Payload Too Large");
    });
    const error = await failure(adapter(f.origin).generate({
      messages: [{ role: "user", content: "hello" }],
      model: "fixture-model",
      tools: [],
      signal: new AbortController().signal,
    }));

    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ code: "request_too_large", retryable: false, retrySafe: false, requestStarted: false });
    expect(error.bytes).toBeGreaterThan(0);
  });

  it("classifies a provider that rejects the tools parameter", async () => {
    const f = await fixture((_request, response) => json(response, {
      error: { message: "tools are not supported", param: "tools", code: "unsupported_parameter" },
    }, 400));
    const error = await failure(adapter(f.origin).generate({
      messages: [{ role: "user", content: "hello" }],
      model: "fixture-model",
      tools: [{
        id: "read_file",
        name: "read_file",
        description: "Read a file",
        schema: { type: "object" },
        risk: "read",
        sideEffect: false,
        timeoutMs: 5_000,
      }],
      signal: new AbortController().signal,
    }));

    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ code: "unsupported_tools", retryable: false, retrySafe: false, requestStarted: false });
  });

  it("suppresses reasoning unless the adapter enables it", async () => {
    const f = await fixture((_request, response) => {
      sse(response, [
        { choices: [{ index: 0, delta: { reasoning_content: "private thought" } }] },
        { choices: [{ index: 0, delta: { content: "Visible answer." }, finish_reason: "stop" }] },
      ]);
    });

    const hidden = await collect(adapter(f.origin, "supported", false).generate({
      messages: [{ role: "user", content: "hello" }],
      model: "fixture-model",
      tools: [],
      signal: new AbortController().signal,
    }));
    expect(hidden.some((event) => event.type === "content.delta" && event.kind === "reasoning_text")).toBe(false);

    const shown = await collect(adapter(f.origin, "supported", true).generate({
      messages: [{ role: "user", content: "hello" }],
      model: "fixture-model",
      tools: [],
      signal: new AbortController().signal,
    }));
    expect(shown).toContainEqual({ type: "content.delta", kind: "reasoning_text", delta: "private thought" });
  });

  it("reports unknown capabilities without guessing", () => {
    const adapterInstance = createOpenAICompatibleModelAdapter({
      providerId: "fixture",
      apiUrl: "http://127.0.0.1:1/v1",
      apiKey: "fixture-secret",
      catalog,
      capabilities: () => capabilities("unknown", "unknown"),
    });

    expect(adapterInstance.capabilities("fixture-model")).toMatchObject({ tools: "unknown", streaming: "unknown" });
  });

  it("aborts fetch when the signal is cancelled", async () => {
    const controller = new AbortController();
    const adapterInstance = createOpenAICompatibleModelAdapter({
      providerId: "fixture",
      apiUrl: "http://127.0.0.1:1/v1",
      apiKey: "fixture-secret",
      catalog,
      capabilities: () => capabilities(),
      fetcher: async (_input, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      }),
    });

    const pending = adapterInstance.generate({
      messages: [{ role: "user", content: "hello" }],
      model: "fixture-model",
      tools: [],
      signal: controller.signal,
    })[Symbol.asyncIterator]().next();
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});
