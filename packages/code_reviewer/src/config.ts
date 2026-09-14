import { parseArgs } from "node:util";

export type Config =
  | {
      ok: true;
      diffPath: string;
      /** PR title; `""` for a local run without `--title`. */
      title: string;
      bodyPath: string | undefined;
      /** Without `--report`, the CLI writes a timestamped file under `outDir`. */
      reportPath: string | undefined;
      markdownPath: string | undefined;
      /** Head commit the diff was taken from; shown in the comment footer. */
      reviewedSha: string | undefined;
      model: string | undefined;
      outDir: string;
      maxTurns: number;
      maxBudgetUsd: number | undefined;
    }
  | { ok: false; message: string; markdownPath?: string };

const OUT_DIR = "output";

export const USAGE =
  "Usage: npm run review -- <diff-path> [--title <text>] [--body-file <path>] [--report <path>] [--markdown <path>] [--reviewed-sha <sha>]";

/** A tool-less review is one model turn plus structured-output retries; 3 was fully used on a 15-line fixture. */
export const DEFAULT_MAX_TURNS = 5;

/**
 * Validates the CLI input before anything costs money. Pure: reads nothing from disk or `process`;
 * the CLI checks that the diff and body files exist and reads them.
 *
 * Large or untrusted text (the PR description) arrives by path, never through argv. A failure still carries
 * `markdownPath` when it was parsed, so the CLI can leave an error comment for the workflow to publish.
 *
 * @param argv the arguments after the script name (`process.argv.slice(2)`)
 */
export function loadConfig(argv: string[], env: Record<string, string | undefined>): Config {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: true,
      options: {
        title: { type: "string" },
        "body-file": { type: "string" },
        report: { type: "string" },
        markdown: { type: "string" },
        "reviewed-sha": { type: "string" },
      },
    });
  } catch (error) {
    return { ok: false, message: `${error instanceof Error ? error.message : String(error)}. ${USAGE}` };
  }

  const { values, positionals } = parsed;
  const markdownPath = values.markdown?.trim() || undefined;
  const fail = (message: string): Config => ({ ok: false, message, ...(markdownPath ? { markdownPath } : {}) });

  const diffPath = positionals[0]?.trim();
  if (!diffPath) return fail(`Missing diff file argument. ${USAGE}`);
  if (positionals.length > 1) return fail(`Expected one diff file argument, got ${positionals.length}. ${USAGE}`);

  if (!env.ANTHROPIC_API_KEY?.trim()) {
    return fail("ANTHROPIC_API_KEY is not set. Copy .env.example to .env and fill it in. No API call was made.");
  }

  // An invalid limit is a config error, never silently defaulted: a typo must not lift a spend cap.
  const turnsRaw = env.REVIEW_MAX_TURNS?.trim();
  const maxTurns = turnsRaw ? Number(turnsRaw) : DEFAULT_MAX_TURNS;
  if (!Number.isInteger(maxTurns) || maxTurns < 1) {
    return fail(`REVIEW_MAX_TURNS must be a positive integer, got "${turnsRaw}".`);
  }

  const budgetRaw = env.REVIEW_MAX_BUDGET_USD?.trim();
  const maxBudgetUsd = budgetRaw ? Number(budgetRaw) : undefined;
  if (maxBudgetUsd !== undefined && !(Number.isFinite(maxBudgetUsd) && maxBudgetUsd > 0)) {
    return fail(`REVIEW_MAX_BUDGET_USD must be a positive number, got "${budgetRaw}".`);
  }

  return {
    ok: true,
    diffPath,
    title: values.title ?? "",
    bodyPath: values["body-file"]?.trim() || undefined,
    reportPath: values.report?.trim() || undefined,
    markdownPath,
    reviewedSha: values["reviewed-sha"]?.trim() || undefined,
    model: env.REVIEW_MODEL?.trim() || undefined,
    outDir: OUT_DIR,
    maxTurns,
    maxBudgetUsd,
  };
}
