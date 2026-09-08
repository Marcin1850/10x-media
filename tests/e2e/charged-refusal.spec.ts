import { copy } from "@/lib/copy";
import { E2E_YOUTUBE_IDS } from "./fixtures/registry";
import { awaitIslandsHydrated } from "./fixtures/hydration";
import { readBalance, readReservations, readSummaries, readSupadataCalls } from "./fixtures/ledger";
import { expect, test } from "./fixtures/test";

/**
 * **The charged-refusal spec** — test-plan risk #6 at its sharpest: *a refusal that took a credit*.
 *
 * Rules and cookbook: `context/foundation/test-plan.md` §6.4. Exemplar: `generate-summary.spec.ts`,
 * which this file is modelled on — same two-sided oracle, same role-based locators, same waits for
 * state.
 *
 * **Why this flow and not the happy path's mirror image.** A successful generation gives the user a
 * summary to weigh the charge against; a refusal gives them nothing but the card's word for what
 * happened to their credit. Everything the user can ever learn about that money is the two lines
 * inside one `role="alert"`, so a card that misreports here is not a cosmetic bug — it is the entire
 * observable surface of a real debit being wrong. Both cases therefore assert the card's claim AND
 * the ledger row behind it, read from Postgres with the application out of the loop.
 *
 * **The cause is part of the oracle, not decoration.** The two exits below answer with the SAME status
 * (422) and the same charge, and differ only in *why* — one video has no caption track, the other has
 * captions holding no words. That distinction is the reason the endpoint sends a machine-readable
 * `code` at all (D3, `change.md` ruling 1 of 2026-09-08): a single per-status message would have
 * merged them. So each case asserts the Polish string for ITS OWN cause, and pairs it with the
 * `refusalReason` the database actually recorded. A card naming one cause over a row charged for the
 * other is self-consistent, correctly priced, and wrong — which is precisely risk #6.
 *
 * Each outcome is asserted by its own shape, never as the negation of the other.
 *
 * **The transient `failed`/`timeout` 422 is deliberately absent** — the one exit that answers
 * `charged: false`, and so the only producer of the card's `Nie pobrano kredytu…` line. It is not
 * browser-reachable: it lives in the cache-MISS branch after a real `fetchTranscript`, those outcomes
 * are never cached by design (`generate.ts:723-724`), `reason: "failed"` comes only from a Supadata
 * job the vendor reports failed and `"timeout"` only from the poll loop expiring
 * (`transcript.ts:456,465`), and the placeholder key in `.dev.vars.e2e` yields a 401 that throws to a
 * 502 rather than to this 422. Reaching it would take a real vendor call. Its server-side contract is
 * covered at the integration layer instead (`generate.int.test.ts:290,409`); §6.4 records the gap.
 *
 * **No vendor is contacted.** Both Supadata checkpoints are seeded cache hits, and a negative hit
 * answers for free what a fetch would have charged for. OpenRouter is never reached at all — these
 * exits return ~200 lines upstream of the summarize call. Asserted, not assumed.
 */

/** Nothing to summarize, so nothing to seed: the real endpoint caches `content: ""` for both outcomes. */
const NO_TRANSCRIPT = "";

