// OMB-owned turn boundary. A driver returns a model gateway; this runtime owns
// the turn entry point (admission, model rounds, tool orchestration, state,
// context, retry, recovery, steering, budgets). Phase 1b: facade over the
// current native path; the driver's sendTurn closure is wrapped here so
// callers depend on the engine boundary, not on ProviderAdapter.sendTurn.
import type { SendTurnInput, TurnStartResult } from "../contracts.ts";

export interface NativeTurnRuntime {
  readonly sendTurn: (input: SendTurnInput) => Promise<TurnStartResult>;
}

export function createNativeTurnRuntime(
  sendTurn: (input: SendTurnInput) => Promise<TurnStartResult>,
): NativeTurnRuntime {
  return { sendTurn };
}
