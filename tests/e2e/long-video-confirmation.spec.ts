import { E2E_FAKE_MODEL_SLUG, fakeCharacterLine, fakeSummaryText, transcriptFingerprint } from "@/test/e2e/fake-llm";
import { copy } from "@/lib/copy";
import { E2E_YOUTUBE_IDS } from "./fixtures/registry";
import { awaitIslandsHydrated } from "./fixtures/hydration";
import { readBalance, readReservations, readSummaries, readSupadataCalls } from "./fixtures/ledger";
import { expect, test } from "./fixtures/test";

/**
 * **The long-video confirmation spec** — test-plan risk #6 on the one flow no other layer can reach.
 *
 * Rules and cookbook: `context/foundation/test-plan.md` §6.4. Exemplar: `generate-summary.spec.ts`,
 * which this file is modelled on — same two-sided oracle, same role-based locators, same waits for
 * state.
 *
 * **Why only a browser can see this flow.** The 2-credit path is not a server decision the way the
 * refusals are: the endpoint answers 409 with a price, and everything after that is CLIENT state. The
 * quote is held in the generation hook, rendered as the app's only amber card, and answered by the
 * capture bar's own submit button, relabelled `Generuj mimo to (2 kr.)`. There is no dialog and no
 * separate confirm endpoint — the integration layer can prove the 409 and the 2-credit debit, and it
 * cannot prove that the user was quoted a price and that the button they pressed spent exactly that.
 *
 * **The two cases protect different halves of one contract**, which is *consent is per video, and it
 * is priced*:
 *
 *  1. The quote is honoured — the price the amber card states is the price the ledger records, and the
 *     summary the user is charged 2 credits for is the one they asked for, with the character they
 *     picked before the quote existed.
 *  2. The quote is not transferable — editing the URL withdraws the confirmed price, so a different
 *     video cannot be generated on the previous one's consent. That is risk #6 in the shape this flow
 *     alone can reach: a card quoting video A's cost against a charge for video B.
 *
 * **What is NOT provable here, and why it is recorded rather than faked.** `GenerateSummaryForm`
 * replays `confirm.url` / `confirm.character` rather than the live form, and the plan named that freeze
 * as this phase's risk surface. Substituting the live inputs for the frozen ones is **not
 * distinguishable in a browser**: `DashboardSummaries` calls `inputsChanged()` on every URL and
 * character edit, which drops the quote outright, so in every state a user can reach the two values are
 * equal by construction. Case 2 asserts that clearing behaviour — the property that makes the freeze
 * unobservable is the same property that keeps the user safe, and it is the half that CAN go red. The
 * freeze itself stays defence in depth against a late 409, whose own staleness guard is pinned in
 * `useGenerateSummary`'s unit coverage.
 *
 * **No vendor is contacted.** Both Supadata checkpoints are seeded cache hits, and the confirmation
 * retry re-reads the transcript from the quote `generate.ts` saved when it issued the 409 — so the long
 * transcript is paid for exactly zero times. OpenRouter is the `E2E_FAKE_LLM` alias. Both asserted, not
 * assumed.
 */

/**
 * The documented long-video threshold. Over this many transcript characters a summary costs 2 credits
 * instead of 1 — README §Summary credits, pinned independently at `src/lib/services/summaries.test.ts`.
 *
 * Restated here deliberately rather than imported from `LONG_TRANSCRIPT_CHARS`: a spec that read the
 * constant the endpoint prices from would follow a regression that moved it and stay green, which is
 * §6.1's oracle rule — the expectation comes from the sources, never from the implementation.
 */
const DOCUMENTED_LONG_TRANSCRIPT_CHARS = 40_000;

/** Same source, same reason: a long video costs 2, and this spec must not learn that from `summaryCost`. */
const DOCUMENTED_LONG_VIDEO_COST = 2;

/** Comfortably over the threshold, and far under the 200,000-char hard cap that answers 413 instead. */
const LONG_TRANSCRIPT = "Transkrypt testowy dla scenariusza długiego filmu e2e. ".repeat(800);
/** Different text, so the two videos cannot be confused by fingerprint or by card. */
const OTHER_LONG_TRANSCRIPT = "Inny długi transkrypt testowy dla scenariusza e2e. ".repeat(900);

