import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { checkDiffFile, checkDiffText, MAX_DIFF_BYTES } from "./diff-input.js";

// Oracle: README — the input is a unified diff (e.g. `git diff > my.diff`) and every input refusal happens
// before an API call. Samples below follow git's documented output, not the regexes in diff-input.ts.
const plantedBug = readFileSync(new URL("../fixtures/planted-bug.diff", import.meta.url), "utf8");

const modifiedFileDiff = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -3 +3 @@ export const x = 1;",
  "-const y = 2;",
  "+const y = 3;",
  "",
].join("\r\n");

describe("checkDiffFile", () => {
  it.each([
    ["a regular file at the cap", { isFile: true, size: MAX_DIFF_BYTES }],
    ["a small regular file", { isFile: true, size: 512 }],
  ])("accepts %s", (_label, stats) => {
    expect(checkDiffFile(stats)).toEqual({ ok: true });
  });

  it.each([
    ["a directory", { isFile: false, size: 4096 }, /not a regular file/],
    ["an empty file", { isFile: true, size: 0 }, /empty/],
    ["a file one byte over the cap", { isFile: true, size: MAX_DIFF_BYTES + 1 }, /limit/],
  ])("refuses %s", (_label, stats, message) => {
    const check = checkDiffFile(stats);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.message).toMatch(message);
  });
});

describe("checkDiffText", () => {
  it.each([
    ["the planted-bug fixture (new file, --- /dev/null)", plantedBug],
    ["a modified-file diff with CRLF line endings and a single-line hunk", modifiedFileDiff],
  ])("accepts %s", (_label, text) => {
    expect(checkDiffText(text)).toEqual({ ok: true });
  });

  it.each([
    ["whitespace only", "  \n\t\n", /empty/],
    ["a dotenv file", "ANTHROPIC_API_KEY=sk-ant-secret\nREVIEW_MODEL=claude-opus-5\n", /not a unified diff/],
    [
      "a binary-only diff",
      "diff --git a/logo.png b/logo.png\nindex 1..2 100644\nBinary files a/logo.png and b/logo.png differ\n",
      /not a unified diff/,
    ],
    [
      "file headers with no hunk",
      "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n",
      /no text hunks/,
    ],
  ])("refuses %s", (_label, text, message) => {
    const check = checkDiffText(text);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.message).toMatch(message);
  });
});
