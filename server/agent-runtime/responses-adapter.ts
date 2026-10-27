// OpenAI Responses API transport. Owns the Responses wire format only.
import { rejectsKey, noteKeyRejected } from "../key-rejections.ts";
import type {
  ModelAdapter,
  ModelAdapterError,
  ModelAdapterErrorCode,
  ModelCapabilities,
  ModelCatalog,
  ModelEvent,
  ModelGenerateRequest,
  ModelMessage,
} from "./contracts.ts";

interface RespOutputText { type: "output_text"; text: string }
interface RespOutputItem { type: string; id?: string; role?: string; content?: RespOutputText[]; [k: string]: unknown }
interface RespUsage { input_tokens?: number; output_tokens?: number }
interface RespResponse { id?: string; output?: RespOutputItem[]; usage?: RespUsage; status?: string; error?: { message?: string } }

class ResponsesAdapterError extends Error implements ModelAdapterError {
  readonly code: ModelAdapterErrorCode; readonly retryable: boolean; readonly retrySafe: boolean; readonly requestStarted: boolean; readonly bytes?: number;
  constructor(message: string, code: ModelAdapterErrorCode, retryable: boolean, retrySafe: boolean, requestStarted: boolean, bytes?: number) {
    super(message); this.name = "ResponsesAdapterError"; this.code = code; this.retryable = retryable; this.retrySafe = retrySafe; this.requestStarted = requestStarted; this.bytes = bytes;
  }
}

function protocolError(message: string, rs: boolean): ResponsesAdapterError { return new ResponsesAdapterError(message, "terminal", false, false, rs); }
function abortError(reason: unknown): DOMException { if (reason instanceof DOMException) return reason; return new DOMException("The model request was aborted", "AbortError"); }

function wireInput(messages: ReadonlyArray<ModelMessage>) {
  const items: any[] = [];
  for (const m of messages) {
    if (m.role === "system") { items.push({ type: "message", role: "system", content: typeof m.content === "string" ? m.content : "" }); continue; }
    if (m.role === "assistant") {
      if (typeof m.content === "string" && m.content) items.push({ type: "message", role: "assistant", content: m.content });
      if (m.toolCalls?.length) for (const c of m.toolCalls) items.push({ type: "function_call", call_id: c.id, name: c.name, arguments: JSON.stringify(c.arguments) });
      continue;
    }
    if (m.role === "tool") { items.push({ type: "function_call_output", call_id: m.toolCallId ?? "", output: typeof m.content === "string" ? m.content : "" }); continue; }
    // user
    const content = typeof m.content === "string" ? m.content : (Array.isArray(m.content) ? m.content.map((p: any) => p.type === "text" ? { type: "input_text", text: p.text } : { type: "input_image", image_url: `data:${p.mimeType};base64,${p.data}` }) : "");
    items.push({ type: "message", role: "user", content });
  }
  return items;
}

export interface ResponsesModelAdapterConfig {
  readonly providerId: string;
  readonly apiUrl: string;
  readonly apiKey: string;
  readonly catalog: ModelCatalog | (() => ModelCatalog);
  readonly capabilities: (modelId: string) => ModelCapabilities;
  readonly fetcher?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxOutputTokens?: number;
}

