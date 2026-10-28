import { describe, expect, it } from "vitest";

import { classifyTask, classifyTaskType, taskTypeToTier, complexityToTier } from "./task-classifier.ts";

describe("task-classifier", () => {
  it("classifies complexity", () => {
    expect(classifyTask({ text: "hi" })).toBe("trivial");
    expect(classifyTask({ text: "Design a distributed system with concurrent processing and security audit", toolCount: 5 })).not.toBe("trivial");
  });

  it("maps complexity to tier", () => {
    expect(complexityToTier("trivial")).toBe("cheap");
    expect(complexityToTier("expert")).toBe("premium");
  });

  it("classifies task type - coding", () => {
    expect(classifyTaskType("Implement a function to sort an array")).toBe("coding");
    expect(classifyTaskType("Fix the bug in the login module")).toBe("coding");
  });

  it("classifies task type - reasoning", () => {
    expect(classifyTaskType("Why does this algorithm work? Explain the logic")).toBe("reasoning");
  });

  it("classifies task type - creative", () => {
    expect(classifyTaskType("Write a story about a robot")).toBe("creative");
  });

  it("classifies task type - analysis", () => {
    expect(classifyTaskType("Analyze the performance metrics and compare")).toBe("analysis");
  });

  it("classifies task type - research", () => {
    expect(classifyTaskType("Research the latest AI trends")).toBe("research");
  });

  it("defaults to conversation for generic text", () => {
    expect(classifyTaskType("Hello there")).toBe("conversation");
  });

  it("maps task type to tier", () => {
    expect(taskTypeToTier("conversation")).toBe("cheap");
    expect(taskTypeToTier("coding")).toBe("premium");
    expect(taskTypeToTier("reasoning")).toBe("premium");
  });
});