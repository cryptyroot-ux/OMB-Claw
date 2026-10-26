/** Smaller models announce a step and end the turn without calling a tool. Both the legacy driver loop and the
 * native Agent Runtime nudge that reply, so the two engines share one predicate and one instruction. */
export const MAX_ANNOUNCEMENT_NUDGES = 3;

export const NUDGE_ANNOUNCED_ACTION = "You said what you would do next but called no tool. Use your tools for only the remaining work, or reply with verified results if nothing is left to do. Never repeat an operation that succeeded, was denied, or may already have taken effect; inspect its state instead. Do not retry a destructive operation.";

export function announcesAction(text: string): boolean {
  const reply = text.trim();
  if (!reply || reply.length > 4_000 || reply.includes("?")) return false;
  if (reply.length > 400) {
    const tail = reply.split(/\n\s*\n/).at(-1)!.trim();
    return tail.length <= 400 && /^(?:let me|i['\u2019]ll|i will|i(?:['\u2019]m| am) going to)\s+(?:now\s+)?(?:execute|send|type|press|launch|open|check|inspect|read|fetch|run|create|write|verify)\b/i.test(tail);
  }
  return /(?:[:\u2014\u2013]|\.\.\.|\u2026)$/.test(reply) ||
    /^(?:checking|let me(?! know\b)|i'll|i will|i'm going to|i am going to|opening|pulling|looking|searching|navigating|reading|fetching|loading|now (?:i'll|let me|opening|checking|pulling|reading))\b/i.test(reply) ||
    /^i(?:['\u2019]m| am)\b[^.!?\n]*\band (?:i )?will\s+(?:launch|open|check|pull|look|search|navigate|read|fetch|load|run|inspect)\b/i.test(reply);
}
