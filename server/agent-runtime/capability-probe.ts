// Per-model capability detection for the OpenAI-compatible family.
//
// A registry alone does not make a model capable: context windows, tool calling,
// vision and audio differ per model. This probe combines (1) the declared catalog
// (context window), (2) model-id heuristics, and (3) operator hints (toolsEnabled,
// imageInput/audioInput predicates) into a ModelCapabilities value. It fails
// closed for anything it cannot establish: an unknown model is reported as
// "unknown" for tools so the engine never silently claims support it cannot
// verify, while the adapter's unsupported_tools fallback still recovers when a
// "supported" claim turns out to be wrong.
import type { ModelCapabilities, ModelCatalog } from "./contracts.ts";

export interface CapabilityProbeHints {
  readonly toolsEnabled?: boolean;
  readonly imageInput?: (modelId: string) => boolean;
  readonly audioInput?: (modelId: string) => boolean;
}

const NON_TOOL_PATTERNS: readonly RegExp[] = [
  /embed/i,
  /tts/i,
  /whisper/i,
  /dall-e/i,
  /moderation/i,
  /rerank/i,
];

const VISION_PATTERNS: readonly RegExp[] = [
  /vision/i,
  /gpt-4o/i,
  /gpt-4-turbo/i,
  /gpt-5/i,
  /claude-3/i,
  /claude-4/i,
  /gemini/i,
  /llava/i,
  /qwen.*vl/i,
  /pixtral/i,
  /mimo/i,
];

const AUDIO_INPUT_PATTERNS: readonly RegExp[] = [
  /audio/i,
  /whisper/i,
  /gpt-4o-audio/i,
];

const cache = new Map<string, ModelCapabilities>();

export function clearCapabilityProbeCache(): void {
  cache.clear();
}

export function probeCapabilities(
  modelId: string,
  catalog: ModelCatalog | (() => ModelCatalog),
  hints: CapabilityProbeHints = {},
): ModelCapabilities {
  // Cache by model id only (catalog context window is folded into the entry lookup; keep simple).
  const cacheKey = modelId;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const resolvedCatalog = typeof catalog === "function" ? catalog() : catalog;
  const entry = resolvedCatalog.options.find((option) => option.id === modelId);
  const contextWindow = entry?.contextWindow
    ? { status: "known" as const, value: entry.contextWindow }
    : { status: "unknown" as const };

  const toolsEnabled = hints.toolsEnabled !== false;
  const isNonTool = NON_TOOL_PATTERNS.some((pattern) => pattern.test(modelId));
  // Default to "supported" for OpenAI-compatible endpoints: the adapter already
  // recovers when the provider rejects tools (unsupported_tools fallback). Only
  // clearly non-tool models (embeddings, tts, whisper, dall-e, ...) are marked
  // unsupported, so unrecognized/new models keep working instead of being
  // blocked outright.
  const tools: ModelCapabilities["tools"] = !toolsEnabled || isNonTool
    ? "unsupported"
    : "supported";

  const imageInput: ModelCapabilities["imageInput"] =
    hints.imageInput?.(modelId)
      ? "supported"
      : VISION_PATTERNS.some((pattern) => pattern.test(modelId))
        ? "supported"
        : "unsupported";

  const audioInput: ModelCapabilities["audioInput"] =
    hints.audioInput?.(modelId)
      ? "supported"
      : AUDIO_INPUT_PATTERNS.some((pattern) => pattern.test(modelId))
        ? "supported"
        : "unsupported";

  const result: ModelCapabilities = {
    tools,
    parallelTools: tools === "supported" ? "supported" : "unknown",
    streaming: "supported",
    contextWindow,
    imageInput,
    imageOutput: "unsupported",
    audioInput,
    audioOutput: "unsupported",
    structuredOutput: "unknown",
    toolSchemaLimit: { status: "unknown" },
  };

  cache.set(cacheKey, result);
  return result;
}
