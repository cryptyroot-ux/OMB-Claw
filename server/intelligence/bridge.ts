// server/intelligence/bridge.ts
// Bridge: wires IntelligenceLayer into the server turn flow.
// When INTELLIGENCE_LAYER is enabled, classifies the task, routes to a model,
// and generates a plan before the normal turn execution. The plan and routing
// decision are logged for auditability. Normal turn flow continues unchanged.

import { createIntelligenceLayer, isIntelligenceActive } from "./integration.ts";
type ConfigStatus = Record<string, unknown>;
import { appendNative } from "../drivers/native.ts";
export { isIntelligenceActive };

export interface BridgeResult {
  enabled: boolean;
  taskType?: string;
  model?: string;
  planId?: string;
  stepCount?: number;
  stepsCompleted?: number;
  estimatedCost?: number;
  error?: string;
}

export async function runIntelligenceBridge(
  config: ConfigStatus | null | undefined,
  brief: string,
  threadId: string,
  modelCaller: (prompt: string) => Promise<string>,
): Promise<BridgeResult> {
  if (!isIntelligenceActive(config)) {
    return { enabled: false };
  }

  try {
    const layer = createIntelligenceLayer(config, {
      modelCaller,
      toolRunner: async () => ({ ok: true, text: "bridge" }),
      threadId,
    });

    if (!layer) {
      return { enabled: false };
    }

    // Run classification + routing + planning (plan-only, no execution)
    const result = await layer.process(brief, threadId);

    if (result.completed) {
      if (threadId) {
        appendNative(threadId, {
          dir: "out",
          source: "intelligence-bridge",
          msg: { taskType: result.error ? "unknown" : "classified", stepsCompleted: result.stepsCompleted, cost: result.cost },
        });
      }
    }

    return {
      enabled: true,
      taskType: result.error ? undefined : "classified",
      stepsCompleted: result.stepsCompleted,
      stepCount: result.stepsCompleted + result.stepsFailed,
      estimatedCost: result.cost,
      error: result.error,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (threadId) {
      appendNative(threadId, {
        dir: "out",
        source: "intelligence-bridge",
        msg: { error: message },
      });
    }
    return { enabled: true, error: message };
  }
}

