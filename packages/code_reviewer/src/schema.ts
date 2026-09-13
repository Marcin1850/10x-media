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

export const ReviewOutput = z.object({
  verdict: z.enum(["approve", "request_changes", "comment"]),
  summary: z.string(),
  findings: z.array(Finding),
});

export type Finding = z.infer<typeof Finding>;
export type ReviewOutput = z.infer<typeof ReviewOutput>;

/** Draft-07 is the target the Agent SDK's `outputFormat` expects (docs/structured-outputs.md). */
export const reviewOutputJsonSchema: Record<string, unknown> = z.toJSONSchema(ReviewOutput, {
  target: "draft-7",
});
