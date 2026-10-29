import { describe, it, expect } from "vitest";
import { classifyTask } from "./task-classifier.ts";

describe("classifyTask (Pivot style)", () => {
  it("classifies coding tasks", () => {
    expect(classifyTask("Write a REST API endpoint for user registration")).toBe("coding");
    expect(classifyTask("Implement a binary search function in Python")).toBe("coding");
  });
  it("classifies research tasks", () => {
    expect(classifyTask("Find out what competitors are doing in pricing")).toBe("research");
    expect(classifyTask("Research best practices for authentication")).toBe("research");
  });
  it("classifies debugging tasks", () => {
    expect(classifyTask("Fix the null pointer exception in login handler")).toBe("debugging");
    expect(classifyTask("Debug why tests are failing on CI")).toBe("debugging");
  });
  it("classifies analysis tasks", () => {
    expect(classifyTask("Analyze the performance bottleneck in the query")).toBe("analysis");
    expect(classifyTask("Review this code for security issues")).toBe("analysis");
  });
  it("classifies writing tasks", () => {
    expect(classifyTask("Write documentation for the API")).toBe("writing");
    expect(classifyTask("Draft a blog post about our product")).toBe("writing");
  });
  it("defaults to general for ambiguous briefs", () => {
    expect(classifyTask("Hello")).toBe("general");
    expect(classifyTask("Do something")).toBe("general");
  });
});
