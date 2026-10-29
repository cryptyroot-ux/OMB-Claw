// Access tokens stay in the request header only, never in the JSON result.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { InstanceConfigMap } from "./contracts.ts";
import { harnessHome } from "./env-path.ts";

export type PlanDriver = "grok";

export interface PlanWindow {
  available: boolean;
  remainingPercent: number | null;
  usedPercent: number | null;
  resetsAt: string | null;
}

export interface PlanExtra {
  label: string;
  remainingPercent: number;
  usedPercent: number;
  resetsAt: string | null;
}

export interface PlanModelUsage {
  name: string;
  windows: PlanExtra[];
}

export interface PlanWindows {
  plan: string | null;
  fiveHour: PlanWindow;
  weekly: PlanWindow;
  extra: PlanExtra[];
  models: PlanModelUsage[];
}

export interface PlanProviderRow {
  id: string;
  name: string;
  driver: string;
  plan: string | null;
  ok: boolean;
  error: string | null;
  fiveHour: PlanWindow;
  weekly: PlanWindow;
  extra: PlanExtra[];
  models: PlanModelUsage[];
}

export interface PlanUsageReport {
  fetchedAt: string;
  providers: PlanProviderRow[];
}

export interface PlanAccount {
  id: string;
  name: string;
  driver: PlanDriver;
  environment: Record<string, string | undefined>;
  configDir?: string;
}

export interface PlanCredential {
  token: string | null;
  accountId: string | null;
  expired: boolean;
}

export interface CredentialReader {
  read(account: PlanAccount): PlanCredential | Promise<PlanCredential>;
}

export interface PlanResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export type PlanFetch = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<PlanResponse>;

export interface PlanUsageDeps {
  fetch: PlanFetch;
  credentials: CredentialReader;
  now?: () => number;
  timeoutMs?: number;
}

export interface CredentialSource {
  readText: (path: string) => string | null;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

const PROVIDER_TIMEOUT_MS = 8_000;
const PLAN_USAGE_CACHE_MS = 45_000;
const CREDENTIAL_READ_MAX_BYTES = 1_000_000;
const GROK_CREDITS_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const GROK_BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing";
const GROK_SETTINGS_URL = "https://cli-chat-proxy.grok.com/v1/settings";

const FIVE_HOUR_MIN_SECONDS = 3 * 3600;
const FIVE_HOUR_MAX_SECONDS = 8 * 3600;
const WEEK_MIN_SECONDS = 5 * 86400;
const WEEK_MAX_SECONDS = 9 * 86400;
const MONTH_MIN_SECONDS = 27 * 86400;
const MONTH_MAX_SECONDS = 32 * 86400;

const DRIVER_OF: Record<string, PlanDriver> = {
  grokAgent: "grok",
};

const PRODUCT_NAME: Record<PlanDriver, string> = {
  grok: "Grok",
};

export function planAccountsFromInstances(instances: InstanceConfigMap): PlanAccount[] {
  const accounts: PlanAccount[] = [];
  for (const [id, entry] of Object.entries(instances)) {
    const driver = DRIVER_OF[entry.driver];
    if (!driver) continue;
    const config = asRecord(entry.config);
    const configDir = typeof config?.configDir === "string" ? config.configDir : undefined;
    accounts.push({
      id,
      name: entry.displayName?.trim() || PRODUCT_NAME[driver],
      driver,
      environment: { ...entry.environment },
      ...(configDir ? { configDir } : {}),
    });
  }
  return accounts;
}

export function parseGrokUsage(credits: unknown, billing?: unknown, settings?: unknown): PlanWindows {
  let fiveHour = closedWindow();
  let weekly = closedWindow();
  const extra: PlanExtra[] = [];
  const models: PlanModelUsage[] = [];
  let sawMonthly = false;
  const place = (sample: GrokSample | null) => {
    if (!sample) return;
    const window = openWindow(sample.used, sample.resetsAt);
    if (sample.slot === "fiveHour") {
      if (!fiveHour.available) fiveHour = window;
    } else if (sample.slot === "weekly") {
      if (!weekly.available) weekly = window;
    } else if (sample.slot === "monthly") {
      if (!sawMonthly) {
        sawMonthly = true;
        extra.push(extraLine("Monthly", window));
      }
    } else {
      extra.push(extraLine(sample.seconds == null ? "Credits" : durationLabel(sample.seconds), window));
    }
  };
  const creditSample = readGrokSample(credits);
  place(creditSample);
  const productSample = creditSample ?? { used: 0, slot: "other" as const, resetsAt: null, seconds: null };
  for (const model of readGrokProducts(credits, productSample)) addModelWindow(models, model.name, model.window);
  if (billing !== undefined) place(readGrokSample(billing));
  sortModelWindows(models);
  return { plan: grokPlan(settings), fiveHour, weekly, extra, models };
}

function closedWindow(): PlanWindow {
  return { available: false, remainingPercent: null, usedPercent: null, resetsAt: null };
}

function openWindow(usedPercent: number, resetsAt: string | null): PlanWindow {
  const used = clampPercent(usedPercent);
  return {
    available: true,
    usedPercent: used,
    remainingPercent: clampPercent(100 - used),
    resetsAt,
  };
}

function extraLine(label: string, window: PlanWindow): PlanExtra {
  return {
    label,
    remainingPercent: window.remainingPercent ?? 0,
    usedPercent: window.usedPercent ?? 0,
    resetsAt: window.resetsAt,
  };
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function timeMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.abs(value) >= 1e12 ? value : value * 1000;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 80) return null;
  if (/^\d+(\.\d+)?$/.test(trimmed)) return timeMs(Number(trimmed));
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function isoOrNull(value: unknown): string | null {
  const ms = timeMs(value);
  if (ms == null) return null;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function planLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 80 || /[\r\n]/.test(trimmed)) return null;
  if (/bearer\s|access_token|refresh_token|sk-ant-|eyJ[a-zA-Z0-9_-]{8,}/i.test(trimmed)) return null;
  return trimmed;
}

