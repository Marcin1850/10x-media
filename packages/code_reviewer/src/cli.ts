/**
 * CLI entry point. Exit codes are the contract with the composite action (.github/actions/ai-code-review):
 *
 * - 0 `EXIT_OK`      review completed; the report's `result` says `passed` or `failed`
 * - 1 `EXIT_CONFIG`  configuration error (flags, API key, limits, unreadable file) — no API call was made
 * - 2 `EXIT_AGENT`   agent error, invalid output, unverified lockdown, budget or turn cap hit
 * - 3 `EXIT_SKIPPED` nothing reviewable (empty, oversize, not a diff, no hunks) — no API call was made
 *
 * stdout carries only the report JSON on exit 0; every progress and diagnostic line goes to stderr.
 */
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";

import { loadConfig } from "./config.js";
import { decideResult } from "./decision.js";
import { checkDiffFile, checkDiffText } from "./diff-input.js";
import { verifyLockdown } from "./lockdown.js";
import { renderError, renderReview, renderSkipped } from "./render.js";
import { runReview } from "./review.js";

const EXIT_OK = 0;
const EXIT_CONFIG = 1;
const EXIT_AGENT = 2;
const EXIT_SKIPPED = 3;

/** Known once flags are parsed; lets the last-resort handler still leave an error comment. */
let markdownPath: string | undefined;

type DiffRead =
  | { ok: true; diff: string }
  | { ok: false; exit: typeof EXIT_CONFIG | typeof EXIT_SKIPPED; message: string };

async function readDiff(path: string): Promise<DiffRead> {
  let stats;
  try {
    stats = await stat(path);
  } catch (error) {
    // A missing path is a wiring mistake, not an empty PR: it must never read as "skipped".
    return { ok: false, exit: EXIT_CONFIG, message: `Cannot read diff file ${path}: ${errorText(error)}` };
  }
  const fileCheck = checkDiffFile({ isFile: stats.isFile(), size: stats.size });
  if (!fileCheck.ok) return { ok: false, exit: EXIT_SKIPPED, message: fileCheck.message };

  const diff = await readFile(path, "utf8");
  const textCheck = checkDiffText(diff);
  return textCheck.ok ? { ok: true, diff } : { ok: false, exit: EXIT_SKIPPED, message: textCheck.message };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Best effort: a failure to write the comment body is logged and never replaces the original exit code. */
async function writeMarkdown(content: string): Promise<void> {
  if (!markdownPath) return;
  try {
    await mkdir(dirname(markdownPath), { recursive: true });
    await writeFile(markdownPath, `${content}\n`, "utf8");
  } catch (error) {
    console.error(`[output] Could not write markdown to ${markdownPath}: ${errorText(error)}`);
  }
}

async function fail(exit: number, tag: string, message: string, commentReason = message): Promise<number> {
  console.error(`[${tag}] ${message}`);
  await writeMarkdown(exit === EXIT_SKIPPED ? renderSkipped(commentReason) : renderError(commentReason));
  return exit;
}

async function main(): Promise<number> {
  const config = loadConfig(process.argv.slice(2), process.env);
  markdownPath = config.markdownPath;
  if (!config.ok) return fail(EXIT_CONFIG, "config", config.message);

  const read = await readDiff(config.diffPath);
  if (!read.ok) {
    return fail(read.exit, "input", `${read.message} No API call was made.`);
  }

  let body = "";
  if (config.bodyPath) {
    try {
      body = await readFile(config.bodyPath, "utf8");
    } catch (error) {
      return fail(
        EXIT_CONFIG,
        "config",
        `Cannot read body file ${config.bodyPath}: ${errorText(error)}. No API call was made.`,
      );
    }
  }

  console.error(`Reviewing ${config.diffPath}${config.model ? ` with model override ${config.model}` : ""}…`);
  const run = await runReview({
    diff: read.diff,
    title: config.title,
    body,
    model: config.model,
    maxTurns: config.maxTurns,
    maxBudgetUsd: config.maxBudgetUsd,
  });

  const lockdown = verifyLockdown(run);
  if (lockdown.ok) {
    console.error(`Session model: ${lockdown.init.model}`);
    console.error(`Session tools: ${JSON.stringify(lockdown.init.initTools)}`);
  } else {
    console.error(`[lockdown] ${lockdown.reason}`);
  }

  if (run.kind === "no-result") {
    return fail(
      EXIT_AGENT,
      "agent",
      `The run ended without a result message: ${errorText(run.error)}`,
      "The review run ended without a result.",
    );
  }

  console.error(`Cost: $${run.meta.costUsd.toFixed(4)} · ${run.meta.durationMs} ms · ${run.meta.numTurns} turn(s)`);
  const spent = `(cost $${run.meta.costUsd.toFixed(4)}, ${run.meta.numTurns} turn(s))`;

  if (run.kind === "agent-error") {
    const errors = run.errors.length > 0 ? ` ${JSON.stringify(run.errors)}` : "";
    return fail(
      EXIT_AGENT,
      "agent",
      `Run failed: subtype=${run.subtype}, terminal_reason=${run.terminalReason ?? "n/a"}${errors}`,
      // The SDK's error strings stay in the job log; the comment names only the documented subtype.
      `The review run failed: \`${run.subtype}\` ${spent}.`,
    );
  }

  if (run.kind === "invalid-output") {
    return fail(
      EXIT_AGENT,
      "agent",
      `Structured output did not match the schema: ${JSON.stringify(run.issues, null, 2)}`,
      `The model's output did not match the review schema ${spent}.`,
    );
  }

  // A schema-valid review from an unverified session is not reported or saved: the lockdown is part of the contract.
  if (!lockdown.ok) {
    return fail(
      EXIT_AGENT,
      "agent",
      "Refusing to report a review whose session lockdown was not verified.",
      `The review session's tool lockdown could not be verified, so its output was discarded ${spent}.`,
    );
  }

  const decision = decideResult(run.output);
  const report = {
    ...run.output,
    ...decision,
    meta: {
      model: lockdown.init.model,
      costUsd: run.meta.costUsd,
      durationMs: run.meta.durationMs,
      sessionId: run.meta.sessionId,
      numTurns: run.meta.numTurns,
      tools: lockdown.init.initTools,
    },
  };
  const json = JSON.stringify(report, null, 2);
  process.stdout.write(`${json}\n`);

  const stamp = new Date().toISOString().replaceAll(":", "-");
  const reportPath =
    config.reportPath ?? join(config.outDir, `${stamp}-${basename(config.diffPath, extname(config.diffPath))}.json`);
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${json}\n`, "utf8");
  console.error(`Saved report to ${reportPath}`);

  await writeMarkdown(renderReview(report, decision, { reviewedSha: config.reviewedSha }));
  return EXIT_OK;
}

// Every config/input failure returns before the SDK call, so anything that escapes happened after it.
process.exitCode = await main().catch(async (error: unknown) =>
  fail(
    EXIT_AGENT,
    "agent",
    `Unexpected failure: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    "The review failed unexpectedly; see the workflow log.",
  ),
);
