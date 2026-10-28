import { describe, expect, it } from "vitest";
import {
  checkCommandSafety,
  parseSandboxMode,
  VALID_SANDBOX_MODES,
} from "./sandbox.ts";

describe("sandbox: parseSandboxMode", () => {
  it("accepts valid modes", () => {
    for (const m of VALID_SANDBOX_MODES) expect(parseSandboxMode(m)).toBe(m);
  });
  it("rejects unknown", () => {
    expect(parseSandboxMode("nope")).toBeNull();
    expect(parseSandboxMode(null)).toBeNull();
    expect(parseSandboxMode(42)).toBeNull();
  });
});

describe("sandbox: full mode", () => {
  it("allows everything", () => {
    const r = checkCommandSafety("rm -rf /", { mode: "full" });
    expect(r.allowed).toBe(true);
  });
});

describe("sandbox: read-only", () => {
  it("blocks write indicators", () => {
    const r = checkCommandSafety("rm -rf /tmp/x", { mode: "read-only" });
    expect(r.allowed).toBe(false);
  });
  it("allows read commands", () => {
    const r = checkCommandSafety("ls -la", { mode: "read-only" });
    expect(r.allowed).toBe(true);
  });
  it("blocks escape (parent traversal)", () => {
    const r = checkCommandSafety("cat ../secret.txt", { mode: "read-only" });
    expect(r.allowed).toBe(false);
  });
  it("blocks escape to /etc", () => {
    const r = checkCommandSafety("cat /etc/passwd", { mode: "read-only" });
    expect(r.allowed).toBe(false);
  });
});

describe("sandbox: custom mode", () => {
  it("allows commands on the allowlist", () => {
    const r = checkCommandSafety("ls -la", { mode: "custom", allowedCommands: ["ls", "cat"] });
    expect(r.allowed).toBe(true);
  });
  it("blocks commands not on the allowlist", () => {
    const r = checkCommandSafety("rm -rf /", { mode: "custom", allowedCommands: ["ls", "cat"] });
    expect(r.allowed).toBe(false);
  });
  it("handles compound command by leading token", () => {
    const r = checkCommandSafety("ls | cat", { mode: "custom", allowedCommands: ["ls", "cat"] });
    expect(r.allowed).toBe(true); // leading token "ls" is allowed
  });
  it("rejects empty allowlist", () => {
    const r = checkCommandSafety("ls", { mode: "custom", allowedCommands: [] });
    expect(r.allowed).toBe(false);
  });
  it("blocks escape", () => {
    const r = checkCommandSafety("ls ../", { mode: "custom", allowedCommands: ["ls"] });
    expect(r.allowed).toBe(false);
  });
});

describe("sandbox: workspace-write", () => {
  it("allowed by default", () => {
    const r = checkCommandSafety("echo hi", { mode: "workspace-write" });
    expect(r.allowed).toBe(true);
  });
  it("allows writes", () => {
    const r = checkCommandSafety("mkdir newdir", { mode: "workspace-write" });
    expect(r.allowed).toBe(true);
  });
  it("blocks escape (parent traversal)", () => {
    const r = checkCommandSafety("cd ../..", { mode: "workspace-write" });
    expect(r.allowed).toBe(false);
  });
  it("blocks /proc", () => {
    const r = checkCommandSafety("cat /proc/cpuinfo", { mode: "workspace-write" });
    expect(r.allowed).toBe(false);
  });
});

describe("sandbox: empty command", () => {
  it("rejects empty", () => {
    expect(checkCommandSafety("   ", { mode: "full" }).allowed).toBe(false);
  });
});
