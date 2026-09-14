import { z } from "zod";

/** The five review criteria, in the order they are presented to the model and rendered in the comment. */
export const CRITERIA = ["correctness", "security", "idiomaticity", "testCoverage", "maintainability"] as const;
export const Criterion = z.enum(CRITERIA);

export const SEVERITIES = ["critical", "major", "minor", "nit"] as const;

/**
 * The report shape the model must return. Single source of truth: the JSON Schema sent to the SDK
 * (`reviewOutputJsonSchema`) and the TypeScript types are both derived from it.
 */
export const Finding = z.object({
  file: z.string(),
  line: z.int().optional(),
  severity: z.enum(SEVERITIES),
  criterion: Criterion,
  title: z.string(),
  explanation: z.string(),
  failureScenario: z.string(),
});

/** Bounds live in the JSON Schema (`minimum`/`maximum`), so the SDK's structured-output retry enforces them. */
export const CriterionScore = z.object({
  score: z.int().min(1).max(10),
  rationale: z.string(),
});

/**
 * No `verdict`: the pass/fail result is computed by `decideResult` (decision.ts), never chosen by the model,
 * so a model that contradicts itself cannot produce invalid output or a wrong label. Every rule the model must
 * satisfy is expressible in JSON Schema — deliberately no zod refinements, which the SDK does not retry.
 */
export const ReviewOutput = z.object({
  summary: z.string(),
  scores: z.object({
    correctness: CriterionScore,
    security: CriterionScore,
    idiomaticity: CriterionScore,
    testCoverage: CriterionScore,
    maintainability: CriterionScore,
  }),
  findings: z.array(Finding),
});

export type Criterion = z.infer<typeof Criterion>;
export type Severity = (typeof SEVERITIES)[number];
export type Finding = z.infer<typeof Finding>;
export type CriterionScore = z.infer<typeof CriterionScore>;
export type ReviewOutput = z.infer<typeof ReviewOutput>;

/** Draft-07 is the target the Agent SDK's `outputFormat` expects (docs/structured-outputs.md). */
export const reviewOutputJsonSchema: Record<string, unknown> = z.toJSONSchema(ReviewOutput, {
  target: "draft-7",
});
