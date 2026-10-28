// server/routing/cost-estimator.ts

import type { ModelCost } from "./types.ts";

const COST_TABLE: Record<string, ModelCost> = {
  "claude-sonnet-4": { input: 3, output: 15 },
  "gpt-4o": { input: 2.5, output: 10 },
  "llama-3.3-70b": { input: 0.1, output: 0.2 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
};

function contentLength(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (Array.isArray(content)) {
    return content.reduce((total, part) => {
      if (typeof part === "string") return total + part.length;
      if (part && typeof part === "object") {
        const text = (part as { text?: unknown; content?: unknown }).text
          ?? (part as { content?: unknown }).content;
        if (typeof text === "string") return total + text.length;
      }
      return total;
    }, 0);
  }
  if (content == null) return 0;
  return String(content).length;
}

export function estimateCost(
  messages: Array<{ role?: string; content?: unknown }> | null | undefined,
  model: string,
  expectedOutputTokens: number = 0,
  costTable?: Record<string, ModelCost>,
): number {
  const table = costTable ?? COST_TABLE;
  const rate = table[model];
  if (!rate) return 0;

  const inputChars = (messages ?? []).reduce(
    (sum, message) => sum + contentLength(message?.content),
    0,
  );
  const inputTokens = Math.ceil(inputChars / 4);
  const outputTokens = Number.isFinite(expectedOutputTokens)
    ? Math.max(0, expectedOutputTokens)
    : 0;

  return (inputTokens * rate.input + outputTokens * rate.output) / 1e6;
}
