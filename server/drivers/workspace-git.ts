// Native git tools for the workspace: status, diff, log (read-only) and commit (mutating, asks in Ask mode).
// git runs through execFile (no shell). Repo-configured programs that read-only commands could otherwise start
// (fsmonitor, external diff, textconv, pagers) are switched off for status/diff/log. There is deliberately no push.
import { execFile } from "node:child_process";
import type { ChatToolDefinition, ChatToolResult } from "./chat-mcp-tools.ts";

const GIT_TIMEOUT_MS = 60_000;
const GIT_MAX_OUTPUT = 4 * 1024 * 1024;
const SAFE_READ_CONFIG = ["-c", "core.fsmonitor=false", "-c", "core.pager=cat", "-c", "diff.external=", "-c", "color.ui=false"];

export const GIT_READ_TOOLS = ["git_status", "git_diff", "git_log"] as const;
export const GIT_COMMIT_TOOL = "git_commit";

const fn = (name: string, description: string, properties: Record<string, unknown>, required: string[]): ChatToolDefinition => ({
  type: "function", function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false } },
});
const paths = { type: "array", items: { type: "string" }, description: "Limit to these paths (relative to the repository folder)." };
const repo = { type: "string", description: "Repository folder, relative to the workspace (default: the workspace root)." };

export const GIT_TOOL_DEFINITIONS: readonly ChatToolDefinition[] = [
  fn("git_status", "Show the git branch and changed files (git status --short --branch).", { repo }, []),
  fn("git_diff", "Show unstaged changes, or staged ones with staged=true, optionally limited to paths (git diff).", {
    repo, paths, staged: { type: "boolean", description: "Show the staged (index) diff instead." },
  }, []),
  fn("git_log", "Show recent commits, one line each (git log --oneline).", {
    repo, max_count: { type: "integer", description: "Commits to show (default 10, max 100).", minimum: 1, maximum: 100 }, paths,
  }, []),
  fn(GIT_COMMIT_TOOL, "Stage files and create a commit (git add -- <paths>; git commit -m). Never pushes. " +
    "Pass the files you changed; paths=[\".\"] stages everything.", {
    repo, message: { type: "string", description: "The commit message." }, paths,
  }, ["message"]),
];

export function runGit(args: readonly string[], cwd: string, signal: AbortSignal): Promise<{ code: number; out: string }> {
  return new Promise((done) => {
    execFile("git", [...args], { cwd, signal, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_OUTPUT, encoding: "utf8",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", PAGER: "cat" } }, (error, stdout, stderr) => {
      const out = `${stdout ?? ""}${stderr ? `${stdout ? "\n" : ""}${stderr}` : ""}`.trim();
      if (!error) return done({ code: 0, out });
      const code = typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1;
      done({ code, out: out || error.message });
    });
  });
}

const list = (value: unknown): string[] => Array.isArray(value) ? value.map(String).filter((entry) => entry.trim()) : [];

/** `resolvePath` confines both the repository folder and every path argument to the workspace. */
export async function executeGitTool(name: string, args: Record<string, unknown>, resolvePath: (input: unknown, mode: "read" | "write") => string,
  root: string, signal: AbortSignal): Promise<ChatToolResult> {
  const cwd = resolvePath(typeof args.repo === "string" && args.repo.trim() ? args.repo : root, name === GIT_COMMIT_TOOL ? "write" : "read");
  const files = list(args.paths).map((path) => resolvePath(path.startsWith("/") ? path : `${cwd}/${path}`, name === GIT_COMMIT_TOOL ? "write" : "read"));
  const result = (r: { code: number; out: string }, empty: string): ChatToolResult => ({ ok: r.code === 0, text: r.out || (r.code === 0 ? empty : `git exited ${r.code}`) });
  switch (name) {
    case "git_status": return result(await runGit([...SAFE_READ_CONFIG, "status", "--short", "--branch"], cwd, signal), "Working tree clean.");
    case "git_diff": return result(await runGit([...SAFE_READ_CONFIG, "diff", "--no-ext-diff", "--no-textconv",
      ...(args.staged === true ? ["--cached"] : []), "--", ...files], cwd, signal), "No changes.");
    case "git_log": {
      const count = Math.min(100, Math.max(1, Math.floor(Number(args.max_count) || 10)));
      return result(await runGit([...SAFE_READ_CONFIG, "log", `--max-count=${count}`, "--oneline", "--decorate", "--", ...files], cwd, signal), "No commits.");
    }
    case GIT_COMMIT_TOOL: {
      const message = String(args.message ?? "").trim();
      if (!message) return { ok: false, text: "git_commit needs a message." };
      if (files.length) {
        const added = await runGit(["add", "--", ...files], cwd, signal);
        if (added.code !== 0) return result(added, "");
      }
      return result(await runGit(["commit", "-m", message], cwd, signal), "Committed.");
    }
    default: return { ok: false, text: `Unknown git tool ${name}.` };
  }
}
