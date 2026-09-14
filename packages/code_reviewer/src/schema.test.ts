import { describe, expect, it } from "vitest";

import { CRITERIA, ReviewOutput, reviewOutputJsonSchema } from "./schema.js";
import { finding, reviewOutput, scoresOf } from "./test-fixtures.js";

// Oracle: plan.md Phase 1 §1 — five required criteria, integer scores 1..10, criterion-tagged findings, no verdict.
describe("ReviewOutput", () => {
  it.each([
    ["a review with no findings", reviewOutput({ findings: [] })],
    ["a finding without a line number", reviewOutput({ findings: [{ ...finding, line: undefined }] })],
    ["the score bounds themselves (1 and 10)", reviewOutput({ scores: scoresOf([1, 10, 1, 10, 5]) })],
  ])("accepts %s", (_label, report) => {
    expect(ReviewOutput.safeParse(report).success).toBe(true);
  });

  it.each([
    ["a score of 0", { ...reviewOutput(), scores: scoresOf([0, 7, 7, 7, 7]) }],
    ["a score of 11", { ...reviewOutput(), scores: scoresOf([7, 7, 7, 7, 11]) }],
    ["a non-integer score", { ...reviewOutput(), scores: scoresOf([7, 5.5, 7, 7, 7]) }],
    [
      "a missing criterion key",
      { ...reviewOutput(), scores: (({ security: _dropped, ...rest }) => rest)(scoresOf([7, 7, 7, 7, 7])) },
    ],
    ["a finding without criterion", { ...reviewOutput(), findings: [{ ...finding, criterion: undefined }] }],
    ["a finding with an unknown criterion", { ...reviewOutput(), findings: [{ ...finding, criterion: "style" }] }],
    ["an unknown severity", { ...reviewOutput(), findings: [{ ...finding, severity: "blocker" }] }],
    [
      "a finding missing failureScenario",
      { ...reviewOutput(), findings: [{ ...finding, failureScenario: undefined }] },
    ],
    ["a non-integer line", { ...reviewOutput(), findings: [{ ...finding, line: 12.5 }] }],
  ])("rejects %s", (_label, report) => {
    expect(ReviewOutput.safeParse(report).success).toBe(false);
  });
});

describe("reviewOutputJsonSchema", () => {
  type ObjectSchema = { required?: string[]; properties: Record<string, unknown> };
  const root = reviewOutputJsonSchema as unknown as ObjectSchema;
  const scores = root.properties.scores as ObjectSchema;

  it("requires summary, scores and findings, and has no verdict", () => {
    expect(root.required).toEqual(expect.arrayContaining(["summary", "scores", "findings"]));
    expect(root.properties).not.toHaveProperty("verdict");
  });

  it("requires all five criteria", () => {
    expect([...(scores.required ?? [])].sort()).toEqual([...CRITERIA].sort());
  });

  it.each(CRITERIA)("carries integer bounds 1..10 for %s, so the SDK retry enforces them", (criterion) => {
    const score = (scores.properties[criterion] as ObjectSchema).properties.score;
    expect(score).toMatchObject({ type: "integer", minimum: 1, maximum: 10 });
  });
});
