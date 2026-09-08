import type { ChannelCharacter } from "@/types";

/**
 * Deterministic stand-in for `@/lib/services/llm`, swapped in by the `E2E_FAKE_LLM` alias in
 * `astro.config.mjs`. It exists because OpenRouter is the one vendor checkpoint the e2e layer cannot
 * defeat with data: the transcript and metadata lookups sit behind caches a test can pre-seed, but
 * `generate.ts` calls `summarize()` unconditionally, and both `astro dev` and `astro preview` run on
 * workerd — so no Node-level interception (`nock`, `http` patching) is physically available.
 *
 * **Safety property**: this module is reachable only through the alias, and the alias only exists when
 * `E2E_FAKE_LLM` is set in the environment that loads `astro.config.mjs`. A production build never sets
 * it, so the module is not bundled and a deployed Worker cannot contain it. That is verified against
 * `dist/` by grepping for `E2E_FAKE_SUMMARIZER`, never by reading the config.
 *
 * A runtime flag was rejected: it would serve canned summaries while charging real credits if it were
 * ever set in production. The precedent is `e0fdb0d`, which reverted a test-convenience `service_role`
 * widening that had already shipped.
 *
 * It must import nothing from `@/lib/services/llm` — under the alias that specifier resolves back to
 * this file. The result shape is therefore restated here rather than imported, and
 * `src/test/e2e/fake-llm.test.ts` pins it against the real module's so the two cannot drift.
 */

/**
 * The greppable identifier Phase 1's build-output check searches for, and the reason it is a single
 * unusual token rather than a word like "fake": `dist/` must be searchable for it with no false hits.
 * It is embedded in the summary text so it reaches both the bundle and the rendered card.
 */
export const E2E_FAKE_SUMMARIZER = "E2E_FAKE_SUMMARIZER";

/** Not a real OpenRouter slug, so a row written by the fake is identifiable in `summaries.model`. */
export const E2E_FAKE_MODEL_SLUG = "e2e-fake/summarizer";

/**
 * FNV-1a over the transcript, as 8 hex chars. The point is that the summary text is a function of the
 * *input*: a spec asserting the card shows `fakeSummaryText(seededTranscript, character)` fails if the
 * card renders some other video's summary. A fixed lorem string would pass against exactly that bug.
 *
 * Exported so a spec can name the one token that distinguishes THIS video's summary from any other,
 * by calling the same function the app's own response came from rather than restating the hash.
 */
export function transcriptFingerprint(transcript: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < transcript.length; index += 1) {
    hash ^= transcript.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * The exact text the fake returns. Exported so a spec computes its expectation from the same function
 * the app's response came from, instead of duplicating the format as a string literal that drifts.
 *
 * Polish, and shaped like a real summary (Markdown, a lead sentence, bullets), so it exercises the
 * card's `react-markdown` rendering rather than a degenerate one-line string.
 */
/**
 * The ONE fragment of the fake's body that depends on the channel character, in exactly the form the
 * card renders it (no Markdown emphasis, so the string a spec asserts is the string in the DOM).
 *
 * It is exported, and `fakeSummaryText` below builds its line from it, because a spec has to be able
 * to prove the user's radio choice reached the LLM call. Asserting only `transcriptFingerprint` cannot:
 * the fingerprint is a function of the transcript alone, so a card rendering an `informational` body
 * for the same video passes it (impl-review F3). Two sources for one string would drift, hence one
 * function used by both sides.
 */
export function fakeCharacterLine(character: ChannelCharacter): string {
  return `Charakter kanału: ${character}`;
}

export function fakeSummaryText({
  transcript,
  character,
}: {
  transcript: string;
  character: ChannelCharacter;
}): string {
  return [
    `Podsumowanie wygenerowane przez atrapę (${E2E_FAKE_SUMMARIZER}) na potrzeby testów e2e.`,
    "",
    // NOT bolded, unlike the two lines below: this one is asserted verbatim against the card's rendered
    // text, and `**` would be consumed by react-markdown. The other two keep their emphasis, so the
    // body still exercises the card's Markdown rendering rather than degenerating into plain text.
    `- ${fakeCharacterLine(character)}`,
    `- Odcisk transkryptu: **${transcriptFingerprint(transcript)}**`,
    `- Długość transkryptu: **${transcript.length}** znaków`,
  ].join("\n");
}

/**
 * Mirrors `summarize` from `@/lib/services/llm` — same parameters, same resolved shape. The API key is
 * accepted and ignored: the signature has to match the real module's, and the whole point is that no
 * network call is made with it.
 *
 * The cost and token figures are small non-zero literals so the telemetry columns (`summaries.cost_usd`,
 * `prompt_tokens`, `completion_tokens`) receive plausible values instead of nulls — a null there is a
 * distinct, meaningful state in the real module ("usage accounting did not arrive") that an e2e run
 * must not manufacture.
 */
export function summarize(
  input: { transcript: string; character: ChannelCharacter },
  _apiKey: string,
): Promise<{
  text: string;
  model: string;
  costUsd: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
}> {
  return Promise.resolve({
    text: fakeSummaryText(input),
    model: E2E_FAKE_MODEL_SLUG,
    costUsd: 0.0004,
    promptTokens: 1234,
    completionTokens: 321,
  });
}
