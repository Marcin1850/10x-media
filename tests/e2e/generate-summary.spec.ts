import { E2E_FAKE_MODEL_SLUG, fakeCharacterLine, fakeSummaryText, transcriptFingerprint } from "@/test/e2e/fake-llm";
import { copy } from "@/lib/copy";
import { E2E_YOUTUBE_IDS } from "./fixtures/registry";
import { awaitIslandsHydrated } from "./fixtures/hydration";
import { readBalance, readReservations, readSummaries, readSupadataCalls } from "./fixtures/ledger";
import { gateRequest } from "./fixtures/request-gate";
import { expect, test } from "./fixtures/test";

/**
 * **The seed spec** — test-plan risk #6, the happy flow: generate → see the summary.
 *
 * The rules this file embodies, and the cookbook for adding another spec, live in
 * `context/foundation/test-plan.md` §6.4 — read it first.
 *
 * It has two jobs. The first is coverage: prove that a summary the user paid for reaches the card,
 * and that the card's claim matches what the request actually did. The second is that it is the
 * EXEMPLAR — `/10x-e2e` models Phases 3 and 4 on this file, so *what you show is what you get*. Every
 * locator here is `getByRole`/`getByLabel`; every wait is a wait for state. One `waitForTimeout` in
 * this file would propagate to every spec generated after it.
 *
 * **The oracle is two-sided, and that is the whole point.** Risk #6 is a card that misreports paid
 * work, which is precisely the property a UI refactor keeps self-consistent while breaking the truth.
 * So each assertion below has a partner in `fixtures/ledger.ts` reading Postgres directly, through a
 * table-owner connection with the application entirely out of the loop.
 *
 * **No vendor is contacted.** Both Supadata lookups are seeded cache hits (`fixtures/seed-cache.ts`)
 * and OpenRouter is swapped for `src/test/e2e/fake-llm.ts` by the `E2E_FAKE_LLM` alias that
 * `playwright.config.ts` sets on the app server. The spec asserts that rather than assuming it.
 */

/** Comfortably under `LONG_TRANSCRIPT_CHARS` (40,000, README §Summary credits), so this video costs 1 credit. */
const SHORT_TRANSCRIPT = "Transkrypt testowy dla scenariusza e2e. ".repeat(20);

const VIDEO_TITLE = "Testowy film e2e";

