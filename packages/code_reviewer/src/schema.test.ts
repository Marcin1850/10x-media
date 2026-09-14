import { describe, expect, it } from "vitest";
import { z } from "zod";

import { ReviewOutput, reviewOutputJsonSchema } from "./schema.js";

const finding = {
  file: "src/range.ts",
  line: 12,
  severity: "major",
  title: "Off-by-one upper bound",
  explanation: "The loop includes the end index.",
  failureScenario: "range(0, 3) returns [0, 1, 2, 3] instead of [0, 1, 2]",
};

const withSeverity = (severity: string) => ({ ...finding, severity });

describe("ReviewOutput", () => {
  it.each([
    ["an approve with no findings", { verdict: "approve", summary: "Looks correct.", findings: [] }],
    [
      "a finding without a line number",
      { verdict: "request_changes", summary: "One issue.", findings: [{ ...finding, line: undefined }] },
    ],
    [
      "a comment with only minor and nit findings",
      { verdict: "comment", summary: "Small things.", findings: [withSeverity("minor"), withSeverity("nit")] },
    ],
    [
      "request_changes when one critical finding sits among nits",
      { verdict: "request_changes", summary: "Blocker.", findings: [withSeverity("nit"), withSeverity("critical")] },
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

  // Oracle: SYSTEM_PROMPT — "request_changes" if any finding is critical or major, "comment" if only minor
  // or nit findings, "approve" if none.
  it.each([
    ["approve with a critical finding", "approve", [withSeverity("critical")]],
    ["comment with a major finding", "comment", [withSeverity("major")]],
    ["request_changes with only a minor finding", "request_changes", [withSeverity("minor")]],
    ["comment with no findings", "comment", []],
    ["request_changes with no findings", "request_changes", []],
  ])("rejects a contradictory verdict: %s", (_label, verdict, findings) => {
    const parsed = ReviewOutput.safeParse({ verdict, summary: "…", findings });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.path)).toEqual([["verdict"]]);
  });
});

describe("reviewOutputJsonSchema", () => {
  it("is an object schema that requires verdict and findings", () => {
    expect(reviewOutputJsonSchema.type).toBe("object");
    expect(reviewOutputJsonSchema.required).toEqual(expect.arrayContaining(["verdict", "findings"]));
  });

  it("is unchanged by the verdict refinement (the SDK receives plain Draft-07)", () => {
    expect(reviewOutputJsonSchema).toEqual(z.toJSONSchema(ReviewOutput, { target: "draft-7" }));
  });
});
