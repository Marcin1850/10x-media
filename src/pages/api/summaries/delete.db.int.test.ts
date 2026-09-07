import { describe, expect, it } from "vitest";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import type { APIContext, AstroCookies } from "astro";
import { createSyntheticAccount, type SyntheticAccount } from "@/test/synthetic-account";
import { getDbOwnerConnection } from "@/test/db-owner";
import { readJson } from "./__fixtures__/generation-harness";
import { DELETE } from "./[id]";

/**
 * Real-database layer for `DELETE /api/summaries/[id]` (plan Phase 2 item 2; S-03).
 *
 * Two properties the feature rests on, proved against a real local Postgres: **the row is gone**, and
 * **the balance did not move**. The second is the whole reason this file exists — "deleting a summary
 * never returns a credit" is the user's explicit constraint, and it holds today only *structurally*
 * (`persist_summary` settles the reservation in the same transaction that writes the summary, so a
 * delivered-then-deleted summary is invisible to `reconcile_reservation`'s sweep). There is no refund
 * code to review; the work is to make the property executable so a future change cannot break it
 * silently. The cross-account boundary is re-proved here at the *endpoint* level — the policy itself
 * is already covered by `cross-account-policy.int.test.ts`, but nothing yet proved the route hands a
 * denied delete back as a clean `404`.
 *
 * **Nothing paid is involved**, so unlike `generate.db.int.test.ts` this file mocks no vendor, seeds
 * no `transcript_cache`/`metadata_cache`, and loads the endpoint with a plain static import — there is
 * no seam to reset. `@/lib/supabase` is REAL: each request carries a synthetic account's `Cookie`
 * header, so `createClient` inside the route resolves that session and RLS evaluates `auth.uid()` as
 * that account, which is what production does. Rows are seeded directly through
 * `getDbOwnerConnection()`, the way `cross-account-policy.int.test.ts`'s `seed()` does.
 *
 * **The owner connection seeds and reads back; it never stands in for what a user can see**
 * (`test-plan.md` §6.3). `listSummaries` is likewise never used to check a row is gone — its own
 * `.eq("user_id", …)` masks a broadened policy (§6.3 rule 3). "PostgREST reported no rows deleted" and
 * "nothing was destroyed" are different claims (§6.3 rule 4), so the cross-account case asserts both.
 *
 * The synthetic youtube ids below are deliberately **not** added to `RESERVED_YOUTUBE_IDS`
 * (`synthetic-fixtures.ts`): that registry guards the user-agnostic caches, which this file never
 * touches (§6.3 rule 6). These rows are per-user and leave with `dispose()`'s `auth.users` cascade.
 *
 * Oracle — for the balance half, the documented credit rule (`README.md` → Summary credits: a credit
 * is spent on a *successful summary*, and refills are **manual-only**, which is what makes any
 * increase outside an operator action a bug by definition) plus
 * `20260723120000_atomic_persist_summary.sql:13-15,21-22` — case 2 "DELIVERED, THEN UNLINKED" and its
 * conclusion that deletion can no longer rewrite a billing outcome. For the cross-account half, the
 * PRD's own guardrail (`prd.md:36-37`, restated at `:70-73` and `:90-92`), enforced by
 * `20260613145120_videos_and_summaries.sql:61-63`. Neither is recomputed the way the code computes it.
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error(
    "delete.db.int.test.ts requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY — set by the local " +
      "stack's .env and already validated by integration-setup.ts's globalSetup.",
  );
}

/** Creating and deleting the synthetic `auth.users` rows is all `admin` does here. */
const admin = createAdminClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
// Seeding and verification read-back only — never an assertion about what a *user* can see. The pool
// is closed by `fetch-firewall.ts`'s `afterAll` (db-owner.ts has no teardown of its own).
const dbOwner = getDbOwnerConnection();

/** One id per scenario, so a leaked row from one test can never satisfy another's `unique (user_id, youtube_id)`. */
const DELETE_YOUTUBE_IDS = {
  ownRowGone: "dsdel0001",
  balanceStable: "dsdel0002",
  crossAccountA: "dsdel0003",
  crossAccountB: "dsdel0004",
  repeatDelete: "dsdel0005",
} as const;

