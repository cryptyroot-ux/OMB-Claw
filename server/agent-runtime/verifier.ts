// Verifier: wraps a step's execution with a self-correction loop. After a step
// produces output, the verifier runs a check (heuristic or LLM-based). On
// failure it returns corrective feedback so the Intelligence Layer can retry
// the step with the feedback injected into context.

export interface VerificationResult {
  readonly ok: boolean;
  readonly feedback: string;
}

export type VerifierFn = (output: string) => Promise<VerificationResult> | VerificationResult;

export interface VerifyLoopOptions {
  readonly maxRetries: number;
  readonly verify: VerifierFn;
}

export interface VerifyLoopResult {
  readonly ok: boolean;
  readonly attempts: number;
  readonly lastFeedback: string;
  readonly outputs: ReadonlyArray<string>;
}

export async function runVerifyLoop(
  execute: (attempt: number, feedback?: string) => Promise<string>,
  options: VerifyLoopOptions,
): Promise<VerifyLoopResult> {
  const outputs: string[] = [];
  let lastFeedback = "";
  const maxAttempts = Math.max(1, options.maxRetries + 1);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const output = await execute(attempt, attempt > 0 ? lastFeedback : undefined);
    outputs.push(output);
    const result = await options.verify(output);
    if (result.ok) {
      return { ok: true, attempts: attempt + 1, lastFeedback: result.feedback, outputs };
    }
    lastFeedback = result.feedback || "Verification failed; retry with corrections.";
  }
  return { ok: false, attempts: maxAttempts, lastFeedback, outputs };
}

// Heuristic verifier: checks output is non-empty and not an error string.
export function heuristicVerifier(output: string): VerificationResult {
  const trimmed = output.trim();
  if (!trimmed) return { ok: false, feedback: "Output is empty; provide a substantive answer." };
  if (/^(error|failed|exception):/i.test(trimmed)) return { ok: false, feedback: "Output indicates an error; retry." };
  if (trimmed.length < 10) return { ok: false, feedback: "Output too short; expand." };
  return { ok: true, feedback: "" };
}