// server/intelligence/verifier.test.ts
import { describe, it, expect, vi } from "vitest";
import { Verifier } from "./verifier.ts";

describe("Verifier", () => {
  it("verifies step against success criteria", async () => {
    const mockModel = vi.fn().mockResolvedValue(JSON.stringify({ verified: true, evidence: "File exists", confidence: 0.95 }));
    const verifier = new Verifier(mockModel);
    const result = await verifier.verify({ id: "s1", description: "Create file", type: "tool", expectedTools: ["write"], dependencies: [], successCriteria: "File exists", result: "file created" });
    expect(result.verified).toBe(true);
    expect(result.confidence).toBeGreaterThan(0.9);
  });

  it("fails verification when criteria not met", async () => {
    const mockModel = vi.fn().mockResolvedValue(JSON.stringify({ verified: false, evidence: "File missing", confidence: 0.1 }));
    const verifier = new Verifier(mockModel);
    const result = await verifier.verify({ id: "s1", description: "Create file", type: "tool", expectedTools: ["write"], dependencies: [], successCriteria: "File exists", result: "error" });
    expect(result.verified).toBe(false);
  });

  it("handles model failure gracefully", async () => {
    const mockModel = vi.fn().mockRejectedValue(new Error("model down"));
    const verifier = new Verifier(mockModel);
    const result = await verifier.verify({ id: "s1", description: "step", type: "tool", expectedTools: [], dependencies: [], successCriteria: "done", result: "ok" });
    expect(result.verified).toBe(false);
    expect(result.confidence).toBe(0);
  });
});