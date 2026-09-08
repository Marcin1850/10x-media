import { describe, expect, it } from "vitest";
import { messageForError } from "@/components/hooks/useGenerateSummary";
import { copy } from "@/lib/copy";

/**
 * What the user is actually told when a generation fails.
 *
 * Oracle: `copy.errors.codes` in `src/lib/copy/pl.ts` (which states the code contract and the
 * fallback rule) and the codes the generate endpoint emits — `REFUSAL_CODE` plus the literals on the
 * transient 422 and the two 402s. Read from those, never from the switch below them: a test that
 * re-derived the mapping the way the function does would pass against a mapping that lost a case.
 *
 * Only the pure mapper is covered here. The hook itself is a React hook and this repo has no DOM
 * test environment (no jsdom, no testing-library — `package.json`), which is exactly why the
 * localisation contract was extracted into a function that needs neither. What reaches the wire is
 * the integration suite's job (`generate.int.test.ts`); what the wire means is this file's.
 *
 * **Mutation check** (`npx stryker run --mutate "src/components/hooks/useGenerateSummary.ts:118-128"`,
 * 2026-09-08): 9 mutants, 8 killed, 1 survived. No assertion was added to raise the number.
 *
 * Ignored, with the reason:
 *
 * 1. **`if (typeof code === "string")` emptied to `if (true)`** (`:119`). The guard is a type
 *    narrowing, not a behavioural branch: without it `byCode[undefined]` looks up the key
 *    `"undefined"` and `byCode[42]` the key `"42"`, both miss, and the function falls through to
 *    `messageForStatus` exactly as before — so no input a client can send observes a difference.
 *    Killing it would need a `code` whose `toString()` returns a real code name, which is inventing an
 *    unreachable input; `credits.test.ts` rules that out of scope for the same reason. The guard earns
 *    its place as the thing that makes the `undefined` miss below legible to the compiler, not as a
 *    branch anything downstream can distinguish.
 */

describe("messageForError — a code, when there is one, decides the copy", () => {
  // The headline. Before codes existed the client preferred the server's English sentence over its
  // own Polish table, because the table had one entry per STATUS and 422 has three causes. A row
  // that only checked "returns something" would have passed then too, so this pins the actual swap:
  // the English string is present AND ignored.
  it("prefers the Polish code copy over the server's English string", () => {
    const message = messageForError(422, "This video has no captions, so there is nothing to summarize.", "noCaptions");

    expect(message).toBe(copy.errors.codes.noCaptions);
  });

  // The distinction the code mechanism exists to preserve, and the one a per-status table cannot
  // express. These two 422s ship the SAME English `error` from the endpoint, but one is permanent and
  // charged while the other is our outage, free, and worth retrying — so the Polish must differ.
  // Asserted as two positive identities plus their inequality: "not the other one" alone would stay
  // green if both collapsed onto a third string.
  it("keeps the two 422s that share an English string apart in Polish", () => {
    const durable = messageForError(422, "Transcript unavailable for this video", "transcriptUnavailable");
    const transient = messageForError(422, "Transcript unavailable for this video", "transcriptFetchFailed");

    expect(durable).toBe(copy.errors.codes.transcriptUnavailable);
    expect(transient).toBe(copy.errors.codes.transcriptFetchFailed);
    expect(durable).not.toBe(transient);
  });

  // Each row is a different way the code can fail to resolve, and each must land on the per-status
  // message rather than on the raw code, an empty string, or a crash. The endpoint is deployed
  // separately from the client, so "a code the client has never heard of" is a real state, not a
  // hypothetical — a new cause shipped server-side reaches users before its translation does.
  const unresolved: [string, string, unknown][] = [
    [
      "a code the copy table does not know",
      "a server-side cause that shipped ahead of its translation",
      "vendorOnFire",
    ],
    ["no code at all", "an older endpoint build, or a body that is not this endpoint's", undefined],
    ["a non-string code", "a malformed or truncated JSON body", 42],
  ];

  it.each(unresolved)("falls back to the per-status message given %s: %s", (_label, _why, code) => {
    // 413 is chosen deliberately: its entry ignores `serverError` entirely, so the assertion cannot
    // accidentally pass by echoing the English string back.
    expect(messageForError(413, "This video's transcript is too long to summarize.", code)).toBe(copy.errors.tooLong);
  });

  // The last-resort rule, stated on its own because it looks like a bug until you know why it holds:
  // on a multi-cause status with no code, a SPECIFIC English sentence still beats a Polish one that
  // may name the wrong cause. Every cause that has a code has already been answered above; this is
  // what is left over.
  it("still prefers the server's string over a generic Polish one when nothing else identifies the cause", () => {
    const serverError = "Too many transcript requests. Please wait a moment and try again.";

    expect(messageForError(429, serverError, undefined)).toBe(serverError);
    expect(messageForError(429, undefined, undefined)).toBe(copy.errors.alreadyGenerating);
  });
});
