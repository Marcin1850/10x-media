import { CRITERIA, type ReviewOutput, type Severity } from "./schema.js";

/** Lowest score that still passes (inclusive). */
export const PASS_MIN_SCORE = 6;

/** A finding of one of these severities fails the review whatever the scores say. */
export const BLOCKING_SEVERITIES: readonly Severity[] = ["critical", "major"];

export type ReviewResult = "passed" | "failed";

export interface Decision {
  result: ReviewResult;
  /** Human-readable causes of a `failed` result; empty when passed. */
  reasons: string[];
}

/**
 * The single place a schema-valid review becomes the PR outcome. `failed` iff any criterion scores below
 * `PASS_MIN_SCORE` or any finding has a blocking severity — the minimum decides, never the mean, and severity
 * counts regardless of the criterion it is filed under.
 */
export function decideResult(output: ReviewOutput): Decision {
  const reasons: string[] = [];

  for (const criterion of CRITERIA) {
    const { score } = output.scores[criterion];
    if (score < PASS_MIN_SCORE) reasons.push(`${criterion} scored ${score} (minimum ${PASS_MIN_SCORE})`);
  }

  for (const finding of output.findings) {
    if (BLOCKING_SEVERITIES.includes(finding.severity)) {
      reasons.push(`${finding.severity} finding (${finding.criterion}): ${finding.title}`);
    }
  }

  return { result: reasons.length > 0 ? "failed" : "passed", reasons };
}
