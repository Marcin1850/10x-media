import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { copy } from "@/lib/copy";

/**
 * The one failure mode the cause-code mechanism invites, guarded at the only place that can see both
 * halves of it.
 *
 * A `code` on a response body is a contract between two files that nothing links at the type level:
 * the endpoint states the code as a string literal, and `copy.errors.codes` translates it. Add an
 * exit server-side and forget the translation and **nothing breaks** — no type error, no failing
 * request, no log line. The exit simply falls back to its per-status message, which is generic where
 * the code was specific, and in the worst case (a 422) says "no transcript" about a video that has
 * one. That degradation is deliberate as a runtime safety net; it is not something to ship.
 *
 * So this reads the endpoint's source and asserts every literal it emits has somewhere to land.
 * Reading source is unusual here and worth justifying: the codes are inline at ~20 `return` sites
 * inside a module that imports `astro:env/server`, so the unit project cannot import them, and an
 * exported constant listing them would be a second copy of the same fact — a mirror the test would
 * then verify against itself.
 *
 * Oracle: `REFUSAL_CODE`'s doc contract in `generate.ts` ("Codes are a contract with
 * `copy.errors.codes` … add the translation in the same change as the code") and `copy.errors.codes`'
 * own header. The direction is one-way on purpose — see the second test.
 */

const ENDPOINT = "src/pages/api/summaries/generate.ts";

/** Every `code: "…"` literal the endpoint emits, including the `REFUSAL_CODE` table's values. */
function codesEmittedBy(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const found = new Set<string>();
  for (const match of source.matchAll(/\bcode:\s*"([A-Za-z0-9_]+)"/g)) found.add(match[1]);
  // `REFUSAL_CODE`'s values are the codes for the refusal exits; they reach the body through
  // `REFUSAL_CODE[reason]` rather than as a literal beside `code:`, so the regex above cannot see them.
  for (const match of source.matchAll(/^\s*(?:unavailable|empty|whitespace):\s*"([A-Za-z0-9_]+)",$/gm)) {
    found.add(match[1]);
  }
  return [...found].sort();
}

describe("error cause codes — the endpoint and the copy table agree", () => {
  // Guards against the regex silently matching nothing: were `codesEmittedBy` to break, the
  // every-code-has-copy assertion below would pass vacuously over an empty list and this file would
  // protect exactly nothing while staying green.
  it("finds the codes at all, including the refusal table's", () => {
    const emitted = codesEmittedBy(ENDPOINT);

    expect(emitted.length).toBeGreaterThan(10);
    expect(emitted).toContain("noCaptions"); // from REFUSAL_CODE, not a `code:` literal
    expect(emitted).toContain("transcriptFetchFailed"); // a literal at a `return`
  });

  it("every code the endpoint sends has Polish copy", () => {
    const translated = Object.keys(copy.errors.codes);

    const untranslated = codesEmittedBy(ENDPOINT).filter((code) => !translated.includes(code));

    expect(untranslated).toEqual([]);
  });

  // The reverse is NOT asserted, and the omission is the point. A translation with no sender is
  // harmless dead copy; a sender with no translation is a user reading the wrong sentence. Pinning
  // both directions would also make the table impossible to prepare ahead of an endpoint change,
  // which is the sequence the contract actually recommends.
  it("does not require the reverse — an unused translation is dead copy, not a defect", () => {
    const emitted = codesEmittedBy(ENDPOINT);

    expect(Object.keys(copy.errors.codes).length).toBeGreaterThanOrEqual(emitted.length);
  });
});
