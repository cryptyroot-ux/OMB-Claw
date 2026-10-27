import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { runGitTool, type GitToolContext } from "./native-git-tool.ts";

let root: string;
let ctx: GitToolContext;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "ngit-")); ctx = { root }; });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("native git tool", () => {
  it("init creates a repo", async () => {
    const r = await runGitTool(ctx, { operation: "init" });
    expect(r.ok).toBe(true);
  });

  it("status on fresh repo", async () => {
    await runGitTool(ctx, { operation: "init" });
    const r = await runGitTool(ctx, { operation: "status" });
    expect(r.ok).toBe(true);
  });

  it("add + commit + log", async () => {
    await runGitTool(ctx, { operation: "init" });
    writeFileSync(join(root, "a.txt"), "hello", "utf8");
    const add = await runGitTool(ctx, { operation: "add", paths: ["."] });
    expect(add.ok).toBe(true);
    const commit = await runGitTool(ctx, { operation: "commit", message: "initial" });
    expect(commit.ok).toBe(true);
    const log = await runGitTool(ctx, { operation: "log" });
    expect(log.ok).toBe(true);
    expect(log.content).toContain("initial");
  });

  it("diff shows changes", async () => {
    await runGitTool(ctx, { operation: "init" });
    writeFileSync(join(root, "a.txt"), "hello", "utf8");
    await runGitTool(ctx, { operation: "add", paths: ["."] });
    await runGitTool(ctx, { operation: "commit", message: "initial" });
    writeFileSync(join(root, "a.txt"), "hello world", "utf8");
    const r = await runGitTool(ctx, { operation: "diff" });
    expect(r.ok).toBe(true);
    expect(r.content).toContain("hello world");
  });

  it("branch create and list", async () => {
    await runGitTool(ctx, { operation: "init" });
    writeFileSync(join(root, "a.txt"), "hello", "utf8");
    await runGitTool(ctx, { operation: "add", paths: ["."] });
    await runGitTool(ctx, { operation: "commit", message: "initial" });
    const br = await runGitTool(ctx, { operation: "branch", name: "feature-x" });
    expect(br.ok).toBe(true);
    const list = await runGitTool(ctx, { operation: "branch" });
    expect(list.content).toContain("feature-x");
  });

  it("checkout switches branch", async () => {
    await runGitTool(ctx, { operation: "init" });
    writeFileSync(join(root, "a.txt"), "hello", "utf8");
    await runGitTool(ctx, { operation: "add", paths: ["."] });
    await runGitTool(ctx, { operation: "commit", message: "initial" });
    await runGitTool(ctx, { operation: "branch", name: "dev" });
    const co = await runGitTool(ctx, { operation: "checkout", target: "dev" });
    expect(co.ok).toBe(true);
  });

  it("rejects unknown operation", async () => {
    const r = await runGitTool(ctx, { operation: "push" });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("Unknown operation");
  });

  it("commit requires message", async () => {
    await runGitTool(ctx, { operation: "init" });
    const r = await runGitTool(ctx, { operation: "commit" });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("message is required");
  });
});
