// Transient-failure classification and capped backoff for turn drivers: a provider hiccup
// (429/5xx/overloaded/reset) gets up to MAX_ATTEMPTS tries, an auth or request-shape problem none.
import type { ProviderErrorCode } from "../contracts.ts";
import { isProviderSafetyBlock } from "../../shared/provider-safety.ts";

export const RETRY_MAX_ATTEMPTS = 4;

/** Backoff schedule before retry N (0-based): 1s / 3s / 8s / 8s, each ±25% jitter. */
export const BACKOFF_BASE_MS = [1_000, 3_000, 8_000, 8_000] as const;

/** A provider's Retry-After is honored up to this long. */
export const RETRY_AFTER_CAP_MS = 30_000;

/** All retry waits in one request together never exceed this. */
export const RETRY_TOTAL_WAIT_CAP_MS = 45_000;

/** Statuses a native API driver retries; any other non-2xx surfaces at once. */
export const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);

/** A non-2xx HTTP answer from a provider, carrying its status and any Retry-After delay. */
export class HttpStatusError extends Error {
  readonly status: number;
  readonly retryAfterMs?: number;
  constructor(message: string, status: number, retryAfterMs?: number) {
    super(message);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Retry-After as delta-seconds or an HTTP-date, in ms, capped; undefined when absent or unparseable. */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | undefined {
  if (!value) return undefined;
  const text = value.trim();
  let ms: number;
  if (/^\d+(?:\.\d+)?$/.test(text)) ms = Number(text) * 1_000;
  else {
    const at = Date.parse(text);
    if (Number.isNaN(at)) return undefined;
    ms = at - now;
  }
  return Math.min(Math.max(0, Math.round(ms)), RETRY_AFTER_CAP_MS);
}

/** The wait before retry `attempt` (0-based), or null when the attempt or total-wait budget is spent. */
export function nextRetryDelay(
  attempt: number,
  waitedMs: number,
  retryAfterMs?: number,
  random: () => number = Math.random,
): number | null {
  if (attempt >= RETRY_MAX_ATTEMPTS - 1) return null;
  const delay = retryAfterMs ?? computeBackoff(attempt, random);
  const left = RETRY_TOTAL_WAIT_CAP_MS - waitedMs;
  if (left <= 0) return null;
  return Math.min(delay, left);
}

export type TransientReason =
  | "rate_limited"
  | "overloaded"
  | "server_error"
  | "connection_reset"
  | "timeout";

export type TerminalReason =
  | "auth"
  | "quota"
  | "unknown_model"
  | "invalid_request"
  | "not_found"
  | ProviderErrorCode
  | "terminal_exit"
  | "interrupted"
  | "unknown";

export interface ErrorClassification {
  transient: boolean;
  reason: string;
}

const TRANSIENT_PATTERNS: Array<{ pattern: RegExp; reason: TransientReason }> = [
  { pattern: /\b(?:429|rate.?limit|too many requests)\b/i, reason: "rate_limited" },
  { pattern: /\boverloaded\b|\bcapacity\b/i, reason: "overloaded" },
  { pattern: /\b5\d{2}\b|\binternal server error\b|\bbad gateway\b|\bservice unavailable\b/i, reason: "server_error" },
  // Codex's ChatGPT workspace routing lookup (codex-cli 0.160); only its "unauthorized" variant is a sign-in problem.
  { pattern: /\bworkspace routing discovery (?:failed|timed out)\b/i, reason: "server_error" },
  {
    pattern:
      /\b(?:econnreset|econnrefused|epipe|etimedout|eai_again|connection reset|connection refused|socket hang up|network error|fetch failed)\b/i,
    reason: "connection_reset",
  },
  { pattern: /\btimeout(ed)?\b|\btimed? out\b/i, reason: "timeout" },
];

/** A subscription's usage running out: terminal even when phrased as a rate limit. Claude Code 2.1.295
 * says "You've hit your weekly limit · resets …", "…your session limit", "…your Opus limit", "…your
 * team's shared budget", "You're out of usage credits", "You're out of extra usage". */
export const USAGE_LIMIT = /\busage limit\b|\bhit your (?:(?!rate\b)[\w'’-]+ ){0,3}(?:limit|budget)\b|\b(?:weekly|daily|monthly|subscription|usage|session|5-hour) limit reached\b|\bout of (?:usage(?: credits)?|extra usage|credits)\b/i;

const TERMINAL_PATTERNS: Array<{ pattern: RegExp; reason: TerminalReason }> = [
  {
    pattern: /\b(?:40[13]|unauthorized|forbidden|invalid api key|missing bearer|authentication required|not logged in|logged out)\b/i,
    reason: "auth",
  },
  // every terminal pattern is read before the transient 429 one
  { pattern: USAGE_LIMIT, reason: "quota" },
  { pattern: /\b402\b|\bquota\b|\bbilling\b|\bsubscription\b/i, reason: "quota" },
  { pattern: /\bmodel not found\b|\bunknown model\b|\bdoes not exist for model\b|\bunsupported model\b/i, reason: "unknown_model" },
  { pattern: /\b400\b|\b422\b|\binvalid request\b|\bmalformed\b|\bunexpected status\b/i, reason: "invalid_request" },
  { pattern: /\b404\b|\bno such thread\b|\bthread gone\b/i, reason: "not_found" },
  // A turn the user stopped must never come back as an auto-retry.
  { pattern: /\b(?:interrupted|cancelled by user)\b/i, reason: "interrupted" },
];

interface CliExit {
  exitCode: number | null;
  stderr?: string;
}

interface FailureText {
  text: string;
}

type FailureInput = Error | CliExit | FailureText | null;

const messageOf = (err: FailureInput): string => {
  if (!err) return "";
  if (err instanceof Error) return `${err.message}${err.cause ? ` ${String(err.cause)}` : ""}`;
  if ("text" in err) return err.text;
  return [err.stderr ?? "", ""].join(" ").trim();
};

/** A nonzero exit with no error text is terminal (`terminal_exit`): the CLI already reported its own
 * failure. A signal kill (negative code) is never retried. */
export function classifyError(err: FailureInput): ErrorClassification {
  const text = messageOf(err);
  if (err instanceof HttpStatusError && !isProviderSafetyBlock(text)) {
    // A 429 that says the quota or usage ran out is terminal; any other 429 is a rate limit.
    if (err.status === 429) {
      return USAGE_LIMIT.test(text) || /\bquota\b|\bbilling\b/i.test(text)
        ? { transient: false, reason: "quota" }
        : { transient: true, reason: "rate_limited" };
    }
    if (RETRYABLE_STATUSES.has(err.status)) return { transient: true, reason: "server_error" };
    if (err.status === 401 || err.status === 403) return { transient: false, reason: "auth" };
    if (err.status === 404) return { transient: false, reason: "not_found" };
    if (err.status === 400 || err.status === 422) return { transient: false, reason: "invalid_request" };
  }
  // A surrounding HTTP 5xx/429 must not replay a provider safety block.
  if (isProviderSafetyBlock(text)) return { transient: false, reason: "provider_safety" };
  if (err && "exitCode" in err) {
    const { exitCode: code } = err;
    if (code !== null && code < 0) return { transient: false, reason: "interrupted" };
    for (const { pattern, reason } of TERMINAL_PATTERNS) {
      if (pattern.test(text)) return { transient: false, reason };
    }
    for (const { pattern, reason } of TRANSIENT_PATTERNS) {
      if (pattern.test(text)) return { transient: true, reason };
    }
    return { transient: false, reason: "terminal_exit" };
  }
  for (const { pattern, reason } of TERMINAL_PATTERNS) {
    if (pattern.test(text)) return { transient: false, reason };
  }
  for (const { pattern, reason } of TRANSIENT_PATTERNS) {
    if (pattern.test(text)) return { transient: true, reason };
  }
  return { transient: false, reason: "unknown" };
}

export function computeBackoff(attempt: number, random: () => number = Math.random): number {
  const base = BACKOFF_BASE_MS[Math.min(Math.max(attempt, 0), BACKOFF_BASE_MS.length - 1)];
  const jitter = base * 0.25;
  return Math.round(base - jitter + random() * jitter * 2);
}

/** An interrupt during the wait resolves "cancelled" at once, so no relaunch outlives the user's stop. */
export interface BackoffWait {
  promise: Promise<"elapsed" | "cancelled">;
  cancel: () => void;
}

export function interruptibleDelay(ms: number, signal?: AbortSignal): BackoffWait {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let onCancel: (() => void) | null = null;
  const promise = new Promise<"elapsed" | "cancelled">((resolve) => {
    timer = setTimeout(() => resolve("elapsed"), Math.max(1, ms));
    timer.unref?.();
    if (signal?.aborted) return resolve("cancelled");
    onCancel = () => {
      clearTimeout(timer!);
      resolve("cancelled");
    };
    signal?.addEventListener("abort", onCancel, { once: true });
  });
  return {
    promise,
    cancel: () => onCancel?.(),
  };
}
