// Native shell (Bash) tool for the OMB agent engine. Runs a command in the
// workspace root with a timeout and captured output. No MCP server needed.
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_BYTES = 1_000_000;
const TRUNCATE_NOTICE = "\n\n[Output truncated at 1 MB. Re-run with a narrower command or redirect to a file.]";

export interface ShellToolContext {
  readonly root: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface ShellToolResult {
  readonly ok: boolean;
  readonly content: string;
  readonly error?: string;
  readonly exitCode: number | null;
  readonly durationMs: number;
}

function stripControlPlaneEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  // Reuse the same deny list concept (provider keys, tokens).
  for (const name of Object.keys(out)) {
    if (/key|token|password|secret|authorization|credential/i.test(name)) delete out[name];
  }
  return out;
}

export async function runShellTool(ctx: ShellToolContext, args: Record<string, unknown>): Promise<ShellToolResult> {
  const command = String(args?.command ?? "").trim();
  if (!command) return { ok: false, content: "command is required", error: "command is required", exitCode: null, durationMs: 0 };

  const timeout = Math.min(Math.max(1000, Number(args?.timeout) || DEFAULT_TIMEOUT_MS), MAX_TIMEOUT_MS);
  const description = args?.description ? String(args.description) : "";
  const start = Date.now();

  const env = stripControlPlaneEnv(ctx.env ?? process.env);
  env.PATH = process.env.PATH ?? "/usr/bin:/bin";
  env.HOME = process.env.HOME ?? ctx.root;
  env.PWD = ctx.root;

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: ctx.root,
      env,
      timeout,
      maxBuffer: MAX_OUTPUT_BYTES,
      shell: true,
      windowsHide: true,
    } as any);
    const durationMs = Date.now() - start;
    let output = "";
    if (stdout) output += stdout;
    if (stderr) output += (output ? "\n--- stderr ---\n" : "") + stderr;
    if (output.length > MAX_OUTPUT_BYTES) output = output.slice(0, MAX_OUTPUT_BYTES) + TRUNCATE_NOTICE;
    const header = description ? `[${description}]\n` : "";
    const exitInfo = `exit code: 0 (${durationMs}ms)`;
    return { ok: true, content: `${header}${output}\n${exitInfo}`.trim(), exitCode: 0, durationMs };
  } catch (error: any) {
    const durationMs = Date.now() - start;
    const killed = error?.killed === true;
    const stdout = typeof error?.stdout === "string" ? error.stdout : "";
    const stderr = typeof error?.stderr === "string" ? error.stderr : "";
    let output = "";
    if (stdout) output += stdout;
    if (stderr) output += (output ? "\n--- stderr ---\n" : "") + stderr;
    if (output.length > MAX_OUTPUT_BYTES) output = output.slice(0, MAX_OUTPUT_BYTES) + TRUNCATE_NOTICE;
    const exitCode = typeof error?.code === "number" ? error.code : null;
    const reason = killed ? `timed out after ${timeout}ms` : (error?.message ?? "command failed");
    const header = description ? `[${description}]\n` : "";
    const exitInfo = killed ? `timed out (${durationMs}ms)` : `exit code: ${exitCode ?? "?"} (${durationMs}ms)`;
    return { ok: !killed && exitCode === 0, content: `${header}${output}\n${exitInfo}\n${reason}`.trim(), error: reason, exitCode, durationMs };
  }
}

export const SHELL_TOOL_DESCRIPTOR = {
  id: "bash",
  name: "bash",
  description: "Execute a shell command in the workspace. Supports pipes, redirects, &&. Times out at 2 min by default (max 10 min).",
  schema: {
    type: "object",
    properties: {
      command: { type: "string", description: "The shell command to execute." },
      description: { type: "string", description: "Short description of what the command does." },
      timeout: { type: "integer", minimum: 1000, maximum: 600000, description: "Timeout in ms (default 120000, max 600000)." },
    },
    required: ["command"],
    additionalProperties: false,
  },
  risk: "write" as const,
  sideEffect: true,
  timeoutMs: 600_000,
};
