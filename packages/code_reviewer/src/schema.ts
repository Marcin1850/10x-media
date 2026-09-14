import { z } from "zod";

/**
 * The report shape the model must return. Single source of truth: the JSON Schema sent to the SDK
 * (`reviewOutputJsonSchema`) and the TypeScript types are both derived from it.
 */
export const Finding = z.object({
  file: z.string(),
  line: z.int().optional(),
  severity: z.enum(["critical", "major", "minor", "nit"]),
  title: z.string(),
  explanation: z.string(),
  failureScenario: z.string(),
});

const ReviewOutputShape = z.object({
  verdict: z.enum(["approve", "request_changes", "comment"]),
  summary: z.string(),
  findings: z.array(Finding),
});

export type Finding = z.infer<typeof Finding>;
export type ReviewOutput = z.infer<typeof ReviewOutputShape>;

/** The verdict rule stated in SYSTEM_PROMPT, as a function: the highest severity decides it. */
export function expectedVerdict(findings: Finding[]): ReviewOutput["verdict"] {
  if (findings.some((finding) => finding.severity === "critical" || finding.severity === "major")) {
    return "request_changes";
  }
  return findings.length > 0 ? "comment" : "approve";
}

/**
 * The shape plus the verdict/findings relationship. A verdict that contradicts its own findings is invalid
 * output, not a review: downstream automation reads `verdict`, so it must never disagree with `findings`.
 */
export const ReviewOutput = ReviewOutputShape.superRefine((report, ctx) => {
  const expected = expectedVerdict(report.findings);
  if (report.verdict !== expected) {
    ctx.addIssue({
      code: "custom",
      path: ["verdict"],
      message: `Verdict "${report.verdict}" contradicts the findings; expected "${expected}".`,
    });
  }
});

/**
 * Draft-07 is the target the Agent SDK's `outputFormat` expects (docs/structured-outputs.md). Generated from
 * the unrefined shape: the verdict rule cannot be expressed in JSON Schema and is enforced by local `safeParse`.
 */
export const reviewOutputJsonSchema: Record<string, unknown> = z.toJSONSchema(ReviewOutputShape, {
  target: "draft-7",
});
