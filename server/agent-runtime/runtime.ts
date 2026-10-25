import type {
  AgentEngine,
  AgentEvent,
  ModelAdapter,
  CapabilityRuntime,
  RunState,
  CapabilityGrant,
  ModelMessage,
  ModelToolCall,
} from "./contracts.ts";

export function createAgentEngine(): AgentEngine {
  let runCounter = 0;
  const runs = new Map<string, RunState>();

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

      const done = (async () => {
        try {
          const messages: ModelMessage[] = [{ role: "user", content: request.text }];
          let round = 0;
          const MAX_ROUNDS = 64;

          while (round < MAX_ROUNDS) {
            round++;
            request.signal.throwIfAborted();

            const capabilities = await request.modelAdapter.discoverModels().then(() => request.modelAdapter.capabilities(request.providerModel.modelId));
            void capabilities;

            const toolDefs = request.capabilityRuntime.list({ botId: request.botId, threadId: request.threadId, grant: request.grant });

            const result = await request.modelAdapter.generate({
              messages,
              model: request.providerModel.modelId,
              tools: toolDefs,
              signal: request.signal,
            });

            const run = runs.get(runId)!;
            run.modelRounds = round;
            run.lastActivityAt = new Date().toISOString();

            if (result.toolCalls.length > 0) {
              messages.push({ role: "assistant", content: result.text || null, toolCalls: result.toolCalls });
              for (const call of result.toolCalls) {
                run.toolCalls++;
                const capResult = await request.capabilityRuntime.invoke(
                  { callId: call.id, capabilityId: call.name, arguments: call.arguments, botId: request.botId, threadId: request.threadId },
                  { grant: request.grant, signal: request.signal },
                );
                messages.push({ role: "tool", content: capResult.content, toolCallId: call.id });
              }
              continue;
            }

            // Final answer
            const finalRun = runs.get(runId)!;
            finalRun.status = "completed";
            finalRun.lastActivityAt = new Date().toISOString();
            break;
          }

          const finalRun = runs.get(runId)!;
          if (finalRun.status !== "completed") {
            finalRun.status = "failed";
          }
        } catch (error) {
          const run = runs.get(runId);
          if (run) {
            run.status = request.signal.aborted ? "interrupted" : "failed";
            run.lastActivityAt = new Date().toISOString();
          }
        }
      })();

      return { runId, done };
    },

    async interrupt(runId) {
      // No active abort controller stored in this minimal version; the caller's signal handles it.
    },

    getState(runId) {
      return runs.get(runId);
    },
  };
}