export function createResponsesModelAdapter(config: ResponsesModelAdapterConfig): ModelAdapter {
  const resolveFetcher = () => config.fetcher ?? fetch;
  const baseUrl = config.apiUrl.replace(/\/+$/, "");

  return {
    providerId: config.providerId,
    async discoverModels() { return typeof config.catalog === "function" ? config.catalog() : config.catalog; },
    capabilities(modelId) { return config.capabilities(modelId); },

    async *generate(request: ModelGenerateRequest): AsyncIterable<ModelEvent> {
      if (!config.apiKey) throw new ResponsesAdapterError("No API key", "terminal", false, false, false);
      const stream = config.capabilities(request.model).streaming === "supported";
      const timeoutController = new AbortController();
      const timeout = setTimeout(() => timeoutController.abort(new DOMException("timeout", "TimeoutError")), config.timeoutMs ?? 120_000);
      const signal = AbortSignal.any([request.signal, timeoutController.signal]);
      let emitted = false;
      const payload: Record<string, unknown> = { model: request.model, input: wireInput(request.messages), stream };
      if (request.tools.length) payload.tools = request.tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.schema }));
      if (config.maxOutputTokens) payload.max_output_tokens = config.maxOutputTokens;

      try {
        let response: Response;
        try {
          response = await resolveFetcher()(`${baseUrl}/responses`, {
            method: "POST",
            headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
            body: JSON.stringify(payload),
            signal,
          });
        } catch {
          if (request.signal.aborted) throw abortError(request.signal.reason);
          if (timeoutController.signal.aborted) throw new ResponsesAdapterError("timeout", "transient", true, !emitted, emitted);
          throw new ResponsesAdapterError(emitted ? "conn failed after output" : "conn failed before response", "transient", true, !emitted, emitted);
        }

        if (!response.ok) {
          const detail = await response.text().catch(() => "");
          const transient = response.status === 408 || response.status === 429 || response.status >= 500;
          if (rejectsKey(response.status, detail)) noteKeyRejected(config.apiUrl, config.apiKey);
          const code: ModelAdapterErrorCode = transient ? "transient" : response.status === 400 || response.status === 422 ? "invalid_request" : "terminal";
          throw new ResponsesAdapterError(`Responses HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`, code, transient, transient && !emitted, emitted);
        }

        if (!stream) {
          let completion: RespResponse;
          try { completion = await response.json() as RespResponse; } catch { throw protocolError("unreadable JSON", emitted); }
          if (completion.error) throw protocolError(completion.error.message ?? "error", emitted);
          for (const item of completion.output ?? []) {
            if (item.type === "message") {
              const text = (item.content ?? []).filter((c) => c.type === "output_text").map((c) => c.text).join("");
              if (text) { emitted = true; yield { type: "content.delta", kind: "assistant_text", delta: text }; }
            } else if (item.type === "function_call") {
              emitted = true;
              let args: unknown = {};
              try { args = item.arguments ? JSON.parse(String(item.arguments)) : {}; } catch { args = {}; }
              yield { type: "tool_calls", calls: [{ id: String(item.call_id ?? item.id ?? ""), name: String(item.name ?? ""), arguments: args }] };
            }
          }
          const u = completion.usage;
          if (u) yield { type: "usage", input: u.input_tokens ?? 0, output: u.output_tokens ?? 0 };
          yield { type: "completed", finishReason: completion.status ?? null };
          return;
        }

        if (!response.body) throw protocolError("no stream body", emitted);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let finishReason: string | null = null;
        let usage: { input: number; output: number } | null = null;
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) { buffer += decoder.decode(); break; }
            buffer += decoder.decode(chunk.value, { stream: true });
            let newline: number;
            while ((newline = buffer.indexOf("\n")) >= 0) {
              const line = buffer.slice(0, newline).trim();
              buffer = buffer.slice(newline + 1);
              if (!line.startsWith("data:")) continue;
              const data = line.slice(5).trim();
              if (!data || data === "[DONE]") continue;
              let update: any;
              try { update = JSON.parse(data); } catch { throw protocolError("incomplete frame", emitted); }
              const t = update.type;
              if (t === "response.output_text.delta") {
                if (update.delta) { emitted = true; yield { type: "content.delta", kind: "assistant_text", delta: update.delta }; }
              } else if (t === "response.function_call_arguments.delta") {
                // accumulate not tracked here; rely on completed item
              } else if (t === "response.completed") {
                const r = update.response;
                if (r?.usage) usage = { input: r.usage.input_tokens ?? 0, output: r.usage.output_tokens ?? 0 };
                if (r?.status) finishReason = r.status;
                // emit tool calls from final output
                for (const item of r?.output ?? []) {
                  if (item.type === "function_call") {
                    emitted = true;
                    let args: unknown = {};
                    try { args = item.arguments ? JSON.parse(String(item.arguments)) : {}; } catch { args = {}; }
                    yield { type: "tool_calls", calls: [{ id: String(item.call_id ?? item.id ?? ""), name: String(item.name ?? ""), arguments: args }] };
                  }
                }
              } else if (t === "response.failed") {
                throw protocolError(update.response?.error?.message ?? "failed", emitted);
              }
            }
          }
        } finally {
          await reader.cancel().catch(() => {});
        }
        if (usage) yield { type: "usage", input: usage.input, output: usage.output };
        yield { type: "completed", finishReason };
      } catch (error) {
        if (error instanceof ResponsesAdapterError) throw error;
        if (request.signal.aborted) throw abortError(request.signal.reason);
        if (timeoutController.signal.aborted) throw new ResponsesAdapterError("timeout", "transient", true, !emitted, emitted);
        throw new ResponsesAdapterError(emitted ? "stream failed after output" : "stream failed before response", "transient", true, !emitted, emitted);
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
