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
 * **Mutation check** (`npx stryker run --mutate "src/components/hooks/useGenerateSummary.ts:124-134"`,
 * 2026-09-08): 9 mutants, 8 killed, 1 survived. No assertion was added to raise the number.
 *
 * Ignored, with the reason:
 *
 * 1. **`if (typeof code === "string")` emptied to `if (true)`** (`:125`). The guard is a type
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
  it("picks the cause's copy, not the one sentence its status would otherwise get", () => {
    const message = messageForError(422, "noCaptions");

    expect(message).toBe(copy.errors.codes.noCaptions);
    // The status entry is what a code-less 422 lands on, so "not that" is what proves the code was
    // read rather than the switch below it.
    expect(message).not.toBe(copy.errors.noTranscript);
  });

  // The distinction the code mechanism exists to preserve, and the one a per-status table cannot
  // express. These two 422s ship the SAME English `error` from the endpoint, but one is permanent and
  // charged while the other is our outage, free, and worth retrying — so the Polish must differ.
  // Asserted as two positive identities plus their inequality: "not the other one" alone would stay
  // green if both collapsed onto a third string.
  it("keeps the two 422s that share an English string apart in Polish", () => {
    const durable = messageForError(422, "transcriptUnavailable");
    const transient = messageForError(422, "transcriptFetchFailed");

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
    expect(messageForError(413, code)).toBe(copy.errors.tooLong);
  });

  // The MULTI-CAUSE statuses, which are where an unresolved code is actually reachable and where the
  // fallback used to leak: each of these once returned the endpoint's English sentence in preference
  // to its Polish entry, so a cause deployed ahead of its translation reached the user in the wrong
  // language. 413/401/502 above cannot catch that — they have one cause and never had the English
  // branch. Each row is a status with its own branch in the switch, so a single re-added
  // `serverError ??` fails here rather than passing on a status that never had one.
  const multiCause: [number, string][] = [
    [400, copy.errors.checkUrl],
    [422, copy.errors.noTranscript],
    [429, copy.errors.alreadyGenerating],
    [500, copy.errors.generic],
    [503, copy.errors.notConfigured],
    [418, copy.errors.generic], // the `default` arm — a status this client has never been taught
  ];

  it.each(multiCause)("answers a code-less %d in Polish", (status, expected) => {
    expect(messageForError(status, undefined)).toBe(expected);
  });
});
