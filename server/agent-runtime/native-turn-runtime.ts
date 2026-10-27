import { createHash } from "node:crypto";
import type {
  DriverCreateInput,
  ModelCatalog,
  ProviderInstance,
  RuntimeEvent,
  RuntimeEventListener,
  SendTurnInput,
  TextGenerationOptions,
} from "../contracts.ts";
import { newEventId, newId } from "../contracts.ts";
import { questionChoices } from "../../shared/ask-question.ts";
import { redactSecretsInText } from "../redact.ts";
import { toolDetailPreview } from "../tool-summary.ts";
import { type ChatToolDefinition } from "../drivers/chat-mcp-tools.ts";
import { assertImageTransport, chatImageBudget, chatUserContent, type ChatContentPart } from "../drivers/chat-images.ts";
import { promptHalves, volatileContextNote, withContextNote } from "../drivers/prompt-split.ts";
import { createChatToolApproval } from "../drivers/chat-tool-approval.ts";
import { ChatProtocolError, ChatReasoningDetails, ChatToolCalls, object, type ChatToolCall } from "../drivers/openai-chat-protocol.ts";

import { refusesRequestSize, RequestTooLargeError } from "../drivers/chat-size-limit.ts";
import { KEY_REJECTED_REASON, keyRejected, noteKeyAccepted, noteKeyRejected, rejectsKey } from "../key-rejections.ts";
import { rejectsToolsParameter } from "../tool-rejection.ts";
import type { AgentEngine, ModelAdapter } from "./contracts.ts";
import { runNativeTurn, type NativeSteerState } from "./turn-runtime.ts";
import { announcesAction } from "./announcement.ts";

export interface OpenAIChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ChatContentPart[] | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
  reasoning_content?: string;
  reasoning?: string;
  reasoning_details?: Record<string, unknown>[];
}

interface Usage {
  input: number;
  output: number;
}

interface Completion {
  text: string;
  reasoning: string;
  usage: Usage | null;
  toolCalls: ChatToolCall[];
  finishReason: string | null;
  protocolReasoning: string;
  protocolReasoningDetails: Record<string, unknown>[];
}

interface CompletionJson {
  model?: string;
  choices?: Array<{
    index?: number;
    message?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown; reasoning_details?: unknown; tool_calls?: unknown; function_call?: unknown };
    delta?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown; reasoning_details?: unknown; tool_calls?: unknown; function_call?: unknown };
    finish_reason?: string | null;
  }>;
  error?: unknown;
  base_resp?: { status_code?: unknown; status_msg?: unknown };
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number }; cost?: number };
  /** Groq reports streaming usage in its final x_groq envelope. */
  x_groq?: { usage?: CompletionJson["usage"] };
}

/** MiniMax reports auth, balance and parameter failures as `base_resp` with HTTP 200. */
function providerError(json: CompletionJson): string | null {
  if (typeof json.error === "string") return json.error;
  const error = object(json.error);
  if (error) return typeof error.message === "string" ? error.message : "unknown error";
  const code = json.base_resp?.status_code;
  if (typeof code === "number" && code !== 0) {
    const msg = typeof json.base_resp?.status_msg === "string" ? json.base_resp.status_msg : "";
    return `upstream error ${code}${msg ? `: ${msg}` : ""}`;
  }
  return null;
}

const MACHINE_CODE = /^[a-z][a-z0-9_]*$/;

/** A failed response's own error message, then its machine code (trial-credit.ts parses it), else the raw body. */
function httpErrorDetail(body: string, limit = 500): string {
  let json: CompletionJson | undefined;
  try { json = object(JSON.parse(body)); } catch { json = undefined; }
  const message = json ? providerError(json) : null;
  if (!message || message === "unknown error") return body.slice(0, limit);
  const code = object(json?.error)?.code;
  const suffix = typeof code === "string" && MACHINE_CODE.test(code) ? ` (${code})` : "";
  return message.slice(0, limit) + suffix;
}

interface NativeLog {
  source: string;
  outgoing(turn: SendTurnInput, messages: OpenAIChatMessage[], model: string, tools: ChatToolDefinition[]): unknown;
  incoming(completion: Completion): unknown;
}

