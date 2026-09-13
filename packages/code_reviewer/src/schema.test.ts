import { describe, expect, it } from "vitest";

import { ReviewOutput, reviewOutputJsonSchema } from "./schema.js";

const finding = {
  file: "src/range.ts",
  line: 12,
  severity: "major",
  title: "Off-by-one upper bound",
  explanation: "The loop includes the end index.",
  failureScenario: "range(0, 3) returns [0, 1, 2, 3] instead of [0, 1, 2]",
};

describe("ReviewOutput", () => {
  it.each([
    ["an approve with no findings", { verdict: "approve", summary: "Looks correct.", findings: [] }],
    [
      "a finding without a line number",
      { verdict: "comment", summary: "One issue.", findings: [{ ...finding, line: undefined }] },
    ],
  ])("accepts %s", (_label, report) => {
    expect(ReviewOutput.safeParse(report).success).toBe(true);
  });

  it.each([
    ["an unknown severity", { ...finding, severity: "blocker" }],
    ["a finding missing failureScenario", { ...finding, failureScenario: undefined }],
    ["a non-integer line", { ...finding, line: 12.5 }],
  ])("rejects %s", (_label, badFinding) => {
    const report = { verdict: "request_changes", summary: "Issue.", findings: [badFinding] };
    expect(ReviewOutput.safeParse(report).success).toBe(false);
  });
});

describe("reviewOutputJsonSchema", () => {
  it("is an object schema that requires verdict and findings", () => {
    expect(reviewOutputJsonSchema.type).toBe("object");
    expect(reviewOutputJsonSchema.required).toEqual(expect.arrayContaining(["verdict", "findings"]));
  });
});
