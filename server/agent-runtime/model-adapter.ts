import type {
  CapabilityDescriptor,
  ModelAdapter,
  ModelAdapterError,
  ModelAdapterErrorCode,
  ModelCapabilities,
  ModelCatalog,
  ModelEvent,
  ModelGenerateRequest,
  ModelMessage,
  ModelToolCall,
} from "./contracts.ts";
import { rejectsToolsParameter } from "../tool-rejection.ts";
import { refusesRequestSize } from "../request-size.ts";
import { rejectsKey, noteKeyRejected } from "../key-rejections.ts";

export interface OpenAICompatibleModelAdapterConfig {
  providerId: string;
  apiUrl: string;
  apiKey: string;
  catalog: ModelCatalog | (() => ModelCatalog);
  capabilities: (modelId: string) => ModelCapabilities;
  fetcher?: typeof fetch;
  httpErrorLabel?: string;
  timeoutMs?: number;
  reasoning?: boolean;
}

interface ChatToolCall {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

type WireContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

interface ChatMessage {
  role?: string;
  content?: string | readonly WireContentPart[] | null;
  reasoning_content?: string;
  tool_calls?: ChatToolCall[];
}

interface ChatChoice {
  message?: ChatMessage;
  delta?: ChatMessage;
  finish_reason?: string | null;
}

interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  cost?: number;
}

interface ChatResponse {
  choices?: ChatChoice[];
  usage?: ChatUsage;
  error?: unknown;
}

class OpenAICompatibleAdapterError extends Error implements ModelAdapterError {
  readonly code: ModelAdapterErrorCode;
  readonly retryable: boolean;
  readonly retrySafe: boolean;
  readonly requestStarted: boolean;
  readonly bytes?: number;

  constructor(
    message: string,
    code: ModelAdapterErrorCode,
    retryable: boolean,
    retrySafe: boolean,
    requestStarted: boolean,
    bytes?: number,
  ) {
    super(message);
    this.name = "OpenAICompatibleAdapterError";
    this.code = code;
    this.retryable = retryable;
    this.retrySafe = retrySafe;
    this.requestStarted = requestStarted;
    this.bytes = bytes;
  }
}

function protocolError(message: string, requestStarted: boolean): OpenAICompatibleAdapterError {
  return new OpenAICompatibleAdapterError(message, "terminal", false, false, requestStarted);
}

function abortError(reason: unknown): DOMException {
  if (reason instanceof DOMException) return reason;
  return new DOMException("The model request was aborted", "AbortError");
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function usageEvent(usage: ChatUsage | undefined): ModelEvent | null {
  if (!usage) return null;
  const input = count(usage.prompt_tokens);
  const output = count(usage.completion_tokens);
  if (input === undefined && output === undefined) return null;
  const cachedInput = count(usage.prompt_tokens_details?.cached_tokens);
  const costUsd = count(usage.cost);
  return {
    type: "usage",
    input: input ?? 0,
    output: output ?? 0,
    ...(cachedInput === undefined ? {} : { cachedInput }),
    ...(costUsd === undefined ? {} : { costUsd }),
  };
}

function wireContent(content: ModelMessage["content"]): string | readonly WireContentPart[] | null {
  if (typeof content === "string" || content === null) return content;
  return content.map((part) => part.type === "text"
    ? { type: "text", text: part.text }
    : { type: "image_url", image_url: { url: `data:${part.mimeType};base64,${part.data}` } });
}

function wireMessages(messages: ReadonlyArray<ModelMessage>) {
  return messages.map((message) => {
    if (message.role === "assistant") {
      return {
        role: "assistant",
        content: wireContent(message.content),
        ...(message.toolCalls?.length
          ? {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: "function",
                function: { name: call.name, arguments: JSON.stringify(call.arguments) },
              })),
            }
          : {}),
      };
    }
    if (message.role === "tool") {
      const content = Array.isArray(message.content)
        ? message.content.map((part) => part.type === "text" ? part.text : "").join("\n")
        : message.content ?? "";
      return { role: "tool", tool_call_id: message.toolCallId, content };
    }
    return { role: message.role, content: wireContent(message.content) ?? "" };
  });
}