interface RuntimeOptions<Config> {
  input: DriverCreateInput<Config>;
  driverKind: string;
  apiKey: string;
  apiUrl: string;
  models: () => ModelCatalog;
  requestBody(model: string, messages: OpenAIChatMessage[], stream: boolean): Record<string, unknown>;
  httpErrorLabel: string;
  missingKeyError: string;
  unavailableReason: string;
  timeoutMs: number;
  nativeLog: NativeLog;
  refreshModels?: () => Promise<void>;
  generateModel?: () => string;
  reasoning?: boolean;
  /** Cerebras rejects `reasoning_content` and takes `reasoning`. */
  reasoningReplayField?: "reasoning_content" | "reasoning";
  contentText?: (content: unknown) => string;
  billing?: "metered";
  includeUsageInCompleted?: boolean;
  noBodyError?: string;
  retryScale?: number;
  tools?: boolean;
  computerUse?: boolean;
  /** A text-only model keeps the computer and browser tools but never receives a screenshot or attachment. */
  imageInput?: (model: string) => boolean;
  /** Smaller models announce a step and end the turn without calling a tool; such a reply gets a nudge, at most three
   * per turn and each only after tool progress since the last. */
  nudgeAnnouncedAction?: boolean;
  /** Test/rollout hook: run this turn through the OMB-owned Agent Runtime. */
  nativeAgentEngine?: AgentEngine;
  /** Optional protocol adapter for text-only helpers (titles/summaries). Defaults to OpenAI chat-completions via complete(). */
  modelAdapter?: ModelAdapter;
}

const usageFrom = (usage: CompletionJson["usage"]): Usage | null =>
  usage
    ? { input: usage.prompt_tokens ?? 0, output: usage.completion_tokens ?? 0 }
    : null;

const completionUsage = (json: CompletionJson) => json.usage ?? json.x_groq?.usage;

class UnsupportedChatToolsError extends Error {}

interface DeliveredUserMessage {
  text: string;
  sent: string;
  volatile?: string;
  after: string;
}

const MAX_REPLAY_EXTRA_BYTES = 24_000;
const MAX_DELIVERED_THREADS = 256;

const fingerprint = (text: string) => createHash("sha256").update(text).digest("base64url");

function replayDelivered(
  transcript: ReadonlyArray<{ role: "user" | "assistant"; text: string }>,
  records: readonly DeliveredUserMessage[],
): { content: Map<number, string>; matched: DeliveredUserMessage[]; volatile: string | undefined } {
  const found: Array<{ index: number; record: DeliveredUserMessage }> = [];
  let next = records.length - 1;
  for (let index = transcript.length - 1; index >= 0 && next >= 0; index--) {
    const message = transcript[index]!;
    if (message.role !== "user" || !message.text) continue;
    const after = index > 0 ? fingerprint(transcript[index - 1]!.text) : undefined;
    for (let at = next; at >= 0; at--) {
      const record = records[at]!;
      if (record.text !== message.text && !record.text.endsWith("\n\n" + message.text)) continue;
      if (after !== undefined && record.after !== after) continue;
      found.unshift({ index, record });
      next = at - 1;
      break;
    }
  }
  const content = new Map<number, string>();
  let volatile: string | undefined;
  let budget = MAX_REPLAY_EXTRA_BYTES;
  for (const { index, record } of found) {
    const extra = Buffer.byteLength(record.sent) - Buffer.byteLength(transcript[index]!.text);
    if (extra > budget) break;
    budget -= extra;
    content.set(index, record.sent);
    if (record.volatile !== undefined) volatile = record.volatile;
  }
  return { content, matched: found.map(({ record }) => record), volatile };
}

export { announcesAction };

const TEXT_ONLY_ATTACHMENT_NOTE = "[The person attached image(s), but this model cannot see images. Say so if the request depends on them.]";

class UnsupportedReasoningReplayError extends Error {}

