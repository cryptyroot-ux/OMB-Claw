import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { OpenAIChatMessage } from "./openai-chat.ts";
import {
  compactTurnMessages, estimateRequestTokens, offloadToolOutput, planCompaction, readToolOutput, refusesContextLength,
  SUMMARY_TAG, TokenCalibration, turnCompactBudget,
} from "./turn-context.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const tmp = () => { const dir = mkdtempSync(join(tmpdir(), "turn-ctx-")); dirs.push(dir); return dir; };

function longTurn(rounds: number) {
  const request: OpenAIChatMessage = { role: "user", content: "Do the task" };
  const messages: OpenAIChatMessage[] = [{ role: "system", content: "sys" }, { role: "user", content: "old" }, { role: "assistant", content: "old answer" }, request];
  for (let i = 0; i < rounds; i++) {
    messages.push({ role: "assistant", content: null, tool_calls: [{ id: `c${i}`, type: "function", function: { name: "t", arguments: "{}" } }] });
    messages.push({ role: "tool", tool_call_id: `c${i}`, content: `result ${i} ${"x".repeat(200)}` });
  }
  return { messages, request };
}

function valid(messages: OpenAIChatMessage[]) {
  const open = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant") for (const call of message.tool_calls ?? []) open.add(call.id);
    if (message.role === "tool") { if (!open.has(message.tool_call_id!)) return false; }
  }
  return true;
}

test("estimates grow with content, tool schemas and images", () => {
  const base = estimateRequestTokens([{ role: "user", content: "hi" }]);
  expect(estimateRequestTokens([{ role: "user", content: "x".repeat(3500) }])).toBeGreaterThan(base + 900);
  expect(estimateRequestTokens([{ role: "user", content: [{ type: "image_url", image_url: { url: "data:," } }] as never }])).toBeGreaterThan(1000);
  expect(estimateRequestTokens([], [{ type: "function", function: { name: "a", description: "d".repeat(350), parameters: {} } }])).toBeGreaterThan(100);
});

test("budget: fraction, absolute, default 75%, capped at 90%", () => {
  expect(turnCompactBudget(1000)).toBe(750);
  expect(turnCompactBudget(1000, 0.5)).toBe(500);
  expect(turnCompactBudget(1000, 600)).toBe(600);
  expect(turnCompactBudget(1000, 5000)).toBe(900);
});

test("calibration only scales up", () => {
  const c = new TokenCalibration();
  c.observe(100, 50);
  expect(c.apply(100)).toBe(100);
  c.observe(100, 150);
  expect(c.apply(100)).toBe(150);
});

test("offload saves the full output and pages it back by handle", () => {
  const dir = tmp();
  const text = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join("\n");
  expect(offloadToolOutput("small", { dir, threadId: "t", callId: "c" })).toBeNull();
  const out = offloadToolOutput(text, { dir, threadId: "t", callId: "c", thresholdBytes: 5000 })!;
  expect(out.text.length).toBeLessThan(4000);
  expect(out.text).toContain(out.handle);
  expect(out.text.endsWith("line 2999")).toBe(true);
  const page = readToolOutput({ handle: out.handle, offset: 0, limit: 10 }, { dir, threadId: "t" });
  expect(page.ok).toBe(true);
  expect(page.text).toContain("line 0");
  expect(page.text).toContain("next offset 10");
  expect(readToolOutput({ handle: out.handle }, { dir, threadId: "other" }).ok).toBe(false);
  expect(readToolOutput({ handle: "../../etc/passwd" }, { dir, threadId: "t" }).ok).toBe(false);
});

test("plan keeps system, request and the last exchanges, never orphaning tool results", () => {
  const { messages, request } = longTurn(10);
  const plan = planCompaction(messages, request, 3)!;
  const next = plan.build("S");
  expect(next[0]).toBe(messages[0]);
  expect(next).toContain(request);
  expect(next[1]!.content).toBe(`${SUMMARY_TAG}\nS`);
  expect(next.filter((m) => m.role === "assistant")).toHaveLength(3);
  expect(valid(next)).toBe(true);
  expect(next.at(-1)).toBe(messages.at(-1));
});

test("compaction is incremental: the previous summary is fed back and replaced, not duplicated", async () => {
  const { messages, request } = longTurn(10);
  const prompts: string[] = [];
  const summarize = async (prompt: string) => { prompts.push(prompt); return `summary ${prompts.length}`; };
  const first = (await compactTurnMessages(messages, request, { keepExchanges: 3, summarize, summaryBudgetBytes: 50_000 }))!;
  for (let i = 10; i < 16; i++) first.messages.push(
    { role: "assistant", content: null, tool_calls: [{ id: `c${i}`, type: "function", function: { name: "t", arguments: "{}" } }] },
    { role: "tool", tool_call_id: `c${i}`, content: "r" });
  const second = (await compactTurnMessages(first.messages, request, { keepExchanges: 3, summarize, summaryBudgetBytes: 50_000 }))!;
  expect(prompts[1]).toContain("summary 1");
  expect(second.messages.filter((m) => typeof m.content === "string" && m.content.startsWith(SUMMARY_TAG))).toHaveLength(1);
  expect(valid(second.messages)).toBe(true);
  expect(second.messages).toContain(request);
});

test("a failing summarizer falls back to a deterministic note", async () => {
  const { messages, request } = longTurn(6);
  const result = (await compactTurnMessages(messages, request, { keepExchanges: 2, summarize: async () => { throw new Error("down"); }, summaryBudgetBytes: 50_000 }))!;
  expect(result.summarizer).toBe("fallback");
  expect(result.afterTokens).toBeLessThan(result.beforeTokens);
});

test("with few rounds this turn, the transcript before the request folds and the request stays", () => {
  const { messages, request } = longTurn(1);
  const next = planCompaction(messages, request, 4)!.build("S");
  expect(next.map((m) => m.role)).toEqual(["system", "user", "user", "assistant", "tool"]);
  expect(next[2]).toBe(request);
  expect(valid(next)).toBe(true);
});

test("nothing to fold returns null", async () => {
  const request: OpenAIChatMessage = { role: "user", content: "hi" };
  expect(planCompaction([{ role: "system", content: "s" }, request], request)).toBeNull();
});

test("context overflow refusals are recognized across providers", () => {
  expect(refusesContextLength(400, '{"error":{"code":"context_length_exceeded"}}')).toBe(true);
  expect(refusesContextLength(400, "This model's maximum context length is 8192 tokens")).toBe(true);
  expect(refusesContextLength(400, "prompt is too long: 210000 tokens > 200000 maximum")).toBe(true);
  expect(refusesContextLength(400, "the request exceeds the available context size")).toBe(true);
  expect(refusesContextLength(400, "Please reduce the length of the messages or completion.")).toBe(true);
  expect(refusesContextLength(401, "maximum context length")).toBe(false);
  expect(refusesContextLength(400, "invalid model")).toBe(false);
});