function wireTools(tools: ReadonlyArray<CapabilityDescriptor>) {
  return tools.map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.schema },
  }));
}

function parseArguments(raw: string | undefined): unknown {
  if (!raw?.trim()) throw protocolError("The model returned a tool call without arguments", true);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw protocolError("The model returned tool arguments that are not complete JSON", true);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw protocolError("The model returned tool arguments that are not a JSON object", true);
  }
  return parsed;
}

function completeToolCalls(calls: ChatToolCall[] | undefined): ModelToolCall[] {
  if (!calls?.length) return [];
  return calls.map((call) => {
    const id = call.id?.trim();
    const name = call.function?.name?.trim();
    if (!id || !name) throw protocolError("The model returned an incomplete tool call", true);
    return { id, name, arguments: parseArguments(call.function?.arguments) };
  });
}

interface PendingToolCall {
  id: string;
  name: string;
  args: string;
}

function slotOf(pending: Map<number, PendingToolCall>, id: string | undefined): number | undefined {
  if (typeof id !== "string" || !id) return undefined;
  for (const [slot, call] of pending) if (call.id === id) return slot;
  return pending.size ? Math.max(...pending.keys()) + 1 : 0;
}

function addFragments(pending: Map<number, PendingToolCall>, fragments: ChatToolCall[] | undefined): void {
  for (const fragment of fragments ?? []) {
    // Gemini's OpenAI-compatible endpoint streams each call whole, with an id and no index.
    const index = fragment.index ?? slotOf(pending, fragment.id);
    if (index === undefined || !Number.isInteger(index) || index < 0) return;
    const current = pending.get(index) ?? { id: "", name: "", args: "" };
    if (fragment.id) current.id = fragment.id;
    if (fragment.function?.name) current.name += fragment.function.name;
    if (fragment.function?.arguments) current.args += fragment.function.arguments;
    pending.set(index, current);
  }
}

function finalizeToolCalls(pending: Map<number, PendingToolCall>, requestStarted: boolean): ModelToolCall[] {
  return Array.from(pending.entries())
    .sort(([left], [right]) => left - right)
    .map(([, call]) => {
      if (!call.id.trim() || !call.name.trim()) throw protocolError("The model returned an incomplete streamed tool call", requestStarted);
      return { id: call.id, name: call.name, arguments: parseArguments(call.args) };
    });
}

/**
 * OpenAI-compatible Chat Completions transport. This adapter owns wire format
 * only: no capability execution, no run state, and no credentials in logs.
 */

function httpErrorDetail(body: string, limit = 500): string {
  let json: Record<string, unknown> | undefined;
  try { json = JSON.parse(body) as Record<string, unknown>; } catch { json = undefined; }
  let message: string | null = null;
  if (json) {
    if (typeof json.error === "string") message = json.error;
    else {
      const err = (json.error && typeof json.error === "object") ? json.error as Record<string, unknown> : null;
      if (err) message = typeof err.message === "string" ? err.message : "unknown error";
      else {
        const code = (json.base_resp as Record<string, unknown> | undefined)?.status_code;
        if (typeof code === "number" && code !== 0) {
          const msg = (json.base_resp as Record<string, unknown> | undefined)?.status_msg;
          message = `upstream error ${code}${typeof msg === "string" && msg ? `: ${msg}` : ""}`;
        } else {
          message = null;
        }
      }
    }
  }
  if (!message || message === "unknown error") return body.slice(0, limit);
  const errObj = (json?.error && typeof json.error === "object") ? json.error as Record<string, unknown> : null;
  const code = errObj?.code;
  const suffix = typeof code === "string" && /^[a-z][a-z0-9_]*$/.test(code) ? ` (${code})` : "";
  return (message.slice(0, limit) + suffix);
}

