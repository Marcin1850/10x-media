export type Config =
  | { ok: true; diffPath: string; model: string | undefined; outDir: string }
  | { ok: false; message: string };

const OUT_DIR = "output";

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

  const model = env.REVIEW_MODEL?.trim() || undefined;
  return { ok: true, diffPath, model, outDir: OUT_DIR };
}
