import { describe, it, expect } from "vitest";
import { extractJson } from "./extract-json.ts";

describe("extractJson", () => {
  it("parses plain JSON", () => {
    expect(extractJson('{"a": 1}')).toEqual({ a: 1 });
  });

  it("parses JSON inside markdown code fence", () => {
    expect(extractJson("```json\n{\"a\": 1}\n```")).toEqual({ a: 1 });
  });

  it("extracts first JSON object from text", () => {
    expect(extractJson("prefix {\"a\": 1} suffix")).toEqual({ a: 1 });
  });

  it("throws on invalid JSON", () => {
    expect(() => extractJson("not json")).toThrow();
  });
});