function secretString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 16_000 || /[\r\n]/.test(trimmed)) return null;
  return trimmed;
}

function parseJson(text: string | null): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function missingCredential(): PlanCredential {
  return { token: null, accountId: null, expired: false };
}

function expiredCredential(): PlanCredential {
  return { token: null, accountId: null, expired: true };
}

function signInAgain(driver: PlanDriver): string {
  return `Sign in again in ${PRODUCT_NAME[driver]}`;
}

function couldNotReach(driver: PlanDriver): string {
  return `Could not reach ${PRODUCT_NAME[driver]}`;
}

function unexpectedUsage(driver: PlanDriver): string {
  return `${PRODUCT_NAME[driver]} returned an unexpected usage response`;
}

function durationLabel(seconds: number): string {
  if (seconds >= 86400) return `${Math.max(1, Math.round(seconds / 86400))}-day`;
  if (seconds >= 3600) return `${Math.max(1, Math.round(seconds / 3600))}-hour`;
  return `${Math.max(1, Math.round(seconds / 60))}-minute`;
}

type GrokSlot = "fiveHour" | "weekly" | "monthly" | "other";

interface GrokSample {
  used: number;
  slot: GrokSlot;
  resetsAt: string | null;
  seconds: number | null;
}

function classifyGrok(typeValue: unknown, seconds: number | null): GrokSlot {
  const type = typeof typeValue === "string" ? typeValue.toUpperCase() : "";
  if (type.includes("WEEK")) return "weekly";
  if (type.includes("MONTH")) return "monthly";
  if (/(^|[^A-Z0-9])(5|FIVE)[^A-Z0-9]*HOUR/.test(type)) return "fiveHour";
  if (seconds == null) return "other";
  if (seconds >= FIVE_HOUR_MIN_SECONDS && seconds <= FIVE_HOUR_MAX_SECONDS) return "fiveHour";
  if (seconds >= WEEK_MIN_SECONDS && seconds <= WEEK_MAX_SECONDS) return "weekly";
  if (seconds >= MONTH_MIN_SECONDS && seconds <= MONTH_MAX_SECONDS) return "monthly";
  return "other";
}

function readGrokSample(body: unknown): GrokSample | null {
  const root = asRecord(body);
  if (!root) return null;
  const config = asRecord(root.config) ?? root;
  let used = finiteNumber(config.creditUsagePercent);
  if (used == null) {
    const cap = finiteNumber(asRecord(config.onDemandCap)?.val ?? config.onDemandCap);
    const spent = finiteNumber(asRecord(config.onDemandUsed)?.val ?? config.onDemandUsed);
    if (cap != null && spent != null && cap > 0) used = (spent / cap) * 100;
  }
  if (used == null) return null;
  const period = asRecord(config.currentPeriod);
  const type = period?.type ?? period?.period ?? config.period ?? config.interval;
  const start = period?.start ?? period?.periodStart;
  const end = period?.end ?? period?.periodEnd ?? config.billingPeriodEnd ?? root.billingPeriodEnd;
  const startMs = timeMs(start);
  const endMs = timeMs(end);
  const seconds = startMs != null && endMs != null && endMs > startMs ? (endMs - startMs) / 1000 : null;
  return { used, slot: classifyGrok(type, seconds), resetsAt: isoOrNull(end), seconds };
}