export function createOpenAICompatibleModelAdapter(config: OpenAICompatibleModelAdapterConfig): ModelAdapter {
  const resolveFetcher = () => config.fetcher ?? fetch;

  return {
    providerId: config.providerId,

    async discoverModels(): Promise<ModelCatalog> {
      return typeof config.catalog === "function" ? config.catalog() : config.catalog;
    },

    capabilities(modelId: string): ModelCapabilities {
      return config.capabilities(modelId);
    },

    async *generate(request: ModelGenerateRequest): AsyncIterable<ModelEvent> {
      if (!config.apiKey) {
        throw new OpenAICompatibleAdapterError("No API key is configured for this provider", "terminal", false, false, false);
      }

      const stream = config.capabilities(request.model).streaming === "supported";
      const timeoutController = new AbortController();
      const timeout = setTimeout(() => {
        timeoutController.abort(new DOMException("The model request timed out", "TimeoutError"));
      }, config.timeoutMs ?? 120_000);
      const signal = AbortSignal.any([request.signal, timeoutController.signal]);
      let emitted = false;

      try {
        let response: Response;
        const payload = JSON.stringify({
          model: request.model,
          messages: wireMessages(request.messages),
          stream,
          ...(request.tools.length ? { tools: wireTools(request.tools) } : {}),
        });
        try {
          response = await resolveFetcher()(`${config.apiUrl.replace(/\/+$/, "")}/chat/completions`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${config.apiKey}`,
              "content-type": "application/json",
            },
            body: payload,
            signal,
          });
        } catch {
          if (request.signal.aborted) throw abortError(request.signal.reason);
          if (timeoutController.signal.aborted) {
            throw new OpenAICompatibleAdapterError("The model request timed out", "transient", true, !emitted, emitted);
          }
          throw new OpenAICompatibleAdapterError(
            emitted ? "The model connection failed after output started" : "The model request failed before a response was received",
            "transient",
            true,
            !emitted,
            emitted,
          );
        }

        if (!response.ok) {
          const detail = await response.text().catch(() => "");
          const transient = response.status === 408 || response.status === 429 || response.status >= 500;
          const toolsRejected = !transient && rejectsToolsParameter(response.status, detail);
          const tooLarge = !transient && !toolsRejected && refusesRequestSize(response.status, detail);
          if (rejectsKey(response.status, detail)) noteKeyRejected(config.apiUrl, config.apiKey);
          const code: ModelAdapterErrorCode = toolsRejected
            ? "unsupported_tools"
            : tooLarge
              ? "request_too_large"
              : transient
                ? "transient"
                : response.status === 400 || response.status === 422
                  ? "invalid_request"
                  : "terminal";
          const label = config.httpErrorLabel ?? "Model provider";
          throw new OpenAICompatibleAdapterError(
            toolsRejected
              ? "The model provider does not support tools"
              : tooLarge
                ? "The model request exceeded the provider's size limit"
                : `${label} HTTP ${response.status}${detail ? `: ${httpErrorDetail(detail)}` : ""}`,
            code,
            false,  // HTTP errors are not retried (legacy path treats them as ChatProtocolError)
            false,
            emitted,
            tooLarge ? Buffer.byteLength(payload) : undefined,
          );
        }

        const contentType = response.headers.get("content-type") ?? "";
        if (!stream || contentType.includes("application/json")) {
          let completion: ChatResponse;
          try {
            completion = await response.json() as ChatResponse;
          } catch {
            throw protocolError("The model returned an unreadable JSON response", emitted);
          }
          const message = completion.choices?.[0]?.message;
          if (!message) throw protocolError("The model returned no completion message", emitted);
          if (typeof message.content === "string" && message.content) {
            emitted = true;
            yield { type: "content.delta", kind: "assistant_text", delta: message.content };
          }
          const calls = completeToolCalls(message.tool_calls);
          if (calls.length) {
            emitted = true;
            yield { type: "tool_calls", calls };
          }
          const usage = usageEvent(completion.usage);
          if (usage) yield usage;
          yield { type: "completed", finishReason: completion.choices?.[0]?.finish_reason ?? null };
          return;
        }

        if (!response.body) throw protocolError("The model returned no stream body", emitted);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const pending = new Map<number, PendingToolCall>();
        let buffer = "";
        let finishReason: string | null = null;
        let sawChoice = false;
        let usage: ModelEvent | null = null;
        let done = false;

        try {
          while (!done) {
            const chunk = await reader.read();
            if (chunk.done) {
              buffer += decoder.decode();
              break;
            }
            buffer += decoder.decode(chunk.value, { stream: true });
            let newline: number;
            while ((newline = buffer.indexOf("\n")) >= 0) {
              const line = buffer.slice(0, newline).trim();
              buffer = buffer.slice(newline + 1);
              if (!line.startsWith("data:")) continue;
              const data = line.slice(5).trim();
              if (data === "[DONE]") {
                done = true;
                break;
              }
              let update: ChatResponse;
              try {
                update = JSON.parse(data) as ChatResponse;
              } catch {
                throw protocolError("The model stream contained an incomplete JSON frame", emitted);
              }
              const usageUpdate = usageEvent(update.usage);
              if (usageUpdate) usage = usageUpdate;
              const choice = update.choices?.[0];
              if (choice) {
                sawChoice = true;
                const delta = choice.delta;
                if (typeof delta?.content === "string" && delta.content) {
                  emitted = true;
                  yield { type: "content.delta", kind: "assistant_text", delta: delta.content };
                }
                if (config.reasoning && delta?.reasoning_content) {
                  emitted = true;
                  yield { type: "content.delta", kind: "reasoning_text", delta: delta.reasoning_content };
                }
                addFragments(pending, delta?.tool_calls);
                if (choice.finish_reason) finishReason = choice.finish_reason;
              }
            }
          }
        } finally {
          await reader.cancel().catch(() => {});
        }

        if (buffer.trim().startsWith("data:")) {
          const tail = buffer.trim().slice(5).trim();
          if (tail !== "[DONE]") {
            let update: ChatResponse;
            try {
              update = JSON.parse(tail) as ChatResponse;
            } catch {
              throw protocolError("The model stream ended with an incomplete JSON frame", emitted);
            }
            const usageUpdate = usageEvent(update.usage);
            if (usageUpdate) usage = usageUpdate;
            const choice = update.choices?.[0];
            if (choice) {
              sawChoice = true;
              if (typeof choice.delta?.content === "string" && choice.delta.content) {
                emitted = true;
                yield { type: "content.delta", kind: "assistant_text", delta: choice.delta.content };
              }
              if (config.reasoning && choice.delta?.reasoning_content) {
                emitted = true;
                yield { type: "content.delta", kind: "reasoning_text", delta: choice.delta.reasoning_content };
              }
              addFragments(pending, choice.delta?.tool_calls);
              if (choice.finish_reason) finishReason = choice.finish_reason;
            }
          }
        }

        if (!sawChoice) throw protocolError("The model returned no streaming choice", emitted);
        const calls = finalizeToolCalls(pending, emitted);
        if (calls.length) {
          emitted = true;
          yield { type: "tool_calls", calls };
        }
        if (usage) yield usage;
        yield { type: "completed", finishReason };
      } catch (error) {
        if (error instanceof OpenAICompatibleAdapterError) throw error;
        if (request.signal.aborted) throw abortError(request.signal.reason);
        if (timeoutController.signal.aborted) {
          throw new OpenAICompatibleAdapterError("The model request timed out", "transient", true, !emitted, emitted);
        }
        throw new OpenAICompatibleAdapterError(
          emitted ? "The model stream failed after output started" : "The model stream failed before output started",
          "transient",
          true,
          !emitted,
          emitted,
        );
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
