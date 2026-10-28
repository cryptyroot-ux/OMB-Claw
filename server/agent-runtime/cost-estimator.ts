// Cost estimator: rough pre-flight cost estimate for a turn given message
// size, expected output, and a per-model price table. Used by the Intelligence
// Layer to warn before expensive runs and to downgrade when over budget.

export interface ModelPrice {
  readonly inputPer1kUsd: number;
  readonly outputPer1kUsd: number;
}

export interface CostEstimate {
  readonly estimatedInputTokens: number;
  readonly estimatedOutputTokens: number;
  readonly estimatedCostUsd: number;
  readonly model: string;
}

const DEFAULT_PRICE: ModelPrice = { inputPer1kUsd: 0.003, outputPer1kUsd: 0.015 };

export function estimateTokens(text: string): number {
  // ~4 chars per token heuristic.
  return Math.ceil(text.length / 4);
}

export function estimateCost(input: {
  readonly messages: ReadonlyArray<{ readonly content: string | null | undefined }>;
  readonly expectedOutputTokens?: number;
  readonly model: string;
  readonly prices?: Readonly<Record<string, ModelPrice>>;
}): CostEstimate {
  const prices = input.prices ?? {};
  const price = prices[input.model] ?? DEFAULT_PRICE;
  const estimatedInputTokens = input.messages.reduce((sum, m) => sum + estimateTokens(m.content ?? ""), 0);
  const estimatedOutputTokens = input.expectedOutputTokens ?? 512;
  const estimatedCostUsd =
    (estimatedInputTokens / 1000) * price.inputPer1kUsd +
    (estimatedOutputTokens / 1000) * price.outputPer1kUsd;
  return { estimatedInputTokens, estimatedOutputTokens, estimatedCostUsd, model: input.model };
}