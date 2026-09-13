import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";

import { loadConfig } from "./config.js";
import { EXPECTED_SESSION_TOOLS, runReview } from "./review.js";

const EXIT_OK = 0;
const EXIT_CONFIG = 1;
const EXIT_AGENT = 2;

async function readDiff(path: string): Promise<string | { error: string }> {
  try {
    const diff = await readFile(path, "utf8");
    return diff.trim() ? diff : { error: `Diff file is empty: ${path}` };
  } catch (error) {
    return { error: `Cannot read diff file ${path}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function main(): Promise<number> {
  const config = loadConfig(process.argv.slice(2), process.env);
  if (!config.ok) {
    console.error(`[config] ${config.message}`);
    return EXIT_CONFIG;
  }

  const diff = await readDiff(config.diffPath);
  if (typeof diff !== "string") {
    console.error(`[input] ${diff.error} No API call was made.`);
    return EXIT_CONFIG;
  }

  console.log(`Reviewing ${config.diffPath}${config.model ? ` with model override ${config.model}` : ""}…`);
  const run = await runReview({ diff, model: config.model });

  if (run.initTools === undefined) {
    console.warn("⚠ [lockdown] No init message received — the session's tool list could not be verified.");
  } else {
    console.log(`Session model: ${run.model}`);
    console.log(`Session tools: ${JSON.stringify(run.initTools)}`);
    const unexpected = run.initTools.filter((tool) => !EXPECTED_SESSION_TOOLS.includes(tool));
    if (unexpected.length > 0) {
      console.warn(
        `⚠ [lockdown] Expected only ${EXPECTED_SESSION_TOOLS.join(", ")}, but the session also exposed: ${unexpected.join(", ")}`,
      );
    }
  }

  if (run.kind === "no-result") {
    console.error("[agent] The run ended without a result message:", run.error);
    return EXIT_AGENT;
  }

  console.log(`Cost: $${run.meta.costUsd.toFixed(4)} · ${run.meta.durationMs} ms · ${run.meta.numTurns} turn(s)`);

  if (run.kind === "agent-error") {
    console.error(
      `[agent] Run failed: subtype=${run.subtype}, terminal_reason=${run.terminalReason ?? "n/a"}`,
      run.errors.length > 0 ? run.errors : "",
    );
    return EXIT_AGENT;
  }

  if (run.kind === "invalid-output") {
    console.error("[agent] Structured output did not match the schema:", JSON.stringify(run.issues, null, 2));
    return EXIT_AGENT;
  }

  const report = {
    ...run.output,
    meta: {
      model: run.model ?? null,
      costUsd: run.meta.costUsd,
      durationMs: run.meta.durationMs,
      sessionId: run.meta.sessionId,
      numTurns: run.meta.numTurns,
      tools: run.initTools ?? null,
    },
  };
  const json = JSON.stringify(report, null, 2);
  console.log(json);

  await mkdir(config.outDir, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(":", "-");
  const outPath = join(config.outDir, `${stamp}-${basename(config.diffPath, extname(config.diffPath))}.json`);
  await writeFile(outPath, `${json}\n`, "utf8");
  console.log(`Saved report to ${outPath}`);

  return EXIT_OK;
}

// Every config/input failure returns EXIT_CONFIG before the SDK call, so anything that escapes happened after it.
process.exitCode = await main().catch((error: unknown) => {
  console.error("[agent] Unexpected failure:", error);
  return EXIT_AGENT;
});