/** `createClient` writes refreshed session cookies through this; a test needs none of them. */
const NOOP_COOKIES = {
  get: () => undefined,
  set: () => undefined,
  delete: () => undefined,
  has: () => false,
} as unknown as AstroCookies;

interface SeededAccount {
  account: SyntheticAccount;
  userId: string;
  summaryId: string;
}

/**
 * Gives an account one `videos` row and one `summaries` row through the table-owner connection — no
 * endpoint, no generation, no transcript, no LLM. `character` must be `'informational'` or
 * `'educational'` (`20260613145120_videos_and_summaries.sql:38`), and `summaries`' composite FK
 * `(video_id, user_id) -> videos (id, user_id)` (line 41) means a summary can only ever point at a
 * video its own owner holds.
 */
async function seed(account: SyntheticAccount, youtubeId: string): Promise<SeededAccount> {
  const [video] = await dbOwner<{ id: string }[]>`
    insert into videos (user_id, url, youtube_id)
    values (${account.userId}, ${`https://www.youtube.com/watch?v=${youtubeId}`}, ${youtubeId})
    returning id
  `;
  const [summary] = await dbOwner<{ id: string }[]>`
    insert into summaries (user_id, video_id, character, content)
    values (${account.userId}, ${video.id}, 'informational', ${`synthetic summary for ${youtubeId}`})
    returning id
  `;
  return { account, userId: account.userId, summaryId: summary.id };
}

/**
 * The request the browser makes, minus the browser. `locals.user` is what `middleware.ts` resolves onto
 * the context; the `Cookie` header is what the route's own `createClient` turns back into a session, so
 * RLS evaluates `auth.uid()` as this account and not as a hand-made client's.
 */
function makeDeleteContext(account: SyntheticAccount, summaryId: string): APIContext {
  return {
    locals: { user: { id: account.userId } },
    params: { id: summaryId },
    request: new Request(`http://localhost/api/summaries/${summaryId}`, {
      method: "DELETE",
      headers: { Cookie: account.cookieHeader },
    }),
    cookies: NOOP_COOKIES,
  } as unknown as APIContext;
}

/** Read back through the table-owner connection: the row's existence, not what any session can see. */
async function summaryExists(summaryId: string): Promise<boolean> {
  const rows = await dbOwner<{ id: string }[]>`select id from summaries where id = ${summaryId}`;
  return rows.length > 0;
}

/**
 * The account's credit balance. Never seeded by a test: `synthetic-account.ts:9-13` states callers
 * "must NOT set the initial balance by hand", so the value below is whatever `on_auth_user_created`
 * granted — read before, read after, compared to itself.
 */
async function readBalance(userId: string): Promise<number> {
  const rows = await dbOwner<{ balance: number }[]>`select balance from user_credits where user_id = ${userId}`;
  if (rows.length === 0) throw new Error(`readBalance: no user_credits row for ${userId}`);
  return rows[0].balance;
}

async function withSeededAccount(youtubeId: string, run: (seeded: SeededAccount) => Promise<void>): Promise<void> {
  const account = await createSyntheticAccount(admin);
  try {
    await run(await seed(account, youtubeId));
  } finally {
    // No `youtubeIds` argument: this file creates no `supadata_calls` row, and the seeded
    // `videos`/`summaries` leave with the `auth.users` cascade.
    await account.dispose();
  }
}

/**
 * Two seeded accounts, disposed in **nested** `try/finally` so a throw while disposing one still
 * disposes the other (`test-plan.md` §6.3 rule 5). `dispose()` throws by design, and a leaked
 * `auth.users` row aborts the *next* run's stale-account guard, so a swallowed second disposal would
 * surface as an unrelated failure one run later.
 */
