// Native web tools: fetch (HTTP GET) and search (DuckDuckGo HTML, no API key).
import { URL } from "node:url";

const FETCH_MAX_BYTES = 100_000;
const SEARCH_MAX_RESULTS = 10;

export interface WebToolContext {
  readonly root: string;
}

export interface WebToolResult {
  readonly ok: boolean;
  readonly content: string;
  readonly error?: string;
}

export async function runWebTool(_ctx: WebToolContext, args: Record<string, unknown>): Promise<WebToolResult> {
  const op = String(args?.operation ?? "fetch").trim();
  if (op === "fetch") {
    const url = String(args?.url ?? "").trim();
    if (!url) return { ok: false, content: "", error: "url is required" };
    let parsed: URL;
    try { parsed = new URL(url); } catch { return { ok: false, content: "", error: "invalid url" }; }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { ok: false, content: "", error: "only http/https allowed" };
    try {
      const res = await fetch(url, { headers: { "user-agent": "OMB-Native/1.0" }, signal: AbortSignal.timeout(30_000) });
      if (!res.ok) return { ok: false, content: "", error: `HTTP ${res.status}` };
      const text = await res.text();
      const clipped = text.length > FETCH_MAX_BYTES ? text.slice(0, FETCH_MAX_BYTES) + "\n[truncated]" : text;
      return { ok: true, content: clipped };
    } catch (e) {
      return { ok: false, content: "", error: e instanceof Error ? e.message : String(e) };
    }
  }
  if (op === "search") {
    const query = String(args?.query ?? "").trim();
    if (!query) return { ok: false, content: "", error: "query is required" };
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    try {
      const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (OMB-Native)" }, signal: AbortSignal.timeout(30_000) });
      if (!res.ok) return { ok: false, content: "", error: `HTTP ${res.status}` };
      const html = await res.text();
      // Parse result links + snippets
      const results: string[] = [];
      const linkRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
      const snippetRegex = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
      const links = [...html.matchAll(linkRegex)];
      const snippets = [...html.matchAll(snippetRegex)];
      for (let i = 0; i < Math.min(links.length, SEARCH_MAX_RESULTS); i++) {
        const href = links[i][1].replace(/.*uddg=/, "").split("&")[0];
        const title = links[i][2].replace(/<[^>]*>/g, "").trim();
        const snippet = (snippets[i]?.[1] ?? "").replace(/<[^>]*>/g, "").trim();
        let decoded = href;
        try { decoded = decodeURIComponent(href); } catch {}
        results.push(`${i + 1}. ${title}\n   ${decoded}\n   ${snippet}`);
      }
      if (results.length === 0) return { ok: true, content: "No results found." };
      return { ok: true, content: results.join("\n\n") };
    } catch (e) {
      return { ok: false, content: "", error: e instanceof Error ? e.message : String(e) };
    }
  }
  return { ok: false, content: `Unknown operation: ${op}. Supported: fetch, search`, error: `Unknown operation: ${op}` };
}

export const WEB_TOOL_DESCRIPTOR = {
  id: "web",
  name: "web",
  description: "Fetch a URL or search the web. Operations: fetch (get page text), search (DuckDuckGo results).",
  schema: {
    type: "object",
    properties: {
      operation: { type: "string", enum: ["fetch", "search"], description: "fetch or search (default fetch)" },
      url: { type: "string", description: "URL to fetch (for fetch)" },
      query: { type: "string", description: "Search query (for search)" },
    },
    additionalProperties: false,
  },
  risk: "read" as const,
  sideEffect: false,
  timeoutMs: 30_000,
};
