import { describe, expect, it } from "vitest";

import type { Decision } from "./decision.js";
import {
  MAX_COMMENT_CHARS,
  type RenderableReport,
  renderError,
  renderReview,
  renderSkipped,
  STICKY_MARKER,
} from "./render.js";
import type { Finding } from "./schema.js";
import { finding, reviewOutput, scoresOf } from "./test-fixtures.js";

// Oracle: plan.md Phase 2 §2 — marker on line 1, severity order critical → nit, cap at 60,000 keeping the
// score table and footer, table cells escaped. Written from that contract, not from render.ts.
const meta = { model: "claude-sonnet-5", costUsd: 0.1234, numTurns: 2 };
const failed: Decision = { result: "failed", reasons: ["major finding (correctness): Off-by-one upper bound"] };
const passed: Decision = { result: "passed", reasons: [] };

const report = (overrides: Partial<RenderableReport> = {}): RenderableReport => ({
  ...reviewOutput(),
  meta,
  ...overrides,
});

const titled = (severity: Finding["severity"], title: string): Finding => ({ ...finding, severity, title });

describe("sticky marker", () => {
  it.each([
    ["renderReview", renderReview(report(), failed)],
    ["renderSkipped", renderSkipped("Diff file is empty.")],
    ["renderError", renderError("ANTHROPIC_API_KEY is not set.")],
  ])("is the first line of %s", (_name, markdown) => {
    expect(markdown.split("\n")[0]).toBe(STICKY_MARKER);
  });
});

describe("renderReview", () => {
  it("shows the result, the failure reasons, every criterion score and the footer", () => {
    const markdown = renderReview(report(), failed, { reviewedSha: "abc1234" });
    expect(markdown).toMatch(/failed/);
    expect(markdown).toContain("Off-by-one upper bound");
    expect(markdown).toMatch(/\| 7\/10 \|/);
    expect(markdown.match(/\| \d+\/10 \|/g)).toHaveLength(5);
    for (const text of ["claude-sonnet-5", "$0.1234", "2 turn(s)", "abc1234", "not a merge gate", "ai-cr:review"]) {
      expect(markdown).toContain(text);
    }
  });

  it("does not list failure reasons on a pass", () => {
    const markdown = renderReview(report({ findings: [] }), passed);
    expect(markdown).toMatch(/passed/);
    expect(markdown).not.toMatch(/Why it failed/);
  });

  it("orders findings critical → major → minor → nit whatever order the model used", () => {
    const markdown = renderReview(
      report({
        findings: [
          titled("nit", "NIT-ONE"),
          titled("minor", "MINOR-ONE"),
          titled("critical", "CRIT-ONE"),
          titled("major", "MAJOR-ONE"),
        ],
      }),
      failed,
    );
    const positions = ["CRIT-ONE", "MAJOR-ONE", "MINOR-ONE", "NIT-ONE"].map((title) => markdown.indexOf(title));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("keeps a rationale containing | and a newline inside one table row", () => {
    const scores = scoresOf([7, 7, 7, 7, 7]);
    scores.security = { score: 4, rationale: "Reads a | b\nthen leaks" };
    const row = renderReview(report({ scores }), failed)
      .split("\n")
      .find((line) => line.includes("4/10"));
    expect(row).toBeDefined();
    expect(row).toContain("then leaks");
    // Unescaped pipes delimit cells: a well-formed row has exactly four.
    expect(row?.replaceAll("\\|", "").match(/\|/g)).toHaveLength(4);
  });

  it("caps an oversize comment by dropping the lowest severities first, keeping table and footer", () => {
    const padding = "x".repeat(2_000);
    const findings = [
      ...Array.from({ length: 20 }, (_, i) => titled("nit", `NIT-${i} ${padding}`)),
      ...Array.from({ length: 20 }, (_, i) => titled("minor", `MINOR-${i} ${padding}`)),
      ...Array.from({ length: 3 }, (_, i) => titled("critical", `CRIT-${i} ${padding}`)),
    ];
    const markdown = renderReview(report({ findings }), failed, { reviewedSha: "abc1234" });

    expect(markdown.length).toBeLessThanOrEqual(MAX_COMMENT_CHARS);
    expect(markdown.split("\n")[0]).toBe(STICKY_MARKER);
    expect(markdown.match(/\| \d+\/10 \|/g)).toHaveLength(5);
    expect(markdown).toContain("not a merge gate");
    expect(markdown).toContain("abc1234");
    expect(markdown).toMatch(/\d+ finding\(s\) omitted/);
    for (let i = 0; i < 3; i++) expect(markdown).toContain(`CRIT-${i}`);
    // ~90k of findings needs ~15 dropped: all from the nits, so every minor survives and some nits do not.
    for (let i = 0; i < 20; i++) expect(markdown).toContain(`MINOR-${i} `);
    expect(markdown).not.toContain("NIT-19 ");
  });

  it("leaves a comment under the cap untouched", () => {
    expect(renderReview(report(), failed)).not.toMatch(/omitted/);
  });
});

describe("renderSkipped / renderError", () => {
  it.each([
    ["renderSkipped", renderSkipped("Diff file is empty."), /skipped/, "Diff file is empty."],
    ["renderError", renderError("Budget cap reached."), /error/, "Budget cap reached."],
  ])("%s carries a heading, the reason and the retry hint", (_name, markdown, heading, reason) => {
    expect(markdown).toMatch(heading);
    expect(markdown).toContain(reason);
    expect(markdown).toContain("ai-cr:review");
  });
});
