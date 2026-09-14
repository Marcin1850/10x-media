import type { Decision } from "./decision.js";
import { CRITERIA, type Criterion, type Finding, type ReviewOutput, SEVERITIES } from "./schema.js";

/** First line of every comment the workflow posts; how it finds its own comment to update. */
export const STICKY_MARKER = "<!-- ai-cr:sticky -->";

/** Under GitHub's 65,536-character comment limit, with room for the workflow's outdated banner. */
export const MAX_COMMENT_CHARS = 60_000;

const RETRY_HINT = "Add the `ai-cr:review` label to re-run.";

const CRITERION_LABELS: Record<Criterion, string> = {
  correctness: "Implementation correctness",
  security: "Security and safety",
  idiomaticity: "Idiomaticity",
  testCoverage: "Test/risk coverage",
  maintainability: "Complexity and maintainability",
};

export interface RenderableReport extends ReviewOutput {
  meta: { model: string; costUsd: number; numTurns: number };
}

/** Model text inside a table cell: a `|` would end the cell and a newline would end the row. */
function cell(text: string): string {
  return text.replaceAll("\\", "\\\\").replaceAll("|", "\\|").replace(/\r?\n/g, " ");
}

function renderFinding(finding: Finding): string {
  const location = finding.line === undefined ? finding.file : `${finding.file}:${finding.line}`;
  return [
    `- **${finding.title}** — \`${location}\` · _${CRITERION_LABELS[finding.criterion]}_`,
    `  ${finding.explanation.replace(/\r?\n/g, "\n  ")}`,
    `  _Failure scenario:_ ${finding.failureScenario.replace(/\r?\n/g, "\n  ")}`,
  ].join("\n");
}

function renderFindings(findings: Finding[], omitted: number): string {
  if (findings.length === 0 && omitted === 0) return "### Findings\n\nNo findings.";
  const sections = SEVERITIES.flatMap((severity) => {
    const group = findings.filter((finding) => finding.severity === severity);
    if (group.length === 0) return [];
    return [`#### ${severity} (${group.length})\n\n${group.map(renderFinding).join("\n")}`];
  });
  if (omitted > 0) {
    sections.push(`_${omitted} finding(s) omitted — see the workflow run's step summary._`);
  }
  return `### Findings\n\n${sections.join("\n\n")}`;
}

/** Highest severity first; the order within one severity is the model's. */
function bySeverity(findings: Finding[]): Finding[] {
  return SEVERITIES.flatMap((severity) => findings.filter((finding) => finding.severity === severity));
}

export function renderReview(
  report: RenderableReport,
  decision: Decision,
  { reviewedSha }: { reviewedSha?: string } = {},
): string {
  const heading = decision.result === "passed" ? "## ✅ AI code review: passed" : "## ❌ AI code review: failed";
  const reasons =
    decision.result === "failed" && decision.reasons.length > 0
      ? `**Why it failed:**\n\n${decision.reasons.map((reason) => `- ${reason}`).join("\n")}`
      : undefined;
  const table = [
    "| Criterion | Score | Rationale |",
    "| --- | :-: | --- |",
    ...CRITERIA.map((criterion) => {
      const { score, rationale } = report.scores[criterion];
      return `| ${CRITERION_LABELS[criterion]} | ${score}/10 | ${cell(rationale)} |`;
    }),
  ].join("\n");
  const footer = [
    "---",
    [
      `Model \`${report.meta.model}\``,
      `cost $${report.meta.costUsd.toFixed(4)}`,
      `${report.meta.numTurns} turn(s)`,
      ...(reviewedSha ? [`reviewed \`${reviewedSha}\``] : []),
    ].join(" · "),
    "",
    `_Advisory — not a merge gate. ${RETRY_HINT}_`,
  ].join("\n");

  const head = [STICKY_MARKER, heading, ...(reasons ? [reasons] : []), report.summary, table];
  const compose = (kept: Finding[], omitted: number) => [...head, renderFindings(kept, omitted), footer].join("\n\n");

  // Drop findings from the lowest severity up until the comment fits; everything else always survives.
  const kept = bySeverity(report.findings);
  let body = compose(kept, 0);
  while (body.length > MAX_COMMENT_CHARS && kept.length > 0) {
    kept.pop();
    body = compose(kept, report.findings.length - kept.length);
  }
  return body;
}

function renderNotice(heading: string, reason: string): string {
  return [STICKY_MARKER, heading, reason.replace(/\r?\n/g, " "), `_${RETRY_HINT}_`].join("\n\n");
}

/** No reviewable diff: no API call was made. */
export function renderSkipped(reason: string): string {
  return renderNotice("## ⏭️ AI code review: skipped", reason);
}

/** The review could not be completed. Callers pass a reason they wrote, never raw env or error objects. */
export function renderError(reason: string): string {
  return renderNotice("## ⚠️ AI code review: error", reason);
}
