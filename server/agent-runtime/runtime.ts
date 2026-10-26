import { randomUUID } from "node:crypto";

import { computeBackoff, interruptibleDelay, RETRY_MAX_ATTEMPTS } from "../drivers/retry.ts";
import { announcesAction, MAX_ANNOUNCEMENT_NUDGES, NUDGE_ANNOUNCED_ACTION } from "./announcement.ts";
import { createRunScopedCapabilitySession, TOOL_OUTPUT_READ_CAPABILITY } from "./capability-runtime.ts";
import type {
  AgentEngine,
  AgentEvent,
  AgentRunRecord,
  AgentRunRequest,
  AgentRunStatus,
  AgentRunStore,
  CapabilityCall,
  CapabilityResult,
  ModelAdapter,
  ModelAdapterError,
  ModelContentPart,
  ModelMessage,
  ModelToolCall,
} from "./contracts.ts";

const MAX_MODEL_ROUNDS = 64;
const MAX_TOOL_CALLS = 200;
/** Mirrors the chat image budget: 32 MiB of encoded base64 per run. */
const MAX_ENCODED_IMAGE_BYTES = Math.ceil(32 * 1024 * 1024 / 3) * 4;

class AgentRuntimeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "AgentRuntimeError";
  }
}

function isModelAdapterError(error: unknown): error is ModelAdapterError {
  if (!(error instanceof Error)) return false;
  const candidate = error as ModelAdapterError;
  return ["transient", "unsupported_capability", "unsupported_tools", "request_too_large", "invalid_request", "terminal"].includes(candidate.code)
    && typeof candidate.retryable === "boolean"
    && typeof candidate.retrySafe === "boolean"
    && typeof candidate.requestStarted === "boolean";
}

function errorCode(error: unknown): string {
  if (error instanceof AgentRuntimeError) return error.code;
  if (isModelAdapterError(error)) return error.code;
  return "terminal";
}

function safeMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.slice(0, 2_000);
  return "The native agent run failed.";
}

function modelEventFailure(message: string): AgentRuntimeError {
  return new AgentRuntimeError("invalid_model_response", message);
}

const OMITTED_IMAGE = "[image omitted to fit the provider's size limit]";
const SHORT_TOOL_CHARS = 2_000;
const COMPACTION_KEEP_TOKENS = 20_000;
const COMPACTION_MIN_MESSAGES = 6;
const COMPACTION_MAX_PER_RUN = 3;
const COMPACTION_MIN_MESSAGE_GAP = 4;
const DEFAULT_CONTEXT_WINDOW = 128_000;
const SUMMARY_CLIP_CHARS = 2_000;
const SUMMARY_TRANSCRIPT_CHARS = 120_000;
const TOOL_OUTPUT_PROMPT_CHARS = 8_000;

const SUMMARY_PROMPT = [
  "You are compacting an agent conversation so it can continue in a smaller context window.",
  "Preserve, in this order: the person's objective and constraints; decisions already made; files read or changed (exact paths); commands, tests, and their results; unresolved errors and risks; exact identifiers the next turn needs.",
  "Drop greetings, repeated reasoning, and superseded plans. Do not invent facts. Output only the summary, in compact Markdown.",
].join(" ");

function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 4);
}

function contextBudget(contextWindow: { readonly status: "known"; readonly value: number } | { readonly status: "unknown" }): { readonly window: number; readonly trigger: number } {
  const window = contextWindow.status === "known" ? contextWindow.value : DEFAULT_CONTEXT_WINDOW;
  const reserve = Math.max(16_000, Math.floor(window * 0.15));
  return { window, trigger: Math.max(Math.floor(window / 2), window - reserve) };
}

/** Keep the newest messages within the token budget, then move the cut so the kept slice never starts with an
 * orphan tool result. An assistant carrying tool calls may start the slice; its results follow it. */
function chooseCompactionCut(messages: readonly ModelMessage[], keepTokens: number): number {
  let total = 0;
  let cut = messages.length;
  for (let index = messages.length - 1; index >= 0; index--) {
    const tokens = estimateTokens(messages[index]);
    if (total + tokens > keepTokens) break;
    total += tokens;
    cut = index;
  }
  while (cut > 0 && messages[cut]?.role === "tool") cut--;
  return cut;
}

