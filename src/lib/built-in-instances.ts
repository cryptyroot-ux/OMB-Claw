/** The server's default instances by id, with their driver kinds, plus `gemini`, which an enterprise licence restores. */
export const BUILT_IN_INSTANCE_DRIVERS: Readonly<Record<string, string>> = {
  openaiCompat: "openai-compat",
  mistral: "mistral", cerebras: "cerebras", groq: "groq", meta: "meta", openai: "openai-compat",
  xaiApi: "grok", openrouter: "openai-compat",
};
