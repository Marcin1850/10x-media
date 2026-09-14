export type InputCheck = { ok: true } | { ok: false; message: string };

/**
 * Largest diff the CLI will send. ~50k tokens: well past a normal PR diff, well short of a context-limit
 * failure — anything bigger is far more likely a mistaken path than a review someone meant to pay for.
 */
export const MAX_DIFF_BYTES = 200_000;

const FILE_HEADERS = /^--- .+\r?\n\+\+\+ .+$/m;
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m;

/** Checked on `stat`, before the file is read: an oversized or non-regular path is refused without loading it. */
export function checkDiffFile(stats: { isFile: boolean; size: number }): InputCheck {
  if (!stats.isFile) return { ok: false, message: "Diff path is not a regular file." };
  if (stats.size === 0) return { ok: false, message: "Diff file is empty." };
  if (stats.size > MAX_DIFF_BYTES) {
    return { ok: false, message: `Diff file is ${stats.size} bytes; the limit is ${MAX_DIFF_BYTES}.` };
  }
  return { ok: true };
}

/**
 * Minimal unified-diff shape check: a `---`/`+++` header pair and at least one hunk. Its main job is refusing
 * a path that isn't a diff at all (`.env`, a config file) before its contents reach the API. It cannot tell
 * whether a valid diff itself contains secrets.
 */
export function checkDiffText(text: string): InputCheck {
  if (!text.trim()) return { ok: false, message: "Diff file is empty." };
  if (!FILE_HEADERS.test(text)) {
    return { ok: false, message: "File is not a unified diff (no `---`/`+++` file headers)." };
  }
  if (!HUNK_HEADER.test(text)) {
    return {
      ok: false,
      message: "Diff has no text hunks to review (binary, rename-only or mode-only changes are not supported).",
    };
  }
  return { ok: true };
}