async function withTwoSeededAccounts(run: (a: SeededAccount, b: SeededAccount) => Promise<void>): Promise<void> {
  const accountA = await createSyntheticAccount(admin);
  try {
    const accountB = await createSyntheticAccount(admin);
    try {
      const a = await seed(accountA, DELETE_YOUTUBE_IDS.crossAccountA);
      const b = await seed(accountB, DELETE_YOUTUBE_IDS.crossAccountB);
      await run(a, b);
    } finally {
      await accountB.dispose();
    }
  } finally {
    await accountA.dispose();
  }
}

describe("DELETE /api/summaries/[id] against the real stack (S-03)", () => {
  it("deletes the caller's own summary and the row is gone", async () => {
    await withSeededAccount(DELETE_YOUTUBE_IDS.ownRowGone, async (seeded) => {
      const response = await DELETE(makeDeleteContext(seeded.account, seeded.summaryId));

      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toEqual({ ok: true });
      expect(
        await summaryExists(seeded.summaryId),
        "The endpoint answered 200 but the row survives. A 200 is the endpoint's claim that exactly " +
          "one row was destroyed, and only the table-owner read-back can hold it to that claim — " +
          "PostgREST reporting an affected row is a different statement from the row being gone.",
      ).toBe(false);
    });
  });

  it("leaves the credit balance untouched across a deletion", async () => {
    await withSeededAccount(DELETE_YOUTUBE_IDS.balanceStable, async (seeded) => {
      const balanceBefore = await readBalance(seeded.userId);

      const response = await DELETE(makeDeleteContext(seeded.account, seeded.summaryId));
      expect(response.status).toBe(200);

      expect(
        await readBalance(seeded.userId),
        "Deleting a summary moved the credit balance. It must not, in either direction. A credit is " +
          "spent on a successful summary and refills are manual-only (README → Summary credits), so " +
          "any change here is a billing outcome rewritten after the fact — exactly the case " +
          "20260723120000_atomic_persist_summary.sql:13-15,21-22 names 'DELIVERED, THEN UNLINKED' and " +
          "concludes can no longer happen, because persist_summary settles the reservation in the same " +
          "transaction that writes the summary. If this row is red, either a refund path was added or " +
          "reconcile_reservation's sweep now sees settled rows.",
      ).toBe(balanceBefore);
    });
  });

  it("404s when one account deletes another's summary, and that summary survives", async () => {
    await withTwoSeededAccounts(async (a, b) => {
      // B's cookie header, B's summary id — the request account B could actually issue against A's row.
      const response = await DELETE(makeDeleteContext(b.account, a.summaryId));

      expect(
        response.status,
        "Account B's delete of account A's summary did not answer 404. Under RLS 'not yours' and " +
          "'already gone' are the same observation, so 404 is the only answer that leaks nothing.",
      ).toBe(404);
      await expect(readJson(response)).resolves.toEqual({ error: "Summary not found" });

      expect(
        await summaryExists(a.summaryId),
        "Account A's summary is gone after account B issued a DELETE against it. The 404 above only " +
          "says PostgREST reported no rows; this says nothing was destroyed. `authenticated` genuinely " +
          "holds DELETE on summaries (20260731130000:27-39), so the owner-scoped policy " +
          "(20260613145120:61-63) is the only thing standing between B and A's data — the PRD privacy " +
          "guardrail (prd.md:36-37).",
      ).toBe(true);
    });
  });

  it("404s, not 500s, when the same summary is deleted twice", async () => {
    await withSeededAccount(DELETE_YOUTUBE_IDS.repeatDelete, async (seeded) => {
      const first = await DELETE(makeDeleteContext(seeded.account, seeded.summaryId));
      expect(first.status).toBe(200);

      const second = await DELETE(makeDeleteContext(seeded.account, seeded.summaryId));

      expect(
        second.status,
        "Re-deleting an already-deleted summary did not answer 404. This is the contract the island " +
          "depends on: it treats 404 as 'the row is gone' and keeps its optimistic removal, reverting " +
          "the card only on a 5xx, a 401, or a network failure. A 500 here would make a second tab's " +
          "deletion look like a server fault and resurrect a card for a summary that no longer exists.",
      ).toBe(404);
      await expect(readJson(second)).resolves.toEqual({ error: "Summary not found" });
    });
  });
});