function compactionTranscript(messages: readonly ModelMessage[]): string {
  const lines: string[] = [];
  let used = 0;
  for (const message of messages) {
    const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
    const text = content.length > SUMMARY_CLIP_CHARS ? `${content.slice(0, SUMMARY_CLIP_CHARS)}…` : content;
    const calls = message.toolCalls?.length
      ? `\nTOOL CALLS: ${message.toolCalls.map((call) => `${call.name}(${JSON.stringify(call.arguments)})`).join("; ")}`
      : "";
    const line = `${message.role.toUpperCase()}: ${text}${calls}`;
    if (used + line.length > SUMMARY_TRANSCRIPT_CHARS) break;
    lines.push(line);
    used += line.length;
  }
  return lines.join("\n\n");
}

/** Keep the system prompt and the recent block; replace images with text and shorten tool outputs. Dropping older
 * history never repeats a tool call, and the current turn's assistant/tool messages stay together. */
function shrinkMessages(messages: readonly ModelMessage[], attempt: number): ModelMessage[] | null {
  const system = messages.filter((message) => message.role === "system");
  const rest = messages.filter((message) => message.role !== "system");
  const lastUser = rest.findLastIndex((message) => message.role === "user");
  if (lastUser < 0) return null;
  const keepFrom = Math.max(0, lastUser - (attempt === 0 ? 8 : 2));
  const dropped = keepFrom;
  const kept = rest.slice(keepFrom).map((message) => {
    const content = message.content;
    if (content === null || content === undefined) return message;
    const shrunk = Array.isArray(content)
      ? content.map((part) => part.type === "image" ? { type: "text" as const, text: OMITTED_IMAGE } : part)
      : message.role === "tool" && content.length > SHORT_TOOL_CHARS
        ? `${content.slice(0, SHORT_TOOL_CHARS)}\n[tool output shortened to fit the provider's size limit]`
        : content;
    return { ...message, content: shrunk };
  });
  const note: ModelMessage[] = dropped > 0
    ? [{ role: "assistant", content: `[${dropped} earlier message${dropped === 1 ? "" : "s"} omitted to fit the provider's size limit; the full history remains in the app.]` }]
    : [];
  return [...system, ...note, ...kept];
}