const VIDEO_TITLE = "Długi film testowy e2e";
const OTHER_VIDEO_TITLE = "Drugi długi film testowy e2e";

// Three credits, so all three numbers on screen are distinct: cost 2, balance after confirmation 1,
// balance before 3. At the default grant of 5 the quote's "cost" and its "resulting balance" would both
// read 3, and an assertion on that copy could not tell which number was which.
test.use({ accountCredits: 3 });

test("the quoted price is what the confirmation spends, and the card matches the ledger", async ({
  page,
  account,
  seedVideo,
}) => {
  // The scenario rests entirely on this transcript being long, and the fixture is arithmetic — assert
  // it here rather than discover a silently 1-credit run as a confusing failure 60 lines down.
  expect(LONG_TRANSCRIPT.length).toBeGreaterThan(DOCUMENTED_LONG_TRANSCRIPT_CHARS);

  const video = await seedVideo.seed(E2E_YOUTUBE_IDS.longVideo, {
    content: LONG_TRANSCRIPT,
    title: VIDEO_TITLE,
  });

  // The delta is the oracle, so the "before" is read from the database rather than assumed.
  const balanceBefore = await readBalance(account.userId);
  if (balanceBefore === null)
    throw new Error("e2e: the synthetic account has no user_credits row to read a balance from.");
  expect(balanceBefore).toBe(3);

  await page.goto("/summaries");
  await expect(page.getByRole("heading", { name: copy.summaries.page.heading })).toBeVisible();
  // Before touching the capture bar, never after — an unhydrated island silently swallows the fill and
  // no retry recovers. See `awaitIslandsHydrated`.
  await awaitIslandsHydrated(page);

  const submit = page.getByRole("button", { name: copy.generate.submit });
  await page.getByLabel(copy.generate.urlLabel).fill(video.url);
  // The button leaves its disabled state only through the island's own `urlIsValid`, so this is the app
  // confirming it took the URL — not merely that the DOM node holds the text.
  await expect(submit).toBeEnabled();

  // `educational` deliberately, not the form's `informational` default. The quote is keyed server-side
  // by (user, video, CHARACTER), and this choice is made BEFORE the quote exists — so a summary that
  // comes back educational proves the character survived the 409 round-trip and the replay, rather than
  // proving only that the form has a default.
  const characters = page.getByRole("radiogroup", { name: copy.generate.characterLabel });
  await characters.getByText(copy.summaries.character.educational, { exact: true }).click();
  await expect(characters.getByRole("radio", { name: copy.summaries.character.educational })).toBeChecked();

  // Left untouched, and asserted rather than assumed: pre-authorising here would skip the 409 entirely
  // and this spec would silently test the ordinary path. It stays unticked for the whole test, which is
  // what makes the relabelled submit the only possible source of the consent below.
  const allowLong = page.getByRole("checkbox", { name: copy.generate.allowLong });
  await expect(allowLong).not.toBeChecked();

  await submit.click();

  // --- The quote ------------------------------------------------------------------------------
  // No request gate, unlike the seed spec: the amber gate is a RESTING state that waits on the user,
  // not a transient one a fast response can outrun.
  const quoteCard = page.getByRole("article").filter({ hasText: video.url });
  // The gate's four claims live in one live region, because the card changes state while the user may
  // be scrolled somewhere else entirely. Both numbers are interpolated from the app's own copy function
  // with values derived from the DOCUMENTED cost and the balance read out of Postgres — never from the
  // string the page happens to render.
  await expect(quoteCard.getByRole("status")).toContainText(
    copy.generate.gate.held(DOCUMENTED_LONG_VIDEO_COST, balanceBefore - DOCUMENTED_LONG_VIDEO_COST),
  );
  await expect(quoteCard.getByRole("button", { name: copy.generate.gate.reviewAction })).toBeVisible();

  // The consent control itself: the capture bar's submit, relabelled with the price. This is the whole
  // reason the flow needs a browser — the 409 body carries a number, and only the rendered button
  // proves the user was asked to spend exactly that number.
  const confirmSubmit = page.getByRole("button", { name: copy.generate.confirmSubmit(DOCUMENTED_LONG_VIDEO_COST) });
  await expect(confirmSubmit).toBeEnabled();
  // Still unticked. The checkbox is the OTHER way to authorise a long video, and it is not the way this
  // authorisation is about to be given.
  await expect(allowLong).not.toBeChecked();

  // ...and the quote moved no money. Safe to read the header in place here rather than waiting for a
  // change: the hook applies any balance the server sends BEFORE it installs the quote, and the topbar
  // applies the `credits:changed` event synchronously — so by the time the gate card above is on
  // screen, a balance the 409 had (wrongly) reported would already be rendered.
  await expect(page.getByRole("banner").getByLabel(copy.nav.credits)).toHaveText(String(balanceBefore));
  await expect(readBalance(account.userId)).resolves.toBe(balanceBefore);
  await expect(readReservations(account.userId)).resolves.toEqual([]);

  // --- The confirmation -----------------------------------------------------------------------
  await confirmSubmit.click();

  // The saved card replaces the pending one only once the list re-read can prove the row is there
  // (`DashboardSummaries.refreshSummaries`), so waiting for it waits for the whole flow to settle.
  const savedCard = page.getByRole("article").filter({ hasText: VIDEO_TITLE });
  await expect(savedCard.getByRole("heading", { name: VIDEO_TITLE })).toBeVisible();

  // --- The card's claim -----------------------------------------------------------------------
  await savedCard
    .getByRole("button", { name: `${copy.summaries.card.expand} ${copy.summaries.card.summaryOf(VIDEO_TITLE)}` })
    .click();
  // The fingerprint is a function of the seeded transcript, computed by calling the SAME function the
  // app's response came from. On this path it proves more than it does in the seed spec: the confirmed
  // retry sources its transcript from the quote `generate.ts` saved at the 409, so a body carrying this
  // fingerprint is the quoted transcript, summarised at the quoted price.
  await expect(savedCard).toContainText(transcriptFingerprint(video.transcript));
  // ...and the character, which the fingerprint cannot prove — it is a function of the transcript alone,
  // so a card rendering an `informational` body for this same video would satisfy the line above.
  await expect(savedCard).toContainText(fakeCharacterLine("educational"));

  // The headline risk-#6 assertion on the UI side: the header must report the balance the confirmation
  // actually left, not the one a 1-credit charge would have. Waited FOR, not read once — a
  // server-rendered value read straight after an action reports what the page held BEFORE it.
  await expect(page.getByRole("banner").getByLabel(copy.nav.credits)).toHaveText(
    String(balanceBefore - DOCUMENTED_LONG_VIDEO_COST),
  );

  // --- What the request actually did ----------------------------------------------------------
  // Everything above could be true of a card that is merely self-consistent. These read Postgres.
  await expect(readBalance(account.userId)).resolves.toBe(balanceBefore - DOCUMENTED_LONG_VIDEO_COST);

  const reservations = await readReservations(account.userId);
  // Exactly one row, and it is the whole point of the spec: the quote itself opened none (it returns
  // before any debit), and the confirmation debited the documented 2 rather than the default 1. Array
  // equality, not `toContainEqual` — a second reservation would mean the user was charged twice for one
  // consent, which no assertion about the first row would notice. `refusalReason` is asserted here for
  // the same reason the refusal specs assert a concrete cause: the column is what says WHICH kind of
  // debit this was, so a delivered summary booked as a refusal has to be as visible from this side as a
  // refusal booked under the wrong cause is from the other.
  expect(reservations).toEqual([
    expect.objectContaining({ amount: DOCUMENTED_LONG_VIDEO_COST, status: "settled", refusalReason: null }),
  ]);

  const summaries = await readSummaries(account.userId);
  expect(summaries).toHaveLength(1);
  expect(summaries[0]).toMatchObject({
    youtubeId: video.youtubeId,
    character: "educational",
    model: E2E_FAKE_MODEL_SLUG,
    // The saved body is a function of the transcript that was quoted AND the character picked before
    // the quote. This is what ties the price on the card, the debit in the ledger and the stored row to
    // one another rather than to three independently plausible values.
    content: fakeSummaryText({ transcript: video.transcript, character: "educational" }),
  });
  // The settled 2-credit reservation is the one THIS summary was paid for — not some other row that
  // happens to be settled at the right amount.
  expect(summaries[0].reservationId).toBe(reservations[0].id);

  // No paid fetch happened, on either submit. The confirmation retry in particular re-reads the
  // transcript from the quote rather than fetching it a second time, so a row here would mean the user
  // was billed twice at Supadata for one video.
  await expect(readSupadataCalls([video.youtubeId])).resolves.toEqual([]);
});

