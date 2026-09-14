import type { Criterion, Finding, ReviewOutput } from "./schema.js";

/** Test-only builders for schema-valid review data. Hand-written from the schema contract, not from any consumer. */
export const finding: Finding = {
  file: "src/range.ts",
  line: 12,
  severity: "major",
  criterion: "correctness",
  title: "Off-by-one upper bound",
  explanation: "The loop includes the end index.",
  failureScenario: "range(0, 3) returns [0, 1, 2, 3] instead of [0, 1, 2]",
};

export function scoresOf(values: [number, number, number, number, number]): ReviewOutput["scores"] {
  const [correctness, security, idiomaticity, testCoverage, maintainability] = values;
  const entry = (criterion: Criterion, score: number) => ({ score, rationale: `${criterion} rated ${score}.` });
  return {
    correctness: entry("correctness", correctness),
    security: entry("security", security),
    idiomaticity: entry("idiomaticity", idiomaticity),
    testCoverage: entry("testCoverage", testCoverage),
    maintainability: entry("maintainability", maintainability),
  };
}

export function reviewOutput(overrides: Partial<ReviewOutput> = {}): ReviewOutput {
  return { summary: "One bug.", scores: scoresOf([7, 7, 7, 7, 7]), findings: [finding], ...overrides };
}
