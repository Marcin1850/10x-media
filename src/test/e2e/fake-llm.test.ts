import { describe, expect, it } from "vitest";
import { summarize as realSummarize } from "@/lib/services/llm";
import { E2E_FAKE_SUMMARIZER, fakeSummaryText, summarize as fakeSummarize } from "@/test/e2e/fake-llm";

/**
 * Oracle: plan Phase 1 §4 — the fake "exports `summarize` with the same signature and return shape as
 * `src/lib/services/llm.ts`". The fake cannot import that shape (under the `E2E_FAKE_LLM` alias the
 * specifier resolves back to the fake itself), so it restates it — and a restated contract drifts.
 *
 * The assignability pair below is the actual guard, and it is checked by `npm run typecheck`, not by
 * running this file: if `SummarizeResult` gains, loses or retypes a field, one of the two directions
 * stops compiling. The runtime cases cover the one property no type can express — that the text is a
 * function of the input, which is what lets a spec tell the fake's summary for THIS video apart from
 * the fake's summary for any other.
 *
 * Vitest never loads `astro.config.mjs`, so `@/lib/services/llm` here is always the real module.
 */
type FakeSatisfiesReal = typeof realSummarize extends typeof fakeSummarize ? true : never;
type RealSatisfiesFake = typeof fakeSummarize extends typeof realSummarize ? true : never;
const shapesMatch: [FakeSatisfiesReal, RealSatisfiesFake] = [true, true];

describe("fake-llm", () => {
  it("keeps the fake structurally identical to the real `summarize` (the assertion is the annotation)", () => {
    // This body is trivially true on purpose. The real check happened at compile time: if either
    // direction of assignability fails, its type becomes `never`, `[true, true]` stops being assignable,
    // and `npm run typecheck` fails before this ever runs. Asserting it here is what keeps the binding
    // read, so the guard cannot be deleted as dead code by a future tidy-up.
    expect(shapesMatch).toStrictEqual([true, true]);
  });

  it("derives the summary text from the transcript, so a card showing another video's summary fails", () => {
    const character = "informational" as const;

    const first = fakeSummaryText({ transcript: "pierwsza transkrypcja", character });
    const second = fakeSummaryText({ transcript: "druga transkrypcja", character });

    expect(first).not.toBe(second);
  });

  it("derives the summary text from the character, so a card showing the wrong prompt's output fails", () => {
    const transcript = "ta sama transkrypcja";

    const informational = fakeSummaryText({ transcript, character: "informational" });
    const educational = fakeSummaryText({ transcript, character: "educational" });

    expect(informational).not.toBe(educational);
  });

  it("carries the marker the build-output safety check greps `dist/` for", () => {
    expect(fakeSummaryText({ transcript: "cokolwiek", character: "informational" })).toContain(E2E_FAKE_SUMMARIZER);
  });

  it("resolves the same text the exported formatter produces, without a network call", async () => {
    const input = { transcript: "transkrypcja testowa", character: "educational" as const };

    const result = await fakeSummarize(input, "unused-api-key");

    expect(result.text).toBe(fakeSummaryText(input));
    expect(result.costUsd).toBeGreaterThan(0);
    expect(result.promptTokens).toBeGreaterThan(0);
    expect(result.completionTokens).toBeGreaterThan(0);
  });
});