export function createAgentEngine(dependencies: {
  readonly adapters: { resolve(ref: AgentRunRecord["providerModel"]): ModelAdapter };
  readonly store: AgentRunStore;
}): AgentEngine {
  const active = new Map<string, {
    readonly threadId: string;
    readonly controller: AbortController;
    readonly steers: string[];
    finishing: boolean;
  }>();
  const activeByThread = new Map<string, string>();
  const listeners = new Map<string, Set<(event: AgentEvent) => void>>();

  const emit = (threadId: string, event: AgentEvent) => {
    for (const listener of Array.from(listeners.get(threadId) ?? [])) listener(event);
  };

  const transition = (runId: string, from: AgentRunStatus, to: AgentRunStatus, failureCode?: string): void => {
    if (!dependencies.store.transitionRun(runId, from, to, Date.now(), failureCode)) {
      throw new AgentRuntimeError("run_state_conflict", `Could not transition run from ${from} to ${to}`);
    }
  };

  return {
    engineId: "omb-native",

    async run(request: AgentRunRequest) {
      if (activeByThread.has(request.threadId)) throw new AgentRuntimeError("thread_busy", "A native run is already active for this thread");

      const runId = randomUUID();
      const runCapabilities = createRunScopedCapabilitySession(request.capabilities, { runId, store: dependencies.store });
      const startedAt = Date.now();
      dependencies.store.createRun({
        runId,
        engineId: "omb-native",
        providerModel: request.providerModel,
        status: "queued",
        threadId: request.threadId,
        botId: request.botId,
        startedAt,
        updatedAt: startedAt,
        modelRounds: 0,
        toolCalls: 0,
      });

      const controller = new AbortController();
      const signal = AbortSignal.any([request.signal, controller.signal]);
      const control = { threadId: request.threadId, controller, steers: [] as string[], finishing: false };
      active.set(runId, control);
      activeByThread.set(request.threadId, runId);

      const done = Promise.resolve().then(async () => {
        const runStatus: { value: AgentRunStatus } = { value: "queued" };
        let modelRounds = 0;
        let toolCalls = 0;
        let outputVisible = false;
        let capabilityDispatched = false;
        let capabilityFailure = false;
        let completed = false;
        let stopReason: string | null = null;
        let failure: unknown;
        let sessionClosed = false;
        const initialImages = request.images ?? [];
        let encodedImages = initialImages.reduce((total, image) => total + image.data.length, 0);
        if (encodedImages > MAX_ENCODED_IMAGE_BYTES) {
          throw new AgentRuntimeError("image_budget_exceeded", "Turn image budget exceeded (32 MiB encoded); the turn was not sent.");
        }
        const userContent: ModelMessage["content"] = initialImages.length
          ? [
              { type: "text", text: request.text },
              ...initialImages.map((image): ModelContentPart => ({ type: "image", mimeType: image.mimeType, data: image.data })),
            ]
          : request.text;
        const messages: ModelMessage[] = [...request.messages, { role: "user", content: userContent }];
        const seenCallIds = new Set<string>();
        let nudges = 0;
        let callsAtNudge = -1;

        const progress = () => dependencies.store.updateRunProgress(runId, { modelRounds, toolCalls, updatedAt: Date.now() });
        const updateStatus = (next: AgentRunStatus, code?: string) => {
          transition(runId, runStatus.value, next, code);
          runStatus.value = next;
        };
        const closeSession = async () => {
          if (sessionClosed) return;
          sessionClosed = true;
          await runCapabilities.close();
        };

        try {
          signal.throwIfAborted();
          updateStatus("running");
          emit(request.threadId, { type: "run.started", runId, engineId: "omb-native", providerModel: request.providerModel });

          const adapter = dependencies.adapters.resolve(request.providerModel);
          const modelCapabilities = adapter.capabilities(request.providerModel.modelId);
          const budget = contextBudget(modelCapabilities.contextWindow);
          const runBudget = request.budget;
          const runStartedAt = Date.now();
          let budgetExhausted = false;
          let totalTokens = 0;
          let totalCost = 0;
          let hasCost = false;
          let compactions = 0;
          let lastCompactAttempt = 0;
          const compact = async (trigger: "auto" | "overflow"): Promise<boolean> => {
            lastCompactAttempt = messages.length;
            if (compactions >= COMPACTION_MAX_PER_RUN || messages.length < COMPACTION_MIN_MESSAGES) return false;
            const system = messages.filter((message) => message.role === "system");
            const body = messages.filter((message) => message.role !== "system");
            const cut = chooseCompactionCut(body, COMPACTION_KEEP_TOKENS);
            if (cut <= 0 || cut >= body.length - 1) return false;
            const older = body.slice(0, cut);
            if (older.length < 2) return false;
            const transcript = compactionTranscript(older);
            if (!transcript.trim()) return false;
            modelRounds++;
            progress();
            let summary = "";
            try {
              for await (const event of adapter.generate({
                messages: [
                  { role: "system", content: SUMMARY_PROMPT },
                  { role: "user", content: transcript },
                ],
                model: request.providerModel.modelId,
                tools: [],
                signal,
              })) {
                if (event.type === "content.delta" && event.kind === "assistant_text") summary += event.delta;
              }
            } catch {
              return false;
            }
            summary = summary.trim();
            if (!summary) return false;
            const firstKept = body[cut]!;
            const summaryMessage: ModelMessage = {
              role: firstKept.role === "assistant" ? "user" : "assistant",
              content: `[Earlier conversation summary — ${older.length} message${older.length === 1 ? "" : "s"} compacted to fit the model window. The full transcript remains in the app.]\n\n${summary}`,
            };
            messages.splice(0, messages.length, ...system, summaryMessage, ...body.slice(cut));
            compactions++;
            const tokenEstimate = estimateTokens(messages);
            dependencies.store.recordCompaction?.({
              runId,
              sequence: compactions,
              summary,
              firstKeptIndex: cut,
              tokenEstimate,
              trigger,
              createdAt: Date.now(),
            });
            emit(request.threadId, { type: "run.compacted", runId, summary, firstKeptIndex: cut, tokenEstimate, trigger });
            return true;
          };
          let allowTools = true;
          let sizeRetries = 0;
          while (modelRounds < MAX_MODEL_ROUNDS) {
            signal.throwIfAborted();
            if (control.steers.length) {
              for (const text of control.steers.splice(0)) messages.push({ role: "user", content: text });
            }
            if (runBudget?.maxWallTimeMs && Date.now() - runStartedAt > runBudget.maxWallTimeMs) {
              budgetExhausted = true;
            }
            if (budgetExhausted) {
              throw new AgentRuntimeError("budget_exhausted", "Turn stopped at the configured token, cost, or time budget.");
            }
            if (
              compactions < COMPACTION_MAX_PER_RUN
              && messages.length - lastCompactAttempt >= COMPACTION_MIN_MESSAGE_GAP
              && estimateTokens(messages) > budget.trigger
            ) {
              await compact("auto");
            }
            let toolDescriptors = allowTools ? runCapabilities.list(request.grant) : [];
            if (toolDescriptors.length > 0 && modelCapabilities.tools !== "supported") {
              throw new AgentRuntimeError("unsupported_capability", "The selected model is not verified for structured tool calls");
            }

            let responseText = "";
            let responseCalls: ReadonlyArray<ModelToolCall> = [];
            let finishReason: string | null = null;
            let sawCompletion = false;
            let attempt = 0;

            for (;;) {
              signal.throwIfAborted();
              responseText = "";
              responseCalls = [];
              finishReason = null;
              sawCompletion = false;
              modelRounds++;
              progress();
              try {
                for await (const event of adapter.generate({
                  messages,
                  model: request.providerModel.modelId,
                  tools: toolDescriptors,
                  signal,
                })) {
                  signal.throwIfAborted();
                  switch (event.type) {
                    case "content.delta":
                      if (event.kind === "assistant_text") {
                        responseText += event.delta;
                        if (event.delta) outputVisible = true;
                      }
                      emit(request.threadId, { type: "model.delta", runId, kind: event.kind, delta: event.delta });
                      break;
                    case "tool_calls":
                      if (responseCalls.length) throw modelEventFailure("The model emitted more than one tool-call batch in a round");
                      responseCalls = event.calls;
                      break;
                    case "usage":
                      totalTokens += event.input + event.output;
                      if (event.costUsd !== undefined) { totalCost += event.costUsd; hasCost = true; }
                      if (runBudget?.maxTokens && totalTokens > runBudget.maxTokens) budgetExhausted = true;
                      if (runBudget?.maxCostUsd && hasCost && totalCost > runBudget.maxCostUsd) budgetExhausted = true;
                      emit(request.threadId, { type: "usage", runId, input: event.input, output: event.output, ...(event.cachedInput !== undefined ? { cachedInput: event.cachedInput } : {}), ...(event.costUsd !== undefined ? { costUsd: event.costUsd } : {}) });
                      break;
                    case "completed":
                      if (sawCompletion) throw modelEventFailure("The model emitted more than one completion event in a round");
                      sawCompletion = true;
                      finishReason = event.finishReason;
                      break;
                  }
                }
                if (!sawCompletion) throw modelEventFailure("The model stream ended without a completion event");
                if (budgetExhausted) {
                  throw new AgentRuntimeError("budget_exhausted", "Turn stopped at the configured token, cost, or time budget.");
                }
                break;
              } catch (error) {
                if (
                  isModelAdapterError(error)
                  && error.code === "unsupported_tools"
                  && allowTools
                  && !outputVisible
                  && !capabilityDispatched
                  && !signal.aborted
                ) {
                  const offered = runCapabilities.list(request.grant);
                  if (offered.length > 0 && offered.every((tool) => tool.optional === true)) {
                    allowTools = false;
                    toolDescriptors = [];
                    continue;
                  }
                }
                if (
                  isModelAdapterError(error)
                  && error.code === "request_too_large"
                  && sizeRetries === 0
                  && !outputVisible
                  && !signal.aborted
                  && await compact("overflow")
                ) {
                  sizeRetries++;
                  continue;
                }
                if (
                  isModelAdapterError(error)
                  && error.code === "request_too_large"
                  && sizeRetries < 2
                  && !outputVisible
                  && !signal.aborted
                ) {
                  const shrunk = shrinkMessages(messages, sizeRetries);
                  if (shrunk) {
                    messages.splice(0, messages.length, ...shrunk);
                    sizeRetries++;
                    continue;
                  }
                }
                const canRetry = isModelAdapterError(error)
                  && error.code === "transient"
                  && error.retryable
                  && error.retrySafe
                  && !error.requestStarted
                  && !outputVisible
                  && !capabilityDispatched
                  && !signal.aborted
                  && attempt < RETRY_MAX_ATTEMPTS - 1;
                if (!canRetry) throw error;
                const wait = interruptibleDelay(computeBackoff(attempt), signal);
                const waited = await wait.promise;
                if (waited === "cancelled") signal.throwIfAborted();
                attempt++;
              }
            }

            if (budgetExhausted) {
              throw new AgentRuntimeError("budget_exhausted", "Turn stopped at the configured token, cost, or time budget.");
            }
            if (responseCalls.length > 0) {
              if (toolDescriptors.length === 0) throw new AgentRuntimeError("tool_not_available", "The model returned tool calls but no capabilities are available");
              if (toolCalls + responseCalls.length > MAX_TOOL_CALLS) throw new AgentRuntimeError("tool_budget_exceeded", `Stopped after ${MAX_TOOL_CALLS} tool calls`);

              const batch: Array<{ readonly call: CapabilityCall; readonly descriptor: (typeof toolDescriptors)[number] }> = [];
              for (const modelCall of responseCalls) {
                if (!modelCall.id.trim() || seenCallIds.has(modelCall.id)) throw new AgentRuntimeError("invalid_tool_call", "The model reused or omitted a tool-call ID");
                seenCallIds.add(modelCall.id);
                const descriptor = toolDescriptors.find((item) => item.name === modelCall.name || item.id === modelCall.name);
                if (!descriptor) throw new AgentRuntimeError("capability_not_granted", `The model requested an unavailable capability: ${modelCall.name}`);
                batch.push({
                  descriptor,
                  call: { runId, callId: modelCall.id, capabilityId: descriptor.id, arguments: modelCall.arguments, botId: request.botId, threadId: request.threadId },
                });
              }
              for (const item of batch) {
                runCapabilities.validate(item.call, request.grant);
              }

              messages.push({ role: "assistant", content: responseText || null, toolCalls: responseCalls });
              emit(request.threadId, { type: "tool.calls", runId, calls: responseCalls });
              const batchImages: ModelContentPart[] = [];
              for (const { call, descriptor } of batch) {
                signal.throwIfAborted();
                const dispatchedAt = Date.now();
                toolCalls++;
                progress();
                dependencies.store.beginCapabilityCall({
                  runId,
                  callId: call.callId,
                  capabilityId: call.capabilityId,
                  risk: descriptor.risk,
                  status: "dispatching",
                  startedAt: dispatchedAt,
                });
                capabilityDispatched = true;

                let result: CapabilityResult;
                try {
                  result = await runCapabilities.invoke(call, { grant: request.grant, signal });
                } catch {
                  const uncertain: CapabilityResult = {
                    callId: call.callId,
                    ok: false,
                    content: "The operation may have taken effect. Inspect its state before continuing.",
                    uncertain: true,
                    error: "uncertain_side_effect",
                  };
                  try { dependencies.store.settleCapabilityCall(runId, call.callId, "recovery_required", Date.now()); } catch {}
                  emit(request.threadId, { type: "tool.result", runId, callId: call.callId, result: uncertain });
                  updateStatus("recovery_required", "uncertain_side_effect");
                  emit(request.threadId, { type: "run.recovery_required", runId, callId: call.callId });
                  return;
                }

                if (result.uncertain) {
                  dependencies.store.settleCapabilityCall(runId, call.callId, "recovery_required", Date.now());
                  emit(request.threadId, { type: "tool.result", runId, callId: call.callId, result });
                  updateStatus("recovery_required", result.error ?? "uncertain_side_effect");
                  emit(request.threadId, { type: "run.recovery_required", runId, callId: call.callId });
                  return;
                }

                dependencies.store.settleCapabilityCall(runId, call.callId, result.ok ? "succeeded" : "failed", Date.now());
                if (!result.ok) capabilityFailure = true;
                emit(request.threadId, { type: "tool.result", runId, callId: call.callId, result });
                if (result.images?.length && modelCapabilities.imageInput !== "supported") {
                  throw new AgentRuntimeError("unsupported_capability", "The capability returned an image result the selected model cannot receive");
                }
                let promptResult = result.content;
                let outputRef: Record<string, unknown> | undefined;
                if (result.content.length > TOOL_OUTPUT_PROMPT_CHARS && runCapabilities.recordToolOutput(call.callId, result.content)) {
                  promptResult = `${result.content.slice(0, TOOL_OUTPUT_PROMPT_CHARS)}\n\n[Output truncated: ${TOOL_OUTPUT_PROMPT_CHARS} of ${result.content.length} chars shown. Full output is stored as call ${call.callId}. Use ${TOOL_OUTPUT_READ_CAPABILITY} with callId "${call.callId}" and offset/limit to read more.]`;
                  outputRef = { callId: call.callId, totalChars: result.content.length, shownChars: TOOL_OUTPUT_PROMPT_CHARS, truncated: true };
                }
                messages.push({
                  role: "tool",
                  content: JSON.stringify({ ok: result.ok, result: promptResult, ...(outputRef ? { outputRef } : {}) }),
                  toolCallId: call.callId,
                });
                if (result.images?.length) {
                  encodedImages += result.images.reduce((total, image) => total + image.data.length, 0);
                  if (encodedImages > MAX_ENCODED_IMAGE_BYTES) {
                    throw new AgentRuntimeError("image_budget_exceeded", "Tool images exceeded the 32 MiB encoded budget for this run.");
                  }
                  batchImages.push(
                    { type: "text", text: `Screenshot result from tool call ${call.callId}:` },
                    ...result.images.map((image): ModelContentPart => ({ type: "image", mimeType: image.mimeType, data: image.data })),
                  );
                }
              }
              if (batchImages.length) messages.push({ role: "user", content: batchImages });
              continue;
            }

            if (!responseText.trim()) throw modelEventFailure("The model returned an empty final answer");
            if (finishReason && finishReason !== "stop") throw modelEventFailure(`The model did not finish the response (${finishReason})`);
            if (control.steers.length) {
              messages.push({ role: "assistant", content: responseText });
              continue;
            }
            control.finishing = true;
            if (capabilityFailure) throw new AgentRuntimeError("capability_failed", "One or more capabilities failed or were denied; the run is not a success receipt");
            if (request.nudgeAnnouncedAction && toolDescriptors.length > 0 && announcesAction(responseText)) {
              if (nudges >= MAX_ANNOUNCEMENT_NUDGES) {
                throw new AgentRuntimeError("incomplete_action", `Stopped after ${MAX_ANNOUNCEMENT_NUDGES} announcement nudges without a verified final answer. Earlier operations may have taken effect; inspect their state and continue only the remaining work.`);
              }
              if (callsAtNudge === seenCallIds.size) {
                throw new AgentRuntimeError("incomplete_action", "The model announced another action without tool progress after a nudge. The task is incomplete; earlier operations may have taken effect. Inspect their state before continuing.");
              }
              nudges += 1;
              callsAtNudge = seenCallIds.size;
              messages.push({ role: "assistant", content: responseText }, { role: "user", content: NUDGE_ANNOUNCED_ACTION });
              continue;
            }
            stopReason = finishReason;
            completed = true;
            break;
          }

          if (!completed && runStatus.value === "running") throw new AgentRuntimeError("round_budget_exceeded", `Stopped after ${MAX_MODEL_ROUNDS} model rounds`);
        } catch (error) {
          failure = error;
        }
        control.finishing = true;

        try {
          await closeSession();
        } catch (error) {
          if (!failure && runStatus.value !== "recovery_required") failure = error;
        }

        if (runStatus.value === "recovery_required") return;
        if (signal.aborted) {
          updateStatus("interrupted", "interrupted");
          emit(request.threadId, { type: "run.interrupted", runId });
        } else if (failure) {
          updateStatus("failed", errorCode(failure));
          emit(request.threadId, { type: "run.failed", runId, message: safeMessage(failure) });
        } else if (completed) {
          updateStatus("completed");
          emit(request.threadId, { type: "turn.completed", runId, ok: true, stopReason });
        } else {
          updateStatus("failed", "terminal");
          emit(request.threadId, { type: "run.failed", runId, message: "The run ended without a final answer" });
        }
      }).finally(() => {
        active.delete(runId);
        if (activeByThread.get(request.threadId) === runId) activeByThread.delete(request.threadId);
      });

      active.set(runId, control);
      return { runId, done };
    },

    async interrupt(runId) {
      active.get(runId)?.controller.abort(new DOMException("Native agent run interrupted", "AbortError"));
    },

    async steer(runId, text) {
      const control = active.get(runId);
      if (!control || control.finishing) return "refused";
      const trimmed = text.trim();
      if (!trimmed) return "refused";
      control.steers.push(trimmed);
      return "steered";
    },

    getState(runId) {
      return dependencies.store.getRun(runId);
    },

    onEvent(threadId, listener) {
      if (!listeners.has(threadId)) listeners.set(threadId, new Set());
      listeners.get(threadId)!.add(listener);
      return () => {
        const threadListeners = listeners.get(threadId);
        threadListeners?.delete(listener);
        if (threadListeners?.size === 0) listeners.delete(threadId);
      };
    },
  };
}
