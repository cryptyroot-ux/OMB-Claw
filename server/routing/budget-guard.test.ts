// server/routing/budget-guard.test.ts
import { describe, it, expect } from "vitest";
import { BudgetGuard } from "./budget-guard.ts";

describe("BudgetGuard", () => {
  it("allows within budget", () => {
    const guard = new BudgetGuard({ perThreadLimit: 10, perRunLimit: 5 });
    expect(guard.check(2, "thread-1")).toBe(true);
  });

  it("blocks when thread budget exceeded", () => {
    const guard = new BudgetGuard({ perThreadLimit: 10, perRunLimit: 5 });
    guard.record(9, "thread-1");
    expect(guard.check(2, "thread-1")).toBe(false);
  });

  it("blocks when run budget exceeded", () => {
    const guard = new BudgetGuard({ perThreadLimit: 100, perRunLimit: 5 });
    guard.record(4, "thread-1");
    expect(guard.check(2, "thread-1")).toBe(false);
  });

  it("tracks per-thread separately", () => {
    const guard = new BudgetGuard({ perThreadLimit: 10, perRunLimit: 100 });
    guard.record(9, "thread-1");
    expect(guard.check(2, "thread-2")).toBe(true);
  });
});
