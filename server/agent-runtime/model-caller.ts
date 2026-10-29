// Model caller factory: wraps a ModelAdapter into a simple (prompt) => Promise<string>
// function usable by the Intelligence Layer (planner/verifier). Collects model.delta
// events into a single string. Non-streaming fallback supported.
import type { ModelAdapter } from "./contracts.ts";

export function createModelCaller(
  adapter: ModelAdapter,
  modelId: string,
): (prompt: string) => Promise<string> {
  return async (prompt: string): Promise<string> => {
    let out = "";
    try {
      for await (const event of adapter.generate({
        messages: [{ role: "user", content: prompt }],
        model: modelId,
        tools: [],
        signal: new AbortController().signal,
      } as never)) {
        const e = event as { type?: string; delta?: string };
        if (e.type === "content.delta" && typeof e.delta === "string") {
          out += e.delta;
        }
        if (e.type === "completed") break;
      }
    } catch {
      // swallow; return whatever collected
    }
    return out;
  };
}
