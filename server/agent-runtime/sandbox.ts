// Sandbox boundary for the native shell tool (Codex-inspired policy).
//
// Four modes:
//   - "workspace-write" (default): commands may run and write inside the workspace root; obvious
//     attempts to escape the workspace are rejected.
//   - "read-only": no write operations at all.
//   - "full": unrestricted (host command, inherited env).
//   - "custom": only commands whose name appears in `allowedCommands` may run.
//
// Safety is heuristic, not OS-level isolation: every command is still run with Node's
// `exec`, so do not treat this as a security boundary on multi-tenant hosts. It does,
// however, make accidental destructive/wide-ranging commands fail closed.

export type SandboxMode = "workspace-write" | "read-only" | "full" | "custom";

export const VALID_SANDBOX_MODES: readonly SandboxMode[] = [
  "workspace-write",
  "read-only",
  "full",
  "custom",
];

export function parseSandboxMode(value: unknown): SandboxMode | null {
  if (typeof value !== "string") return null;
  return VALID_SANDBOX_MODES.includes(value as SandboxMode) ? (value as SandboxMode) : null;
}

const WRITE_INDICATORS = /\b(rm|mv|cp|chmod|chown|mkdir|rmdir|touch|dd|tee|truncate|install|ln|rsync|scp|wget|curl)\b|[>]{1,2}/;

function isWriteCommand(command: string): boolean {
  return WRITE_INDICATORS.test(command);
}

/** Obvious workspace-escape patterns: parent traversal or absolute reads of system dirs. */
function escapesWorkspace(command: string): boolean {
  // Parent traversal segment anywhere.
  if (/(?:^|[\s/&;|])\.{2}(?:\/|\\|$)/.test(command)) return true;
  // Absolute path to obvious system/public dirs outside the workspace root.
  if (/(?:^|[\s;&|])(?:\/(?:etc|proc|sys|dev|var\/log|root|home))\b/.test(command)) return true;
  return false;
}

export interface SandboxCheckContext {
  readonly mode: SandboxMode;
  readonly allowedCommands?: ReadonlyArray<string>;
}

export interface SandboxCheckResult {
  readonly allowed: boolean;
  readonly reason?: string;
}

export function checkCommandSafety(
  command: string,
  ctx: SandboxCheckContext,
): SandboxCheckResult {
  const trimmed = command.trim();
  if (!trimmed) {
    return { allowed: false, reason: "command is required" };
  }

  switch (ctx.mode) {
    case "full": {
      // Unrestricted. Still block obviously empty commands only.
      return { allowed: true };
    }
    case "read-only": {
      if (isWriteCommand(trimmed)) {
        return { allowed: false, reason: "Command blocked: read-only sandbox mode does not allow write operations." };
      }
      // Even in read-only, do not let the shell climb out of the workspace.
      if (escapesWorkspace(trimmed)) {
        return { allowed: false, reason: "Command blocked: path escapes the workspace." };
      }
      return { allowed: true };
    }
    case "custom": {
      const allowlist = new Set((ctx.allowedCommands ?? []).map((c) => c.trim().toLowerCase()).filter(Boolean));
      if (allowlist.size === 0) {
        return { allowed: false, reason: "Command blocked: custom sandbox mode has an empty allowlist." };
      }
      // Pull the leading command name from the (possibly compound) command.
      const head = trimmed.split(/\s+/)[0] ?? "";
      const base = head.split(/[\\/]/).pop()?.toLowerCase() ?? "";
      if (!base || !allowlist.has(base)) {
        return { allowed: false, reason: `Command blocked: "${base || head}" is not on the sandbox allowlist.` };
      }
      if (escapesWorkspace(trimmed)) {
        return { allowed: false, reason: "Command blocked: path escapes the workspace." };
      }
      return { allowed: true };
    }
    case "workspace-write":
    default: {
      // Workspace-write allows writes only inside the workspace; block escapes.
      if (escapesWorkspace(trimmed)) {
        return { allowed: false, reason: "Command blocked: path escapes the workspace." };
      }
      return { allowed: true };
    }
  }
}
