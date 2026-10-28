// server/routing/budget-guard.ts

import { appendNative } from "../drivers/native.ts";

export interface BudgetGuardLimits {
  perThreadLimit?: number;
  perRunLimit?: number;
  threadLimit?: number;
  runLimit?: number;
  maxThreadCost?: number;
  maxRunCost?: number;
  perThread?: number;
  perRun?: number;
  thread?: number;
  run?: number;
  maxThread?: number;
  maxRun?: number;
}

export class BudgetGuard {
  private readonly perThreadLimit: number;
  private readonly perRunLimit: number;
  private readonly threadSpend = new Map<string, number>();
  private runSpend = 0;

  constructor(
    limits: BudgetGuardLimits | number = {},
    perRunLimit?: number,
  ) {
    if (typeof limits === "number") {
      this.perThreadLimit = Number.isFinite(limits) ? limits : Infinity;
      this.perRunLimit = Number.isFinite(perRunLimit) ? (perRunLimit as number) : Infinity;
      return;
    }
    const l = limits ?? {};
    const finite = (v: unknown): number | undefined =>
      typeof v === "number" && Number.isFinite(v) ? v : undefined;
    this.perThreadLimit =
      finite(l.perThreadLimit) ??
      finite(l.perThread) ??
      finite(l.threadLimit) ??
      finite(l.thread) ??
      finite(l.maxThreadCost) ??
      finite(l.maxThread) ??
      Infinity;
    this.perRunLimit =
      finite(l.perRunLimit) ??
      finite(l.perRun) ??
      finite(l.runLimit) ??
      finite(l.run) ??
      finite(l.maxRunCost) ??
      finite(l.maxRun) ??
      Infinity;
  }

  private toCost(cost: unknown): number {
    if (cost && typeof cost === "object") {
      const obj = cost as Record<string, unknown>;
      // Handle ModelAssignment: cost lives at primary.estimatedCost
      if (obj.primary && typeof obj.primary === "object") {
        const primary = obj.primary as Record<string, unknown>;
        const candidate =
          primary.estimatedCost ?? primary.cost ?? primary.maxCost ?? primary.price ?? primary.amount;
        cost = candidate;
      } else {
        const candidate =
          obj.estimatedCost ?? obj.cost ?? obj.maxCost ?? obj.price ?? obj.amount;
        cost = candidate;
      }
    }
    const num = typeof cost === "string" ? Number(cost) : cost;
    if (typeof num !== "number" || !Number.isFinite(num)) return 0;
    return Math.max(0, num);
  }

  check(cost: unknown, threadId?: string): boolean {
    const normalizedCost = this.toCost(cost);
    const key = threadId ?? "";
    const threadTotal = (this.threadSpend.get(key) ?? 0) + normalizedCost;
    const runTotal = this.runSpend + normalizedCost;
    const allowed = threadTotal <= this.perThreadLimit && runTotal <= this.perRunLimit;
    if (threadId) {
      appendNative(threadId, {
        dir: "out",
        source: "budget-guard",
        msg: { action: "check", cost: normalizedCost, allowed, threadTotal, runTotal },
      });
    }
    return allowed;
  }

  record(cost: unknown, threadId?: string): void {
    const normalizedCost = this.toCost(cost);
    const key = threadId ?? "";
    this.threadSpend.set(key, (this.threadSpend.get(key) ?? 0) + normalizedCost);
    this.runSpend += normalizedCost;
    if (threadId) {
      appendNative(threadId, {
        dir: "out",
        source: "budget-guard",
        msg: { action: "record", cost: normalizedCost, threadTotal: this.threadSpend.get(key), runTotal: this.runSpend },
      });
    }
  }

  getThreadSpend(threadId?: string): number {
    return this.threadSpend.get(threadId ?? "") ?? 0;
  }

  getRunSpend(): number {
    return this.runSpend;
  }

  resetRun(): void {
    this.runSpend = 0;
  }

  /** Alias for resetRun(). Does NOT clear thread spend. */
  reset(): void {
    this.resetRun();
  }

  resetThread(threadId?: string): void {
    this.threadSpend.delete(threadId ?? "");
  }

  resetAll(): void {
    this.threadSpend.clear();
    this.runSpend = 0;
  }
}
