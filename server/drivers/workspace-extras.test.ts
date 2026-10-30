import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeWorkspaceTool, skillReadRoots, workspaceToolReadOnly, workspaceToolView, validateWorkspaceArgs, type WorkspaceToolsConfig } from "./workspace-tools.ts";
import { htmlToText, privateAddress } from "./web-tools.ts";

let base: string;
let root: string;
let config: WorkspaceToolsConfig;
const run = (name: string, args: Record<string, unknown>) => executeWorkspaceTool(name, args, config, new AbortController().signal);

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "ws-extra-"));
  root = join(base, "root");
  mkdirSync(root);
  config = { root };
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe("dangling and chained symlinks", () => {
  it("refuses writing through a dangling link whose target is outside", async () => {
    symlinkSync(join(base, "not-yet.txt"), join(root, "dead"));
    const result = await run("write_file", { path: "dead", content: "pwned" });
    expect(result.ok).toBe(false);
    expect(existsSync(join(base, "not-yet.txt"))).toBe(false);
  });
  it("refuses a dangling link to a missing folder outside", async () => {
    symlinkSync(join(base, "gone", "deeper"), join(root, "deaddir"));
    expect((await run("write_file", { path: "deaddir/x.txt", content: "x" })).ok).toBe(false);
    expect(existsSync(join(base, "gone"))).toBe(false);
  });
  it("refuses a link chain that ends outside", async () => {
    writeFileSync(join(base, "secret"), "s");
    symlinkSync(join(base, "secret"), join(root, "b"));
    symlinkSync(join(root, "b"), join(root, "a"));
    expect((await run("read_file", { path: "a" })).ok).toBe(false);
  });
  it("allows a dangling link that stays inside and writes its target", async () => {
    symlinkSync(join(root, "later.txt"), join(root, "inner"));
    expect((await run("write_file", { path: "inner", content: "ok" })).ok).toBe(true);
    expect(readFileSync(join(root, "later.txt"), "utf8")).toBe("ok");
  });
});

describe("git tools", () => {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  beforeEach(() => {
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "T");
    writeFileSync(join(root, "a.txt"), "one\n");
  });
  it("shows status and diff, commits only the named paths, never pushes", async () => {
    expect((await run("git_status", {})).text).toMatch(/\?\? a\.txt/);
    writeFileSync(join(root, "b.txt"), "b\n");
    const commit = await run("git_commit", { message: "add a", paths: ["a.txt"] });
    expect(commit.ok).toBe(true);
    expect((await run("git_log", {})).text).toMatch(/add a/);
    expect((await run("git_status", {})).text).toMatch(/\?\? b\.txt/);
    writeFileSync(join(root, "a.txt"), "two\n");
    expect((await run("git_diff", { paths: ["a.txt"] })).text).toMatch(/\+two/);
    expect((await run("git_push" as string, {})).ok).toBe(false);
  });
  it("keeps the repo and paths inside the workspace", async () => {
    expect((await run("git_status", { repo: ".." })).text).toMatch(/outside the workspace/);
    expect((await run("git_diff", { paths: ["../../etc/passwd"] })).ok).toBe(false);
  });
  it("does not run a repo-configured fsmonitor on status", async () => {
    const marker = join(base, "ran");
    git("config", "core.fsmonitor", `touch ${marker}; false`);
    await run("git_status", {});
    expect(existsSync(marker)).toBe(false);
  });
  it("classifies reads, commit and approval", () => {
    expect(["git_status", "git_diff", "git_log", "web_fetch", "web_search"].every(workspaceToolReadOnly)).toBe(true);
    expect(workspaceToolReadOnly("git_commit")).toBe(false);
    expect(workspaceToolView("git_commit", { message: "m" }).ask).toBe(true);
    expect(workspaceToolView("git_status", {}).ask).toBe(false);
    expect(() => validateWorkspaceArgs("git_diff", { paths: "a.txt" })).toThrow(/array/);
    expect(() => validateWorkspaceArgs("git_diff", { paths: ["a.txt"] })).not.toThrow();
  });
});

describe("web tools", () => {
  let server: Server;
  let origin: string;
  beforeEach(async () => {
    server = createServer((request, response) => {
      if (request.url?.startsWith("/redirect")) { response.writeHead(302, { location: "/page" }); response.end(); return; }
      if (request.url?.startsWith("/html/")) {
        response.setHeader("content-type", "text/html");
        response.end('<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&amp;rut=1">Example <b>A</b></a><a class="result__snippet" href="#">First &amp; best</a>');
        return;
      }
      response.setHeader("content-type", "text/html");
      response.end("<html><head><title>t</title><script>evil()</script></head><body><h1>Hello</h1><p>World &amp; more</p></body></html>");
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterEach(() => new Promise<void>((done) => server.close(() => done())));

  it("refuses loopback and private targets by default", async () => {
    const result = await run("web_fetch", { url: `${origin}/page` });
    expect(result.ok).toBe(false);
    expect(result.text).toMatch(/private or local/);
    expect((await run("web_fetch", { url: "file:///etc/passwd" })).text).toMatch(/only http/);
    expect(["10.0.0.1", "192.168.1.1", "172.16.0.1", "169.254.169.254", "::1", "fd00::1", "::ffff:127.0.0.1"].every(privateAddress)).toBe(true);
    expect(privateAddress("93.184.216.34")).toBe(false);
  });
  it("fetches readable text, following redirects", async () => {
    config = { root, webOptions: { allowPrivate: true } };
    const result = await run("web_fetch", { url: `${origin}/redirect` });
    expect(result.ok).toBe(true);
    expect(result.text).toContain("Hello");
    expect(result.text).toContain("World & more");
    expect(result.text).not.toContain("evil");
  });
  it("parses search results", async () => {
    config = { root, webOptions: { allowPrivate: true, searchUrl: `${origin}/html/` } };
    const result = await run("web_search", { query: "x" });
    expect(result.text).toBe("1. Example A\n   https://example.com/a\n   First & best");
  });
  it("reduces html to text", () => {
    expect(htmlToText("<p>a</p><p>b&#33;</p>")).toBe("a\nb!");
  });
});

describe("skill folders", () => {
  it("are readable from the prompt's SKILL.md paths, never writable", async () => {
    const skill = join(base, "skills", "demo");
    mkdirSync(skill, { recursive: true });
    writeFileSync(join(skill, "SKILL.md"), "# demo");
    const prompt = `Imported skills:\n- demo: Demo. Read ${JSON.stringify(join(skill, "SKILL.md"))}.`;
    expect(skillReadRoots(prompt, undefined)).toEqual([skill]);
    expect(skillReadRoots('Read "relative/SKILL.md".')).toEqual([]);
    config = { root, readRoots: skillReadRoots(prompt) };
    expect((await run("read_file", { path: join(skill, "SKILL.md") })).text).toContain("# demo");
    expect((await run("write_file", { path: join(skill, "SKILL.md"), content: "x" })).ok).toBe(false);
    expect((await run("read_file", { path: join(base, "skills") })).ok).toBe(false);
  });
});