test("a quote is not transferable — editing the URL withdraws the confirmed price", async ({
  page,
  account,
  seedVideo,
}) => {
  expect(OTHER_LONG_TRANSCRIPT.length).toBeGreaterThan(DOCUMENTED_LONG_TRANSCRIPT_CHARS);

  const quoted = await seedVideo.seed(E2E_YOUTUBE_IDS.longVideo, {
    content: LONG_TRANSCRIPT,
    title: VIDEO_TITLE,
  });
  const switchedTo = await seedVideo.seed(E2E_YOUTUBE_IDS.longVideoSwitched, {
    content: OTHER_LONG_TRANSCRIPT,
    title: OTHER_VIDEO_TITLE,
  });

  const balanceBefore = await readBalance(account.userId);
  if (balanceBefore === null)
    throw new Error("e2e: the synthetic account has no user_credits row to read a balance from.");

  await page.goto("/summaries");
  await expect(page.getByRole("heading", { name: copy.summaries.page.heading })).toBeVisible();
  await awaitIslandsHydrated(page);

  const urlInput = page.getByLabel(copy.generate.urlLabel);
  const submit = page.getByRole("button", { name: copy.generate.submit });
  await urlInput.fill(quoted.url);
  await expect(submit).toBeEnabled();
  await submit.click();

  // The first video is quoted, and the relabelled button is standing.
  const confirmSubmit = page.getByRole("button", { name: copy.generate.confirmSubmit(DOCUMENTED_LONG_VIDEO_COST) });
  await expect(confirmSubmit).toBeEnabled();

  // The quoted video is on screen as a card of its own, awaiting the answer to that price. Pinned
  // before the edit so its disappearance below is a real transition rather than a locator that never
  // matched anything.
  const quotedCard = page.getByRole("article").filter({ hasText: quoted.url });
  await expect(quotedCard).toHaveCount(1);

  // The action this case exists for: point the form at a DIFFERENT video while a confirmed price is on
  // screen. The price was computed for the first video's transcript, so continuing to offer it would
  // let the second one be generated on consent it never received — a card quoting one video against a
  // charge for another, which is risk #6 in the shape only this flow can reach.
  await urlInput.fill(switchedTo.url);

  // The offer is withdrawn: the button is back to the ordinary, unpriced submit. Asserted by its own
  // positive shape, and paired with the disappearance of the priced one so a label that merely gained a
  // second variant cannot satisfy it.
  await expect(submit).toBeEnabled();
  await expect(confirmSubmit).toHaveCount(0);

  // ...and the abandoned video stops being shown as work in progress. Withdrawing the quote leaves the
  // attempt with no loading, no confirmation, no error and no saved result, which the list read back as
  // "generating" — a card claiming the first video was still being summarised while no request existed.
  // The second submit installs a new attempt over it, so this is the only moment that state is
  // observable at all, and asserting it here is what makes the withdrawal complete rather than partial.
  await expect(quotedCard).toHaveCount(0);

  // And the withdrawal is real rather than cosmetic: submitting the new video gets its OWN quote — the
  // 409 again, naming the new URL — instead of proceeding at the old confirmation's price.
  await submit.click();
  const newQuoteCard = page.getByRole("article").filter({ hasText: switchedTo.url });
  await expect(newQuoteCard.getByRole("status")).toContainText(
    copy.generate.gate.held(DOCUMENTED_LONG_VIDEO_COST, balanceBefore - DOCUMENTED_LONG_VIDEO_COST),
  );

  // --- What the request actually did ----------------------------------------------------------
  // Nothing, and that is the assertion: two quotes and a video switch move no money at all. Every exit
  // this test takes is above the debit, so an empty ledger is the exact shape of a correct run — a
  // single reservation of any amount would mean a user was charged while still being asked to confirm.
  await expect(readBalance(account.userId)).resolves.toBe(balanceBefore);
  await expect(readReservations(account.userId)).resolves.toEqual([]);
  await expect(readSummaries(account.userId)).resolves.toEqual([]);
  await expect(readSupadataCalls([quoted.youtubeId, switchedTo.youtubeId])).resolves.toEqual([]);
});
