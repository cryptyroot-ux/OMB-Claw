// Model caller factory: wraps a ModelAdapter into a simple (prompt) => Promise<string>
// function usable by the Intelligence Layer (planner/verifier). Collects model.delta
// events into a single string. Non-streaming fallback supported.
// Multimodal: accepts optional images (data-URLs) and sends them as image parts.

import type { ModelAdapter } from "../agent-runtime/contracts.ts";

function parseDataUrl(dataUrl: string): { mimeType: string; data: string } | null {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  return { mimeType: match[1], data: match[2] };
}

export function createModelCaller(
  adapter: ModelAdapter,
  modelId: string,
): (prompt: string, images?: string[]) => Promise<string> {
  return async (prompt: string, images?: string[]): Promise<string> => {
    let out = "";
    try {
      let content: string | Array<{ type: "text"; text: string } | { type: "image"; mimeType: string; data: string }>;
      if (images && images.length > 0) {
        const parts: Array<{ type: "text"; text: string } | { type: "image"; mimeType: string; data: string }> = [
          { type: "text", text: prompt },
        ];
        for (const img of images) {
          const parsed = parseDataUrl(img);
          if (parsed) {
            parts.push({ type: "image", mimeType: parsed.mimeType, data: parsed.data });
          }
        }
        content = parts;
      } else {
        content = prompt;
      }

      for await (const event of adapter.generate({
        messages: [{ role: "user", content }],
        model: modelId,
        tools: [],
      } as any)) {
        const e = event as { type?: string; delta?: string; kind?: string };
        if ((e.type === "model.delta" || (e.type === "content.delta" && e.kind === "assistant_text")) && typeof e.delta === "string") {
          out += e.delta;
        }
        if (e.type === "completed") break;
      }
    } catch {
      // swallow; return whatever collected
    }
    return out;
  };
}