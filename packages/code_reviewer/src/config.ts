export type Config =
  | {
      ok: true;
      diffPath: string;
      model: string | undefined;
      outDir: string;
      maxTurns: number;
      maxBudgetUsd: number | undefined;
    }
  | { ok: false; message: string };

const OUT_DIR = "output";

/** A tool-less review is one model turn plus structured-output retries; 3 was fully used on a 15-line fixture. */
export const DEFAULT_MAX_TURNS = 5;

/**
 * Validates the CLI input before anything costs money. Pure: reads nothing from disk or `process`;
 * the CLI checks that the diff file exists and is non-empty.
 *
 * @param argv the arguments after the script name (`process.argv.slice(2)`)
 */
export function loadConfig(argv: string[], env: Record<string, string | undefined>): Config {
  const diffPath = argv[0]?.trim();
  if (!diffPath) {
    return { ok: false, message: "Missing diff file argument. Usage: npm run review -- <path-to-diff-file>" };
  }

  if (!env.ANTHROPIC_API_KEY?.trim()) {
    return {
      ok: false,
      message: "ANTHROPIC_API_KEY is not set. Copy .env.example to .env and fill it in. No API call was made.",
    };
  }

  // An invalid limit is a config error, never silently defaulted: a typo must not lift a spend cap.
  const turnsRaw = env.REVIEW_MAX_TURNS?.trim();
  const maxTurns = turnsRaw ? Number(turnsRaw) : DEFAULT_MAX_TURNS;
  if (!Number.isInteger(maxTurns) || maxTurns < 1) {
    return { ok: false, message: `REVIEW_MAX_TURNS must be a positive integer, got "${turnsRaw}".` };
  }

  const budgetRaw = env.REVIEW_MAX_BUDGET_USD?.trim();
  const maxBudgetUsd = budgetRaw ? Number(budgetRaw) : undefined;
  if (maxBudgetUsd !== undefined && !(Number.isFinite(maxBudgetUsd) && maxBudgetUsd > 0)) {
    return { ok: false, message: `REVIEW_MAX_BUDGET_USD must be a positive number, got "${budgetRaw}".` };
  }

  const model = env.REVIEW_MODEL?.trim() || undefined;
  return { ok: true, diffPath, model, outDir: OUT_DIR, maxTurns, maxBudgetUsd };
}