/** DeepSeek-style providers need `reasoning_content` echoed on a tool-call message; Groq rejects it. */
function rejectsReasoningReplay(status: number, body: string): boolean {
  if (status !== 400 && status !== 422) return false;
  let envelope: Record<string, unknown> | undefined;
  try { envelope = object(JSON.parse(body)); } catch { return false; }
  const message = object(envelope?.error)?.message ?? envelope?.error;
  return typeof message === "string" && /\breasoning_content\b/.test(message) &&
    /\b(?:unsupported|not supported|unknown|unrecognized|unexpected|not permitted|not allowed)\b/i.test(message);
}

/** Groq fails a completion with `tool_use_failed` when a generated tool call is invalid: usually a
 *  tool it was not offered (gpt-oss inventing a "json" tool), sometimes arguments missing the schema. */
class RejectedToolCallError extends ChatProtocolError {
  readonly refusal: Record<string, unknown>;
  constructor(message: string, refusal: Record<string, unknown>) {
    super(message);
    this.refusal = refusal;
  }
}

const toolCallRefusal = (error: unknown) => {
  const body = object(error);
  return body?.code === "tool_use_failed" ? body : undefined;
};

function refusedToolCall(status: number, body: string) {
  if (status !== 400) return undefined;
  try { return toolCallRefusal(object(JSON.parse(body))?.error); } catch { return undefined; }
}

function completionError(json: CompletionJson, label: string): ChatProtocolError | null {
  const message = providerError(json);
  if (!message) return null;
  const text = `provider returned a ${label}: ${message.slice(0, 200)}`;
  const refusal = toolCallRefusal(json.error);
  return refusal ? new RejectedToolCallError(text, refusal) : new ChatProtocolError(text);
}



export interface NativeTurnRuntime {
  readonly sendTurn: (input: import("../contracts.ts").SendTurnInput) => Promise<import("../contracts.ts").TurnStartResult>;
}