function grokPlan(settings: unknown): string | null {
  const root = asRecord(settings);
  if (!root) return null;
  const nested = asRecord(root.settings);
  return planLabel(nested?.subscription_tier_display ?? root.subscription_tier_display);
}

function readGrokProducts(body: unknown, sample: GrokSample): Array<{ name: string; window: PlanExtra }> {
  const root = asRecord(body);
  if (!root) return [];
  const config = asRecord(root.config) ?? root;
  if (!Array.isArray(config.productUsage)) return [];
  const label = sample.slot === "fiveHour" ? "5-hour" : sample.slot === "weekly" ? "Weekly" : sample.slot === "monthly" ? "Monthly" : "Used";
  const rows: Array<{ name: string; window: PlanExtra }> = [];
  for (const item of config.productUsage) {
    const record = asRecord(item);
    if (!record) continue;
    const raw = typeof record.product === "string" ? record.product : typeof record.name === "string" ? record.name : "";
    const name = planLabel(raw.replace(/([a-z])([A-Z])/g, "$1 $2"));
    const used = finiteNumber(record.usagePercent ?? record.usedPercent ?? record.utilization);
    if (!name || used == null) continue;
    rows.push({ name, window: extraLine(label, openWindow(used, sample.resetsAt)) });
  }
  return rows;
}

function planUsageCacheKey(accounts: PlanAccount[]): string {
  return accounts.map((account) => {
    const environment = Object.entries(account.environment)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([name, value]) => `${name}=${value}`)
      .join("\n");
    return [account.id, account.driver, account.name, account.configDir ?? "", environment].join("\u0000");
  }).join("\n");
}

interface GrokCandidate {
  token: string;
  expiresAt: number | null;
}

function grokCandidate(record: Record<string, unknown>): GrokCandidate | null {
  const token = secretString(record.access_token) ?? secretString(record.key);
  if (!token) return null;
  return { token, expiresAt: timeMs(record.expires_at ?? record.expiresAt) };
}

function readGrokCredential(
  env: NodeJS.ProcessEnv,
  readText: (path: string) => string | null,
  now: number,
): PlanCredential {
  const rootDir = env.GROK_HOME?.trim() || harnessHome("grok", env);
  const root = asRecord(parseJson(readText(join(rootDir, "auth.json"))));
  if (!root) return missingCredential();
  const direct = grokCandidate(root);
  if (direct) {
    if (direct.expiresAt != null && direct.expiresAt <= now) return expiredCredential();
    return { token: direct.token, accountId: null, expired: false };
  }
  let sawExpired = false;
  let best: GrokCandidate | null = null;
  for (const value of Object.values(root)) {
    const record = asRecord(value);
    if (!record) continue;
    const candidate = grokCandidate(record);
    if (!candidate) continue;
    if (candidate.expiresAt != null && candidate.expiresAt <= now) {
      sawExpired = true;
      continue;
    }
    const bestStamp = best?.expiresAt ?? Number.NEGATIVE_INFINITY;
    const stamp = candidate.expiresAt ?? Number.NEGATIVE_INFINITY;
    if (!best || stamp >= bestStamp) best = candidate;
  }
  if (best) return { token: best.token, accountId: null, expired: false };
  return sawExpired ? expiredCredential() : missingCredential();
}

function addModelWindow(models: PlanModelUsage[], name: string, line: PlanExtra): void {
  const found = models.find((model) => model.name.toLowerCase() === name.toLowerCase());
  if (found) found.windows.push(line);
  else models.push({ name, windows: [line] });
}

function sortModelWindows(models: PlanModelUsage[]): void {
  const rank = (label: string) => (label === "5-hour" ? 0 : label === "Weekly" ? 1 : 2);
  for (const model of models) model.windows.sort((a, b) => rank(a.label) - rank(b.label));
}

function errorRow(account: PlanAccount, error: string): PlanProviderRow {
  return {
    id: account.id,
    name: account.name,
    driver: account.driver,
    plan: null,
    ok: false,
    error,
    fiveHour: closedWindow(),
    weekly: closedWindow(),
    extra: [],
    models: [],
  };
}

function okRow(account: PlanAccount, windows: PlanWindows): PlanProviderRow {
  return {
    id: account.id,
    name: account.name,
    driver: account.driver,
    plan: windows.plan,
    ok: true,
    error: null,
    fiveHour: windows.fiveHour,
    weekly: windows.weekly,
    extra: windows.extra,
    models: windows.models,
  };
}

