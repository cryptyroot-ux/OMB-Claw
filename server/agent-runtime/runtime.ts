import { randomUUID } from "node:crypto";

import { computeBackoff, interruptibleDelay, RETRY_MAX_ATTEMPTS } from "../drivers/retry.ts";
import { announcesAction, MAX_ANNOUNCEMENT_NUDGES, NUDGE_ANNOUNCED_ACTION } from "./announcement.ts";
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
  return ["transient", "unsupported_capability", "invalid_request", "terminal"].includes(candidate.code)
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

export function createAgentEngine(dependencies: {
  readonly adapters: { resolve(ref: AgentRunRecord["providerModel"]): ModelAdapter };
  readonly store: AgentRunStore;
}): AgentEngine {
  const active = new Map<string, { readonly threadId: string; readonly controller: AbortController }>();
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
      active.set(runId, { threadId: request.threadId, controller });
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
          await request.capabilities.close();
        };

        try {
          signal.throwIfAborted();
          updateStatus("running");
          emit(request.threadId, { type: "run.started", runId, engineId: "omb-native", providerModel: request.providerModel });

          const adapter = dependencies.adapters.resolve(request.providerModel);
          const modelCapabilities = adapter.capabilities(request.providerModel.modelId);
          while (modelRounds < MAX_MODEL_ROUNDS) {
            signal.throwIfAborted();
            const toolDescriptors = request.capabilities.list(request.grant);
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
                break;
              } catch (error) {
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
              for (const item of batch) request.capabilities.validate(item.call, request.grant);

              messages.push({ role: "assistant", content: responseText || null, toolCalls: responseCalls });
              emit(request.threadId, { type: "tool.calls", runId, calls: responseCalls });
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
                  result = await request.capabilities.invoke(call, { grant: request.grant, signal });
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
                messages.push({ role: "tool", content: JSON.stringify({ ok: result.ok, result: result.content }), toolCallId: call.callId });
                if (result.images?.length) {
                  encodedImages += result.images.reduce((total, image) => total + image.data.length, 0);
                  if (encodedImages > MAX_ENCODED_IMAGE_BYTES) {
                    throw new AgentRuntimeError("image_budget_exceeded", "Tool images exceeded the 32 MiB encoded budget for this run.");
                  }
                  messages.push({
                    role: "user",
                    content: [
                      { type: "text", text: `Screenshot result from tool call ${call.callId}:` },
                      ...result.images.map((image): ModelContentPart => ({ type: "image", mimeType: image.mimeType, data: image.data })),
                    ],
                  });
                }
              }
              continue;
            }

            if (!responseText.trim()) throw modelEventFailure("The model returned an empty final answer");
            if (finishReason && finishReason !== "stop") throw modelEventFailure(`The model did not finish the response (${finishReason})`);
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

      active.set(runId, { threadId: request.threadId, controller });
      activeByThread.set(request.threadId, runId);
      return { runId, done };
    },

    async interrupt(runId) {
      active.get(runId)?.controller.abort(new DOMException("Native agent run interrupted", "AbortError"));
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
