import { describe, it, expect } from "vitest";
import { isIntelligenceEnabled } from "./feature-flag.ts";

describe("isIntelligenceEnabled", () => {
  it("returns true when flag set", () => {
    expect(isIntelligenceEnabled({ intelligenceLayer: true } as any)).toBe(true);
  });
  it("returns false by default", () => {
    expect(isIntelligenceEnabled({} as any)).toBe(false);
  });
});