test.describe("a video with no caption track", () => {
  // One credit, so this refusal spends the user's last one. That makes the post-charge balance
  // observable in a second place — the capture bar's own gate — and it is the exact state Phase 0
  // existed to fix: before it, the hook still read 1 here and let the user submit into a 402.
  test.use({ accountCredits: 1 });

  test("the refusal names the missing captions, says the credit was taken, and the ledger agrees", async ({
    page,
    account,
    seedVideo,
  }) => {
    const video = await seedVideo.seed(E2E_YOUTUBE_IDS.refusalNoCaptions, {
      content: NO_TRANSCRIPT,
      outcome: "unavailable",
    });

    // Read, not assumed, for the same reason the seed spec reads it: the delta is the oracle, and this
    // stays true if the fixture's grant ever changes.
    const balanceBefore = await readBalance(account.userId);
    if (balanceBefore === null)
      throw new Error("e2e: the synthetic account has no user_credits row to read a balance from.");
    expect(balanceBefore).toBe(1);

    await page.goto("/summaries");
    await expect(page.getByRole("heading", { name: copy.summaries.page.heading })).toBeVisible();
    // Before touching the capture bar, never after — an unhydrated island silently swallows the fill
    // and no retry recovers. See `awaitIslandsHydrated`.
    await awaitIslandsHydrated(page);

    const submit = page.getByRole("button", { name: copy.generate.submit });
    await page.getByLabel(copy.generate.urlLabel).fill(video.url);
    // The button leaves its disabled state only through the island's own `urlIsValid`, so this is the
    // app confirming it took the URL — not merely that the DOM node holds the text.
    await expect(submit).toBeEnabled();
    await submit.click();

    // --- The card's claim -----------------------------------------------------------------------
    // No request gate here, unlike the seed spec: the failure card is a RESTING state that survives
    // until the user dismisses it, not a transient one a fast response can outrun.
    const failedCard = page.getByRole("article").filter({ hasText: video.url });
    // One live region carries both facts, which is the point of its placement: a screen reader must
    // not announce the failure while dropping what happened to the user's credit.
    const alert = failedCard.getByRole("alert");
    await expect(alert).toContainText(copy.errors.codes.noCaptions);
    await expect(alert).toContainText(copy.generate.charged);
    // The user can retire the card once they have read it; without this the alert is a dead end.
    await expect(failedCard.getByRole("button", { name: copy.generate.dismissFailed })).toBeVisible();

    // The header syncs on the `credits:changed` event after a charged refusal too, with no reload
    // (Phase 0 item 7). Waited FOR, not read once — a server-rendered value read straight after an
    // action reports what the page held BEFORE it, which is green against a real regression.
    await expect(page.getByRole("banner").getByLabel(copy.nav.credits)).toHaveText("0");
    // The second surface the corrected balance reaches, and the one with teeth: the capture bar now
    // refuses a submit it would previously have sent into a 402.
    await expect(page.getByText(copy.generate.noCredits)).toBeVisible();
    await expect(submit).toBeDisabled();

    // --- What the request actually did ----------------------------------------------------------
    // Everything above could be true of a card that is merely self-consistent. These read Postgres.
    await expect(readBalance(account.userId)).resolves.toBe(balanceBefore - 1);

    const reservations = await readReservations(account.userId);
    // A refusal charge is written already settled — there is no work between reserve and settle, so a
    // `reserved` row here would be one the hourly sweep refunds
    // (`20260731110000_charge_failed_transcript.sql`).
    expect(reservations).toEqual([
      expect.objectContaining({ amount: 1, status: "settled", refusalReason: "unavailable" }),
    ]);

    // The whole shape of this exit: a credit was taken and nothing was produced for it. A refusal that
    // somehow saved a summary would pass every assertion above.
    await expect(readSummaries(account.userId)).resolves.toEqual([]);

    // A negative cache hit answers for free what the fetch would have charged for. A row here would
    // mean the seed missed and Supadata was really called.
    await expect(readSupadataCalls([video.youtubeId])).resolves.toEqual([]);
  });
});

test.describe("a video whose captions contain no words", () => {
  // Three credits deliberately, not one: this case's job is to prove the charge moves the balance by
  // exactly one from wherever it stood, which a run that can only ever land on zero cannot show.
  test.use({ accountCredits: 3 });

  test("the refusal names the unusable transcript — a different cause, a different message, its own ledger row", async ({
    page,
    account,
    seedVideo,
  }) => {
    const video = await seedVideo.seed(E2E_YOUTUBE_IDS.refusalEmpty, {
      content: NO_TRANSCRIPT,
      outcome: "empty",
    });

    const balanceBefore = await readBalance(account.userId);
    if (balanceBefore === null)
      throw new Error("e2e: the synthetic account has no user_credits row to read a balance from.");
    expect(balanceBefore).toBe(3);

    await page.goto("/summaries");
    await expect(page.getByRole("heading", { name: copy.summaries.page.heading })).toBeVisible();
    await awaitIslandsHydrated(page);

    const submit = page.getByRole("button", { name: copy.generate.submit });
    await page.getByLabel(copy.generate.urlLabel).fill(video.url);
    await expect(submit).toBeEnabled();
    await submit.click();

    // --- The card's claim -----------------------------------------------------------------------
    const failedCard = page.getByRole("article").filter({ hasText: video.url });
    const alert = failedCard.getByRole("alert");
    // THE assertion this case exists for. `empty` is a vendor SUCCESS on a wordless video, not a
    // missing caption track, and the two must not read alike — they are the pair that shared one
    // English string until the cause code split them. Asserted positively, by its own copy: a
    // regression that collapsed both causes back onto one message fails here while case 1 stays green.
    await expect(alert).toContainText(copy.errors.codes.transcriptUnavailable);
    await expect(alert).toContainText(copy.generate.charged);
    await expect(failedCard.getByRole("button", { name: copy.generate.dismissFailed })).toBeVisible();

    await expect(page.getByRole("banner").getByLabel(copy.nav.credits)).toHaveText(String(balanceBefore - 1));

    // --- What the request actually did ----------------------------------------------------------
    await expect(readBalance(account.userId)).resolves.toBe(balanceBefore - 1);

    const reservations = await readReservations(account.userId);
    // The ledger-side half of the cause assertion above. `refusalReason` is where the app records WHY
    // it charged, so this is what turns "the card said captions-with-no-words" into a claim about the
    // request rather than about the card.
    expect(reservations).toEqual([expect.objectContaining({ amount: 1, status: "settled", refusalReason: "empty" })]);

    await expect(readSummaries(account.userId)).resolves.toEqual([]);
    await expect(readSupadataCalls([video.youtubeId])).resolves.toEqual([]);
  });
});
