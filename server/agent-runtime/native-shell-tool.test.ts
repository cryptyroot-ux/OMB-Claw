import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { runShellTool, type ShellToolContext } from "./native-shell-tool.ts";

let root: string;
let ctx: ShellToolContext;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "nsh-")); ctx = { root }; });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("native shell tool", () => {
  it("runs echo and captures stdout", async () => {
    const r = await runShellTool(ctx, { command: "echo hello" });
    expect(r.ok).toBe(true);
    expect(r.content).toContain("hello");
    expect(r.exitCode).toBe(0);
  });

  it("captures stderr and non-zero exit", async () => {
    const r = await runShellTool(ctx, { command: "ls /nonexistent-dir-xyz" });
    expect(r.ok).toBe(false);
    expect(r.exitCode).not.toBe(0);
  });

  it("supports pipes", async () => {
    const r = await runShellTool(ctx, { command: "echo 'a b c' | tr ' ' '\\n' | wc -l" });
    expect(r.ok).toBe(true);
    expect(r.content.trim()).toMatch(/3/);
  });

  it("times out", async () => {
    const r = await runShellTool(ctx, { command: "sleep 10", timeout: 1000 });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("timed out");
  });

  it("rejects empty command", async () => {
    const r = await runShellTool(ctx, { command: "" });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("required");
  });

  it("runs in workspace cwd", async () => {
    const r = await runShellTool(ctx, { command: "pwd" });
    expect(r.ok).toBe(true);
    expect(r.content).toContain(root);
  });

  it("blocks write commands in read-only sandbox", async () => {
    const roCtx = { ...ctx, sandboxMode: "read-only" as const };
    const r = await runShellTool(roCtx, { command: "rm -rf /tmp/x" });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("read-only sandbox");
  });

  it("allows read commands in read-only sandbox", async () => {
    const roCtx = { ...ctx, sandboxMode: "read-only" as const };
    const r = await runShellTool(roCtx, { command: "echo hello" });
    expect(r.ok).toBe(true);
  });
});
