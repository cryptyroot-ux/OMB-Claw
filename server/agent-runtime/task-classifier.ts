// Task complexity classifier: heuristically scores an incoming task as
// trivial/simple/medium/complex/expert so the Intelligence Layer can route it
// to the cheapest capable model and budget accordingly.
//
// Pure function; no I/O. Callers may override with an LLM-based classifier.

export type ComplexityLevel = "trivial" | "simple" | "medium" | "complex" | "expert";

export interface TaskSignals {
  readonly text: string;
  readonly messageCount?: number;
  readonly toolCount?: number;
  readonly hasImages?: boolean;
  readonly hasCode?: boolean;
}

const COMPLEX_KEYWORDS = [
  /architect/i, /design/i, /refactor/i, /migrate/i, /optimize/i,
  /algorithm/i, /concurrent/i, /distributed/i, /security/i,
  /performance/i, /scalab/i, /multi.?step/i, /plan/i,
];

const TRIVIAL_PATTERNS = [
  /^(hi|hello|hey|thanks|thank you|ok|okay|yes|no|sure)\b/i,
  /^(what is|who is|when is|where is)\b/i,
];

export function classifyTask(signals: TaskSignals): ComplexityLevel {
  const text = signals.text ?? "";
  const len = text.length;
  const words = text.split(/\s+/).filter(Boolean).length;
  const messageCount = signals.messageCount ?? 1;
  const toolCount = signals.toolCount ?? 0;
  const hasImages = signals.hasImages ?? false;
  const hasCode = signals.hasCode ?? /```|function\s+\w|class\s+\w|import\s+/.test(text);

  // Trivial: very short, no tools, no code, greeting-like
  if (len < 40 && toolCount === 0 && !hasCode && !hasImages) {
    if (TRIVIAL_PATTERNS.some((p) => p.test(text))) return "trivial";
    if (words < 6) return "trivial";
  }

  let score = 0;
  // Length contribution
  if (len > 2000) score += 3;
  else if (len > 500) score += 2;
  else if (len > 100) score += 1;

  // Word count
  if (words > 200) score += 2;
  else if (words > 50) score += 1;

  // Tools
  if (toolCount > 5) score += 2;
  else if (toolCount > 0) score += 1;

  // Code
  if (hasCode) score += 2;

  // Images
  if (hasImages) score += 1;

  // Conversation depth
  if (messageCount > 10) score += 2;
  else if (messageCount > 3) score += 1;

  // Complex keywords
  const keywordHits = COMPLEX_KEYWORDS.filter((p) => p.test(text)).length;
  score += Math.min(keywordHits, 3);

  if (score >= 8) return "expert";
  if (score >= 6) return "complex";
  if (score >= 4) return "medium";
  if (score >= 2) return "simple";
  return "trivial";
}

export function complexityToTier(level: ComplexityLevel): "cheap" | "standard" | "premium" {
  switch (level) {
    case "trivial":
    case "simple":
      return "cheap";
    case "medium":
      return "standard";
    case "complex":
    case "expert":
      return "premium";
  }
}