async function fetchProvider(account: PlanAccount, deps: PlanUsageDeps): Promise<PlanProviderRow> {
  let credential: PlanCredential;
  try {
    credential = await deps.credentials.read(account);
  } catch {
    return errorRow(account, signInAgain(account.driver));
  }
  if (credential.expired || !credential.token) return errorRow(account, signInAgain(account.driver));
  try {
    return await fetchGrok(account, credential.token, deps);
  } catch {
    return errorRow(account, couldNotReach(account.driver));
  }
}

interface HttpResult {
  status: number;
  ok: boolean;
  body: unknown;
}

async function fetchJson(
  fetchImpl: PlanFetch,
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<HttpResult> {
  try {
    const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    let text = "";
    try {
      text = await response.text();
    } catch {
      text = "";
    }
    let body: unknown = null;
    if (text.trim()) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = null;
      }
    }
    return { status: response.status, ok: response.ok, body };
  } catch {
    return { status: 0, ok: false, body: null };
  }
}

function authRejected(status: number): boolean {
  return status === 401 || status === 403;
}

async function fetchGrok(account: PlanAccount, token: string, deps: PlanUsageDeps): Promise<PlanProviderRow> {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "X-XAI-Token-Auth": "xai-grok-cli",
  };
  const timeout = deps.timeoutMs ?? PROVIDER_TIMEOUT_MS;
  const [credits, billing, settings] = await Promise.all([
    fetchJson(deps.fetch, GROK_CREDITS_URL, headers, timeout),
    fetchJson(deps.fetch, GROK_BILLING_URL, headers, timeout),
    fetchJson(deps.fetch, GROK_SETTINGS_URL, headers, timeout),
  ]);
  if (authRejected(credits.status) || (authRejected(billing.status) && !credits.ok)) {
    return errorRow(account, signInAgain("grok"));
  }
  const creditsBody = credits.ok ? credits.body : null;
  const billingBody = billing.ok && !authRejected(billing.status) ? billing.body : null;
  if (creditsBody === null && billingBody === null) {
    return errorRow(account, credits.status === 0 || credits.status >= 500 || billing.status === 0 || billing.status >= 500
      ? couldNotReach("grok")
      : unexpectedUsage("grok"));
  }
  const windows = parseGrokUsage(creditsBody, billingBody ?? undefined, settings.ok ? settings.body : undefined);
  return okRow(account, windows);
}

export function fileCredentialReader(source: CredentialSource): CredentialReader {
  const env = source.env ?? process.env;
  const now = source.now ?? Date.now;
  return {
    async read(account) {
      const merged: NodeJS.ProcessEnv = { ...env, ...account.environment };
      const at = now();
      return readGrokCredential(merged, source.readText, at);
    },
  };
}

export function defaultCredentialReader(env: NodeJS.ProcessEnv = process.env): CredentialReader {
  return fileCredentialReader({
    env,
    readText(path) {
      try {
        const stat = statSync(path);
        if (!stat.isFile() || stat.size > CREDENTIAL_READ_MAX_BYTES) return null;
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    },
  });
}

export async function fetchPlanUsage(accounts: PlanAccount[], deps: PlanUsageDeps): Promise<PlanUsageReport> {
  const now = deps.now?.() ?? Date.now();
  const providers = await Promise.all(accounts.map((account) => fetchProvider(account, deps)));
  return { fetchedAt: new Date(now).toISOString(), providers };
}

let cachedReport: { at: number; key: string; report: PlanUsageReport } | null = null;

export function clearPlanUsageCache(): void {
  cachedReport = null;
}

export async function loadPlanUsage(input: {
  accounts: PlanAccount[];
  refresh?: boolean;
  now?: number;
  fetch?: PlanFetch;
  credentials?: CredentialReader;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<PlanUsageReport> {
  const now = input.now ?? Date.now();
  const key = planUsageCacheKey(input.accounts);
  if (!input.refresh && cachedReport && cachedReport.key === key && now - cachedReport.at < PLAN_USAGE_CACHE_MS) {
    return cachedReport.report;
  }
  const report = await fetchPlanUsage(input.accounts, {
    fetch: input.fetch ?? ((url, init) => globalThis.fetch(url, init)),
    credentials: input.credentials ?? defaultCredentialReader(input.env),
    now: () => now,
    timeoutMs: input.timeoutMs,
  });
  cachedReport = { at: now, key, report };
  return report;
}