test("a generated summary reaches the card, and the card matches what was charged and saved", async ({
  page,
  account,
  seedVideo,
}) => {
  const video = await seedVideo.seed(E2E_YOUTUBE_IDS.seedHappyPath, {
    content: SHORT_TRANSCRIPT,
    title: VIDEO_TITLE,
  });

  // The delta is the oracle, so the "before" is read from the database rather than assumed to be the
  // trigger's 5 — this stays true if the grant ever changes.
  const balanceBefore = await readBalance(account.userId);
  if (balanceBefore === null)
    throw new Error("e2e: the synthetic account has no user_credits row to read a balance from.");

  await page.goto("/summaries");
  await expect(page.getByRole("heading", { name: copy.summaries.page.heading })).toBeVisible();
  // Before touching the capture bar, never after — see `awaitIslandsHydrated` for what typing into an
  // unhydrated island does to it, and why no retry recovers.
  await awaitIslandsHydrated(page);

  // `educational` deliberately, not the form's `informational` default: the fake summarizer writes the
  // character it was called with into the summary body, so asserting it below proves the user's radio
  // choice actually reached the LLM call rather than being dropped somewhere in between.
  const submit = page.getByRole("button", { name: copy.generate.submit });
  await page.getByLabel(copy.generate.urlLabel).fill(video.url);
  // The button leaves its disabled state only through the island's own `urlIsValid`, so this is the
  // app confirming it received the URL — not merely that the DOM node holds the text.
  await expect(submit).toBeEnabled();

  const characters = page.getByRole("radiogroup", { name: copy.generate.characterLabel });
  // Clicked by its visible label, which is what a user clicks: the radio itself is `sr-only` under a
  // custom-styled `<label>`, so the label is the hit target and `.check()` on the input would have to
  // force past it. The state is then asserted on the input, where it actually lives.
  await characters.getByText(copy.summaries.character.educational, { exact: true }).click();
  await expect(characters.getByRole("radio", { name: copy.summaries.character.educational })).toBeChecked();

  // The pending card is a TRANSIENT state, and the fake summarizer resolves immediately — the whole
  // round-trip lands in a few hundred milliseconds. A retrying assertion cannot recover a state that
  // has already passed, so the request is held open while the assertion runs (impl-review F6). The gate
  // delays; it never answers. After `release()` the real endpoint serves the real response, so every
  // assertion below is about an ordinary, ungated generation.
  const generateGate = await gateRequest(page, "**/api/summaries/generate");

  await submit.click();

  await generateGate.waitUntilRequested();

  // Wait for STATE, never for time: the in-flight card's own live region, then the saved card that
  // replaces it. `toBeVisible` retries until the condition holds, so a slower machine waits longer
  // rather than failing.
  const pendingCard = page.getByRole("article").filter({ hasText: video.url });
  await expect(pendingCard.getByRole("status")).toContainText(copy.generate.status.generating);

  await generateGate.release();

  // The saved card replaces the pending one only once the list re-read can prove the row is there
  // (`DashboardSummaries.refreshSummaries`), so waiting for it waits for the whole flow to settle.
  const savedCard = page.getByRole("article").filter({ hasText: VIDEO_TITLE });
  await expect(savedCard.getByRole("heading", { name: VIDEO_TITLE })).toBeVisible();

  // --- The card's claim -----------------------------------------------------------------------
  // The body is collapsed by default — expand it and assert the summary the user can actually read.
  // The fingerprint is an 8-hex function of the seeded transcript, computed here by calling the SAME
  // function the app's response came from. It is the one token that distinguishes this video's
  // summary from any other, so a card rendering the wrong body fails here; a fixed lorem string would
  // have passed against exactly that bug.
  await savedCard
    .getByRole("button", { name: `${copy.summaries.card.expand} ${copy.summaries.card.summaryOf(VIDEO_TITLE)}` })
    .click();
  await expect(savedCard).toContainText(transcriptFingerprint(video.transcript));
  // ...and the character, which the fingerprint CANNOT prove: it is a function of the transcript alone,
  // so a card rendering an `informational` body for this same video would satisfy the line above while
  // Postgres held the correct `educational` row — a card-versus-saved mismatch (risk #6) that passed
  // every assertion here until impl-review F3. `fakeCharacterLine` is the same function the app's
  // response was built from, so this cannot drift into asserting a stale literal.
  await expect(savedCard).toContainText(fakeCharacterLine("educational"));

  // The header balance updates in place on the `credits:changed` event (Phase 0 item 7) — no reload.
  // Waited FOR, not read once: reading a server-rendered value immediately after an action asserts
  // what the page held BEFORE it, which is a green assertion against a real regression.
  await expect(page.getByRole("banner").getByLabel(copy.nav.credits)).toHaveText(String(balanceBefore - 1));

  // --- What the request actually did ----------------------------------------------------------
  // Everything above could be true of a card that is merely self-consistent. These read Postgres.
  await expect(readBalance(account.userId)).resolves.toBe(balanceBefore - 1);

  const reservations = await readReservations(account.userId);
  expect(reservations).toEqual([expect.objectContaining({ amount: 1, status: "settled" })]);

  const summaries = await readSummaries(account.userId);
  expect(summaries).toHaveLength(1);
  expect(summaries[0]).toMatchObject({
    youtubeId: video.youtubeId,
    character: "educational",
    model: E2E_FAKE_MODEL_SLUG,
    // The saved body is a function of the transcript we seeded AND the character we picked. This is
    // what ties the card, the charge and the stored row to one another rather than to three
    // independently plausible values.
    content: fakeSummaryText({ transcript: video.transcript, character: "educational" }),
  });
  // The settled reservation is the one this summary was paid for — not some other row that happens to
  // be settled.
  expect(summaries[0].reservationId).toBe(reservations[0].id);

  // No paid fetch happened. A row here would mean a cache seed missed and Supadata was really called.
  await expect(readSupadataCalls([video.youtubeId])).resolves.toEqual([]);

  // --- The browser reporting seam, walked ------------------------------------------------------
  // `[unsupported-feature]` is the one event family emitted from a hydrated island, so the BROWSER
  // transport is the only thing that carries it — and until this click nothing in the suite walked
  // it, which made the `sentryIngestGuard` fixture's zero-attempt verdict true for the boring reason
  // that no browser event was ever emitted. Clicking makes the zero mean something.
  //
  // The assertion here is that the user-facing behaviour is UNCHANGED by Phase 3: the same Polish
  // notice, in place. The other half — that emitting it sent nothing — is asserted for every test in
  // the suite by the guard fixture at teardown (`fixtures/no-sentry.ts`).
  await page.getByRole("banner").getByRole("button", { name: copy.nav.account }).click();
  await page.getByRole("menuitem", { name: copy.nav.topUp }).click();
  await expect(page.getByRole("status").filter({ hasText: copy.nav.topUpNotice })).toBeVisible();
});