export function createNativeTurnRuntime<Config>(options: RuntimeOptions<Config>): ProviderInstance {
  const { input } = options;
  const listeners = new Set<RuntimeEventListener>();
  const active = new Map<string, {
    abort: AbortController;
    turnId: string;
    done: Promise<void>;
    approval: ReturnType<typeof createChatToolApproval>;
    /** Mid-turn input parked by adapter.steer, spliced in at the next round, never mid-tool-batch. */
    asides: string[];
    /** This turn runs the OMB Agent Runtime; steering is forwarded to the live run. */
    native?: boolean;
    /** Native steering lands here once the run exists; before that, text is queued. */
    nativeSteer?: (text: string) => Promise<"steered" | "refused">;
    /** Set once the turn stops taking rounds: a later steer goes to the next turn instead. */
    ending: boolean;
  }>();
  const delivered = new Map<string, DeliveredUserMessage[]>();
  /** Not cleared on `sessionReset`: with no cursor the harness sends it on nearly every turn. */
  const sessionGrants = new Map<string, Set<string>>();

  const emit = (event: RuntimeEvent) => {
    for (const listener of Array.from(listeners)) listener(event);
  };
  const base = (threadId: string, turnId: string) => ({
    eventId: newEventId(),
    provider: options.driverKind,
    threadId,
    turnId,
    createdAt: new Date().toISOString(),
  });

  const complete = async (
    messages: OpenAIChatMessage[],
    model: string,
    stream: boolean,
    signal?: AbortSignal,
    onDelta?: (delta: string, kind: "assistant_text" | "reasoning_text") => void,
    tools: ChatToolDefinition[] = [],
    onUsage?: TextGenerationOptions["onUsage"],
  ): Promise<Completion> => {
    const timeoutController = new AbortController();
    let idleTimer: NodeJS.Timeout | null = null;
    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        timeoutController.abort(new DOMException("Streaming idle timeout elapsed", "AbortError"));
      }, options.timeoutMs);
    };

    resetIdleTimer();

    try {
      const activeSignal = signal
        ? AbortSignal.any([signal, timeoutController.signal])
        : timeoutController.signal;

      const payload = JSON.stringify({
        ...options.requestBody(model, messages, stream),
        ...(tools.length ? { tools } : {}),
      });
      const response = await fetch(`${options.apiUrl}/chat/completions`, {
        method: "POST",
        ...(messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === "image_url")) ? { redirect: "error" as const } : {}),
        headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
        body: payload,
        signal: activeSignal,
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        if (rejectsKey(response.status, body)) noteKeyRejected(options.apiUrl, options.apiKey);
        const message = `${options.httpErrorLabel} HTTP ${response.status}${body ? `: ${httpErrorDetail(body)}` : ""}`;
        if (refusesRequestSize(response.status, body)) throw new RequestTooLargeError(message, Buffer.byteLength(payload));
        if (rejectsToolsParameter(response.status, body)) throw new UnsupportedChatToolsError(message);
        const refusal = refusedToolCall(response.status, body);
        if (refusal) throw new RejectedToolCallError(message, refusal);
        if (messages.some((entry) => entry.reasoning_content !== undefined) && rejectsReasoningReplay(response.status, body)) {
          throw new UnsupportedReasoningReplayError(message);
        }
        throw new Error(message);
      }
      noteKeyAccepted(options.apiUrl, options.apiKey);

      if (!stream || response.headers.get("content-type")?.includes("application/json")) {
        const json = await response.json() as CompletionJson;
        const tokenUsage = completionUsage(json);
        if (onUsage) {
          activeSignal.throwIfAborted();
          const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
          onUsage({
            model: typeof json.model === "string" && json.model.trim() ? json.model : model,
            input: count(tokenUsage?.prompt_tokens),
            output: count(tokenUsage?.completion_tokens),
            cachedInput: count(tokenUsage?.prompt_tokens_details?.cached_tokens),
            costUsd: count(tokenUsage?.cost),
          });
        }
        const bodyError = completionError(json, "completion error");
        if (bodyError) throw bodyError;
        const message = json.choices?.[0]?.message;
        if (!message || !object(message) || !["content", "reasoning_content", "reasoning", "reasoning_details", "tool_calls", "function_call"].some((key) => key in message)) {
          throw new ChatProtocolError("provider returned no completion message");
        }
        if (message?.function_call) throw new ChatProtocolError("legacy function_call is unsupported; use structured tool_calls");
        const calls = new ChatToolCalls();
        calls.add(message?.tool_calls, false);
        const details = new ChatReasoningDetails();
        details.add(message.reasoning_details);
        const reasoning = message.reasoning_content ?? message.reasoning;
        const finishReason = json.choices?.[0]?.finish_reason ?? null;
        activeSignal.throwIfAborted();
        return {
          text: options.contentText ? options.contentText(message?.content) : typeof message?.content === "string" ? message.content : "",
          reasoning: options.reasoning && typeof reasoning === "string"
            ? reasoning
            : "",
          usage: usageFrom(tokenUsage),
          toolCalls: calls.finish(finishReason, false),
          finishReason,
          protocolReasoning: typeof reasoning === "string" ? reasoning : "",
          protocolReasoningDetails: details.blocks,
        };
      }

      if (!response.body) {
        throw new Error(options.noBodyError ?? `${options.httpErrorLabel} returned no response body`);
      }
      let text = "";
      let reasoning = "";
      let protocolReasoning = "";
      let usage: Usage | null = null;
      let finishReason: string | null = null;
      let malformedFrame = false;
      let sawChoice = false;
      const calls = new ChatToolCalls();
      const details = new ChatReasoningDetails();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const consumeDataLine = (line: string, atEof = false): boolean => {
        if (!line.startsWith("data:")) return false;
        const data = line.slice(5).trim();
        if (data === "[DONE]") return true;
        let chunk: CompletionJson;
        try {
          chunk = JSON.parse(data) as CompletionJson;
        } catch {
          // A tail left when the socket closed is an incomplete frame (stop, abort, drop), not a malformed one.
          if (!atEof) malformedFrame = true;
          return false;
        }
        const chunkError = completionError(chunk, "streaming completion error");
        if (chunkError) throw chunkError;
        const choice = chunk.choices?.find((row) => row.index === undefined || row.index === 0);
        const delta = choice?.delta;
        if (object(delta)) sawChoice = true;
        if (delta?.function_call) throw new ChatProtocolError("legacy function_call is unsupported; use structured tool_calls");
        calls.add(delta?.tool_calls, true);
        details.add(delta?.reasoning_details);
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        const reasoningPart = delta?.reasoning_content ?? delta?.reasoning;
        if (typeof reasoningPart === "string") protocolReasoning += reasoningPart;
        const reasoningDelta = options.reasoning && typeof reasoningPart === "string"
          ? reasoningPart
          : "";
        const contentDelta = options.contentText ? options.contentText(delta?.content) : typeof delta?.content === "string" ? delta.content : "";
        if (reasoningDelta) {
          reasoning += reasoningDelta;
          onDelta?.(reasoningDelta, "reasoning_text");
        }
        if (contentDelta) {
          text += contentDelta;
          onDelta?.(contentDelta, "assistant_text");
        }
        const tokenUsage = completionUsage(chunk);
        if (tokenUsage) usage = usageFrom(tokenUsage);
        return false;
      };
      try {
        readLoop: for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            buffer += decoder.decode();
            const line = buffer.trim();
            if (line && line !== "data: [DONE]") consumeDataLine(line, true);
            // MiniMax's api.minimax.io/v1 closes the connection after the
            // finish_reason chunk and never sends `[DONE]`.
            if (buffer.trim() === "data: [DONE]" || finishReason) break;
            if (!sawChoice) {
              let body: CompletionJson | undefined;
              try { body = JSON.parse(buffer) as CompletionJson; } catch { body = undefined; }
              const bodyError = body ? completionError(body, "completion error") : null;
              if (bodyError) throw bodyError;
            }
            throw new ChatProtocolError("Stream ended before completion");
          }
          resetIdleTimer();
          buffer += decoder.decode(value, { stream: true });
          if (buffer.length > 2_000_000) throw new ChatProtocolError("provider stream frame exceeded the size limit");
          let newline: number;
          while ((newline = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (consumeDataLine(line)) break readLoop;
          }
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      activeSignal.throwIfAborted();
      if (!sawChoice) throw new ChatProtocolError("provider returned no streaming completion choice");
      return { text, reasoning, usage, toolCalls: calls.finish(finishReason, malformedFrame), finishReason, protocolReasoning, protocolReasoningDetails: details.blocks };
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
    }
  };

  const seesImages = (turn: SendTurnInput) =>
    options.imageInput?.(turn.model || options.models().default) ?? true;
  const messagesFor = (turn: SendTurnInput): OpenAIChatMessage[] => {
    const halves = promptHalves(turn);
    const transcript = turn.transcript ?? [];
    const replay = replayDelivered(transcript, delivered.get(turn.threadId) ?? []);
    const volatile = halves.volatile.trim();
    const note = halves.stable === null || (!turn.mentionTurn && replay.volatile === volatile) ? ""
      : volatileContextNote(volatile, Boolean(replay.volatile));
    const textOnly = (text: string) => !options.computerUse || seesImages(turn) || !turn.images?.length ? text
      : `${text}\n\n${TEXT_ONLY_ATTACHMENT_NOTE}`;
    const userTurn = note ? { ...turn, text: withContextNote(note, turn.text) } : turn;
    const content = options.computerUse && seesImages(turn) ? chatUserContent(userTurn) : textOnly(userTurn.text);
    const kept = turn.recalled ? turn.text.replace(`${turn.recalled}\n\n`, "") : turn.text;
    const record = {
      text: kept,
      sent: textOnly(withContextNote(note, kept)),
      ...(note ? { volatile } : {}),
      after: transcript.length ? fingerprint(transcript.at(-1)!.text) : "",
    };
    delivered.delete(turn.threadId);
    delivered.set(turn.threadId, [...replay.matched, record]);
    if (delivered.size > MAX_DELIVERED_THREADS) delivered.delete(delivered.keys().next().value!);
    const system = halves.stable ?? turn.system;
    return [
      ...(system ? [{ role: "system" as const, content: system }] : []),
      ...transcript.map((message, index) => ({
        role: message.role,
        content: replay.content.get(index) ?? message.text,
      })),
      { role: "user", content },
    ];
  };

  const sendTurn = async (turn: SendTurnInput) => {
    if (!options.apiKey) throw new Error(options.missingKeyError);
    if (active.has(turn.threadId)) throw new Error("a turn is already running on this thread");
    if (options.computerUse && (turn.images?.length || turn.integrations?.localComputer || turn.integrations?.browser)) assertImageTransport(options.apiUrl);

    const turnId = newId();
    const abort = new AbortController();
    const messages = messagesFor(turn);
    const retainImages = chatImageBudget();
    for (const message of messages) retainImages(message.content);
    const model = turn.model || options.models().default;
    const secrets = [options.apiKey].filter((value): value is string => Boolean(value));
    for (const integration of Object.values(turn.integrations ?? {})) {
      const entries = object(integration);
      const specs = entries && "command" in entries ? [entries] : Object.values(entries ?? {}).map(object);
      for (const spec of specs) {
        for (const [key, value] of Object.entries(object(spec?.env) ?? {})) {
          if (/key|token|password|secret|authorization/i.test(key) && typeof value === "string" && value) secrets.push(value);
        }
      }
    }
    const safeText = (text: string) => {
      let safe = text;
      for (const secret of secrets) if (secret) safe = safe.split(secret).join("[redacted]");
      return redactSecretsInText(safe);
    };
    const preview = (value: unknown) => toolDetailPreview(JSON.parse(JSON.stringify(value, (_key, part) =>
      typeof part === "string" ? safeText(part) : part)));
    const grantsKey = JSON.stringify([turn.threadId, turn.botId ?? null]);
    const granted = sessionGrants.get(grantsKey) ?? new Set<string>();
    sessionGrants.delete(grantsKey);
    sessionGrants.set(grantsKey, granted);
    if (sessionGrants.size > MAX_DELIVERED_THREADS) sessionGrants.delete(sessionGrants.keys().next().value!);
    const approval = createChatToolApproval({
      signal: abort.signal,
      granted: turn.guestConfined ? undefined : granted,
      open: (ask) => emit({
        ...base(turn.threadId, turnId), type: "request.opened", requestType: "permission",
        requestId: ask.id, tool: ask.tool, summary: ask.summary, allowSession: ask.grant !== undefined,
      }),
      resolved: (ask, allowed, source) => emit({
        ...base(turn.threadId, turnId), type: "request.resolved", requestId: ask.id,
        behavior: allowed ? "allow" : "deny", source,
      }),
      openQuestion: (ask, questions) => {
        const choices = questionChoices(questions);
        emit({
          ...base(turn.threadId, turnId), type: "request.opened", requestType: "question",
          requestId: ask.id, tool: ask.tool, summary: ask.summary,
          questions, ...(choices ? { choices } : {}),
        });
      },
      resolvedQuestion: (ask, answered, source) => emit({
        ...base(turn.threadId, turnId), type: "request.resolved", requestId: ask.id,
        behavior: answered ? "answer" : "deny", source,
      }),
    });
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => { resolveDone = resolve; });
    const turnEntry = {
      abort, turnId, done, approval, asides: [] as string[], native: false,
      nativeSteer: undefined as ((text: string) => Promise<"steered" | "refused">) | undefined,
      ending: false,
    };
    active.set(turn.threadId, turnEntry);
    emit({ ...base(turn.threadId, turnId), type: "turn.started" });
    emit({ ...base(turn.threadId, turnId), type: "session.started", sessionId: null, model });

    if (options.nativeAgentEngine) {
      const nativeEngine = options.nativeAgentEngine;
      turnEntry.native = true;
      const steerState: NativeSteerState = { queue: [] };
      turnEntry.nativeSteer = (text) => {
        if (!steerState.impl) {
          steerState.queue.push(text);
          return Promise.resolve("steered");
        }
        return steerState.impl(text);
      };
      void runNativeTurn({
        turn,
        messages,
        model,
        turnId,
        abort,
        approval,
        engine: nativeEngine,
        driverKind: options.driverKind,
        apiUrl: options.apiUrl,
        httpErrorLabel: options.httpErrorLabel,
        toolsEnabled: () => options.tools !== false,
        computerUse: options.computerUse === true,
        nudgeAnnouncedAction: options.nudgeAnnouncedAction === true,
        emit,
        base,
        safeText,
        preview,
        steer: steerState,
        onSettled: () => {
          turnEntry.ending = true;
          active.delete(turn.threadId);
          resolveDone();
        },
      });
      return { turnId };
    }

    return { turnId };
  };

  return {
    instanceId: input.instanceId,
    driverKind: options.driverKind,
    displayName: input.displayName,
    enabled: input.enabled,
    get models() {
      return options.models();
    },
    ...(options.refreshModels ? { refreshModels: options.refreshModels } : {}),
    snapshot: async () => {
      if (!options.apiKey) return { state: "unavailable", reason: options.unavailableReason };
      if (keyRejected(options.apiUrl, options.apiKey)) return { state: "available", authenticated: false, reason: KEY_REJECTED_REASON, version: null };
      return { state: "available", authenticated: true, version: null, ...(options.billing ? { billing: options.billing } : {}) };
    },
    adapter: {
      provider: options.driverKind,
      capabilities: { ...(options.computerUse ? { computerMcp: options.tools !== false,
        localComputerMcp: options.tools !== false,
        browserMcp: options.tools !== false, nativeImageInput: true, images: true } : {}),
        sessionModelSwitch: "in-session", customMcp: options.tools !== false, agentsMcp: options.tools !== false, composioMcp: options.tools !== false,
        dataMcp: options.tools !== false,
        highlevelMcp: options.tools !== false,
        deviceMcp: options.tools !== false,
        queueing: true,
        guestTurns: "confined" },
      sendTurn,
      interruptTurn: async (threadId, turnId) => {
        const turn = active.get(threadId);
        if (!turn || (turnId && turn.turnId !== turnId)) return;
        turn.abort.abort();
        await turn.done;
      },
      respondToRequest: async (threadId, requestId, decision) =>
        active.get(threadId)?.approval.answer(requestId, decision.behavior, decision.message, decision.always) ?? "unavailable",
      steer: async (threadId, text) => {
        const running = active.get(threadId);
        if (!running || running.ending) return "refused";
        if (running.native) return running.nativeSteer?.(text) ?? "refused";
        running.asides.push(text);
        return "steered";
      },
      hasSession: (threadId) => active.has(threadId),
      stopAll: async () => {
        const turns = [...active.values()];
        for (const turn of turns) turn.abort.abort();
        await Promise.all(turns.map((turn) => turn.done));
      },
      onEvent: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    nativeTurnRuntime: { sendTurn },
    generateText: async (prompt, { signal, onUsage, model: named } = {}) => {
      const model = named ?? options.generateModel?.() ?? options.models().default;
      if (options.modelAdapter) {
        let text = "";
        let reasoning = "";
        for await (const event of options.modelAdapter.generate({ messages: [{ role: "user", content: prompt }], model, tools: [], signal: signal ?? new AbortController().signal })) {
          if (event.type === "content.delta" && event.kind === "assistant_text") text += event.delta;
          if (event.type === "content.delta" && event.kind === "reasoning_text") reasoning += event.delta;
          if (event.type === "usage" && onUsage) onUsage({ model, input: event.input, output: event.output });
        }
        return text.trim() ? text : reasoning;
      }
      const { text, reasoning, toolCalls } = await complete([{ role: "user", content: prompt }], model, false, signal, undefined, [], onUsage);
      if (toolCalls.length) throw new ChatProtocolError("provider returned tool calls to a text-only helper");
      return text.trim() ? text : reasoning;
    },
    dispose: async () => {
      const turns = [...active.values()];
      for (const turn of turns) turn.abort.abort();
      await Promise.all(turns.map((turn) => turn.done));
      listeners.clear();
    },
  };
}
