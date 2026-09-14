import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";

import { loadConfig } from "./config.js";
import { decideResult } from "./decision.js";
import { checkDiffFile, checkDiffText } from "./diff-input.js";
import { verifyLockdown } from "./lockdown.js";
import { runReview } from "./review.js";

const EXIT_OK = 0;
const EXIT_CONFIG = 1;
const EXIT_AGENT = 2;

async function readDiff(path: string): Promise<string | { error: string }> {
  try {
    const stats = await stat(path);
    const fileCheck = checkDiffFile({ isFile: stats.isFile(), size: stats.size });
    if (!fileCheck.ok) return { error: `${fileCheck.message} (${path})` };

    const diff = await readFile(path, "utf8");
    const textCheck = checkDiffText(diff);
    return textCheck.ok ? diff : { error: `${textCheck.message} (${path})` };
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
  const run = await runReview({
    diff,
    title: "",
    body: "",
    model: config.model,
    maxTurns: config.maxTurns,
    maxBudgetUsd: config.maxBudgetUsd,
  });

  const lockdown = verifyLockdown(run);
  if (lockdown.ok) {
    console.log(`Session model: ${lockdown.init.model}`);
    console.log(`Session tools: ${JSON.stringify(lockdown.init.initTools)}`);
  } else {
    console.error(`[lockdown] ${lockdown.reason}`);
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

  // A schema-valid review from an unverified session is not reported or saved: the lockdown is part of the contract.
  if (!lockdown.ok) {
    console.error("[agent] Refusing to report a review whose session lockdown was not verified.");
    return EXIT_AGENT;
  }

  const report = {
    ...run.output,
    ...decideResult(run.output),
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
