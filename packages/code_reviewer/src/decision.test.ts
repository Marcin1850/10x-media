import { describe, expect, it } from "vitest";

import { decideResult } from "./decision.js";
import type { Finding } from "./schema.js";
import { finding, reviewOutput, scoresOf } from "./test-fixtures.js";

// Oracle: requirements.md / plan.md Desired End State — passed iff every score ≥ 6 and no critical/major finding;
// failed iff any score < 6 or any critical/major finding. Rows are written from that text, not from decision.ts.
const withSeverity = (severity: Finding["severity"], criterion: Finding["criterion"] = "correctness"): Finding => ({
  ...finding,
  severity,
  criterion,
});

describe("decideResult", () => {
  it.each([
    ["all 6s with no findings (threshold is inclusive)", [6, 6, 6, 6, 6], [], "passed"],
    ["one 4 among 9s (minimum decides, not the mean)", [9, 9, 9, 9, 4], [], "failed"],
    [
      "all 7s with one major finding (severity is independent of scores)",
      [7, 7, 7, 7, 7],
      [withSeverity("major")],
      "failed",
    ],
    [
      "all 10s with only minor and nit findings",
      [10, 10, 10, 10, 10],
      [withSeverity("minor"), withSeverity("nit")],
      "passed",
    ],
    [
      "all 10s with one critical idiomaticity finding (severity is independent of criterion)",
      [10, 10, 10, 10, 10],
      [withSeverity("critical", "idiomaticity")],
      "failed",
    ],
  ] as const)("%s → %s", (_label, scores, findings, expected) => {
    const decision = decideResult(reviewOutput({ scores: scoresOf([...scores]), findings: [...findings] }));
    expect(decision.result).toBe(expected);
  });

  it("names nothing when the review passes", () => {
    expect(decideResult(reviewOutput({ findings: [] })).reasons).toEqual([]);
  });

  it("names each failing criterion and each blocking finding title", () => {
    const decision = decideResult(
      reviewOutput({
        scores: scoresOf([7, 3, 7, 7, 5]),
        findings: [{ ...withSeverity("critical"), title: "Service key in client bundle" }, withSeverity("nit")],
      }),
    );
    expect(decision.reasons).toHaveLength(3);
    expect(decision.reasons.join("\n")).toMatch(/security.*3/);
    expect(decision.reasons.join("\n")).toMatch(/maintainability.*5/);
    expect(decision.reasons.join("\n")).toContain("Service key in client bundle");
  });
});
