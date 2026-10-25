import type {
  AgentEngine,
  AgentEvent,
  ModelAdapter,
  CapabilityRuntime,
  RunState,
  CapabilityGrant,
  ModelMessage,
  ModelToolCall,
  CapabilityCall,
  CapabilityResult,
} from "./contracts.ts";

export function createAgentEngine(): AgentEngine {
  let runCounter = 0;
  const runs = new Map<string, RunState>();
  const listeners = new Map<string, Set<(event: AgentEvent) => void>>();

  return {
    engineId: "omb-native",

    async run(request) {
      const runId = `run-${++runCounter}`;
      const now = new Date().toISOString();
      const runState: RunState = {
        runId,
        engineId: "omb-native",
        providerModel: request.providerModel,
        status: "running",
        threadId: request.threadId,
        botId: request.botId,
        startedAt: now,
        lastActivityAt: now,
        modelRounds: 0,
        toolCalls: 0,
      };
      runs.set(runId, runState);

      const emit = (event: AgentEvent) => {
        const set = listeners.get(request.threadId);
        if (set) for (const fn of set) fn(event);
      };

      emit({ type: "run.started", runId, engineId: "omb-native", providerModel: request.providerModel });

      const done = (async () => {
        try {
          const messages: ModelMessage[] = [{ role: "user", content: request.text }];
          let round = 0;
          const MAX_ROUNDS = 64;
          const MAX_TOOL_CALLS = 200;

          while (round < MAX_ROUNDS) {
            round++;
            request.signal.throwIfAborted();

            const run = runs.get(runId)!;
            run.modelRounds = round;
            run.lastActivityAt = new Date().toISOString();

            const toolDefs = request.capabilityRuntime.list({ botId: request.botId, threadId: request.threadId, grant: request.grant });

            const result = await request.modelAdapter.generate({
              messages,
              model: request.providerModel.modelId,
              tools: toolDefs,
              signal: request.signal,
            });

            if (result.usage) {
              emit({ type: "turn.completed", runId, ok: true, stopReason: null });
            }

            if (result.toolCalls.length > 0) {
              messages.push({ role: "assistant", content: result.text || null, toolCalls: result.toolCalls });
              for (const call of result.toolCalls) {
                if (run.toolCalls >= MAX_TOOL_CALLS) {
                  const finalRun = runs.get(runId)!;
                  finalRun.status = "failed";
                  emit({ type: "run.failed", runId, message: `Stopped after ${MAX_TOOL_CALLS} tool calls` });
                  return;
                }
                run.toolCalls++;
                emit({ type: "tool.calls", runId, calls: [call] });

                let capResult: CapabilityResult;
                try {
                  capResult = await request.capabilityRuntime.invoke(
                    { callId: call.id, capabilityId: call.name, arguments: call.arguments, botId: request.botId, threadId: request.threadId },
                    { grant: request.grant, signal: request.signal },
                  );
                } catch (error) {
                  capResult = { callId: call.id, ok: false, content: (error instanceof Error ? error.message : String(error)), error: "execution_failed" };
                }
                emit({ type: "tool.result", runId, callId: call.id, result: capResult });
                messages.push({ role: "tool", content: capResult.content, toolCallId: call.id });
              }
              continue;
            }

            // Final answer
            const finalRun = runs.get(runId)!;
            finalRun.status = "completed";
            finalRun.lastActivityAt = new Date().toISOString();
            emit({ type: "turn.completed", runId, ok: true, stopReason: result.finishReason });
            break;
          }

          const finalRun = runs.get(runId)!;
          if (finalRun.status === "running") {
            finalRun.status = "failed";
            emit({ type: "run.failed", runId, message: "Stopped after 64 model rounds without a final answer" });
          }
        } catch (error) {
          const run = runs.get(runId);
          if (run) {
            run.status = request.signal.aborted ? "interrupted" : "failed";
            run.lastActivityAt = new Date().toISOString();
          }
          emit({ type: "run.failed", runId, message: error instanceof Error ? error.message : String(error) });
        }
      })();

      return { runId, done };
    },

    async interrupt(runId) {
      // In this minimal version, interruption is handled by the caller's AbortSignal.
      // A production version would store the AbortController per runId.
    },

    getState(runId) {
      return runs.get(runId);
    },

    onEvent(threadId: string, listener: (event: AgentEvent) => void) {
      if (!listeners.has(threadId)) listeners.set(threadId, new Set());
      listeners.get(threadId)!.add(listener);
      return () => listeners.get(threadId)?.delete(listener);
    },
  };
}