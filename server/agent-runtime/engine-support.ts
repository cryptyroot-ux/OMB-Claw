// This OMB build does not support external agent engines. Their drivers stay
// in the tree but are not registered, so stored selections become unavailable
// rather than launching a CLI or ACP process.
const EXTERNAL_AGENT_ENGINES = new Set([
  "claudeAgent",
  "codex",
  "opencodeGo",
  "hermesAgent",
  "piAgent",
  "antigravityAgent",
  "customAcp",
  "grokAgent",
  "geminiAgent",
  "kimiAgent",
  "droidAgent",
  "cursorAgent",
  "qwenAgent",
  "clineAgent",
  "deepseekAgent",
  "museCode",
]);

export function isExternalAgentEngine(driverKind: string): boolean {
  return EXTERNAL_AGENT_ENGINES.has(driverKind);
}

export function supportedAgentDrivers<T extends { readonly driverKind: string }>(drivers: readonly T[]): readonly T[] {
  return drivers.filter((driver) => !isExternalAgentEngine(driver.driverKind));
}
