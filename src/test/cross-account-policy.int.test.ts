import { describe, expect, it } from "vitest";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import type { AstroCookies } from "astro";
import { createClient as createAppClient } from "@/lib/supabase";
import type { AppSupabaseClient } from "@/lib/services/summaries";
import { createSyntheticAccount, type SyntheticAccount } from "@/test/synthetic-account";
import { getDbOwnerConnection } from "@/test/db-owner";

/**
 * Data-boundary authorization — the BEHAVIOURAL half of test-plan risk #4 (plan.md Phase 2).
 *
 * The catalog half lives in `authorization-invariants.int.test.ts`: it proves the five owner-scoped
 * policies *exist* and that their `using` clause is still `auth.uid() = user_id`. This file proves
 * they *work*, from the only position that can prove it — a real signed-in session, issuing reads the
 * way PostgREST receives them from a browser.
 *
 * **The anti-pattern this file exists to avoid, stated in the negative: it must NEVER call
 * `listSummaries` or `getBalance` with a `userId`.** Both apply `.eq("user_id", …)` on top of RLS
 * (`summary-list.ts:58`, `credits.ts:31`) — defence in depth in production, but a mask over exactly
 * the regression under test here: with the policy broadened to `using (true)`, a `userId`-filtered
 * read still returns only the caller's rows and the test stays green. That is precisely why the one
 * prior cross-account check in this repo disclaims itself
 * (`context/changes/browse-summary-list/reviews/manual-verification-phase-1.md:67-75`). Every read
 * below is therefore **unfiltered**, or filtered only by the *other* account's row id — never by
 * `user_id`. Do not add a `user_id` filter to "make a test more precise"; it removes the test.
 *
 * **Nothing here is asserted through an owner or `service_role` connection.** Both bypass RLS by
 * definition and would go green against a broken policy. `getDbOwnerConnection()` appears only to
 * *seed* rows and to *read back* what a denied DELETE must have left intact — never to stand in for
 * what a user can see.
 *
 * **The session under test is the one production builds.** `@/lib/supabase`'s own `createClient` is
 * called with a `Headers` carrying the synthetic account's `Cookie` header, so the header round-trips
 * through the app's real `parseCookieHeader` and the JWT PostgREST sees is the one a browser would
 * send. `synthetic-account.ts` is not modified for this file. The local stack is loopback, so
 * `fetch-firewall.ts` permits the calls, and test-plan §7 is satisfied by construction: no endpoint,
 * no generation, no transcript, no LLM — rows are seeded directly.
 *
 * Oracle: the PRD privacy guardrail (`prd.md:37`, `prd.md:73`, `prd.md:92`) and each policy's own
 * migration — `20260613145120_videos_and_summaries.sql:19-20,31-32,50-51,62-63` (videos/summaries
 * SELECT+DELETE) and `20260712175240_user_credits.sql:17-19` (user_credits SELECT). Five policies,
 * five owner-scoped verbs; every one of them is exercised below.
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error(
    "cross-account-policy.int.test.ts requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY — set by the " +
      "local stack's .env and already validated by integration-setup.ts's globalSetup.",
  );
}

const admin = createAdminClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
// Seeding and denied-DELETE read-back only — never an assertion about what a *user* can see. The owner
// connection is used rather than `admin` for symmetry with the rest of the harness; the pool is closed
// by `fetch-firewall.ts`'s `afterAll` (db-owner.ts has no teardown of its own).
const dbOwner = getDbOwnerConnection();

/**
 * Synthetic video ids for the two seeded accounts. Deliberately **not** added to
 * `RESERVED_YOUTUBE_IDS` (`synthetic-fixtures.ts`): that registry guards the *user-agnostic* caches
 * (`transcript_cache`, `metadata_cache`), which nothing in this file touches. The rows seeded here are
 * per-user and leave with `dispose()`'s `auth.users` cascade, so a stale-row guard keyed on them would
 * be watching a table they can never reach.
 */
const CROSS_ACCOUNT_YOUTUBE_IDS = {
  accountA: "xacct0001",
  accountB: "xacct0002",
} as const;

/** The three client-reachable tables, each gated by its own owner-scoped SELECT policy. */
const CLIENT_READABLE_TABLES = ["summaries", "videos", "user_credits"] as const;

/** The two tables `authenticated` genuinely holds DELETE on — a live verb, not a hypothetical. */
const CLIENT_DELETABLE_TABLES = ["summaries", "videos"] as const;

/**
 * The embed `listSummaries` actually issues (`summary-list.ts:46-48`), reduced to the one field that
 * identifies whose video it is. The result is cast rather than inferred for the same reason
 * `summary-list.ts:60-63` casts its own: this codebase's hand-written `AppDatabase` leaves
 * `Relationships` empty, so supabase-js cannot type an embed from it.
 */
const EMBED_SELECT = "id, videos ( youtube_id )";

/** `createClient` writes refreshed session cookies through this; a test needs none of them. */
const NOOP_COOKIES = {
  get: () => undefined,
  set: () => undefined,
  delete: () => undefined,
  has: () => false,
} as unknown as AstroCookies;

/**
 * An RLS-scoped client for one account, built through the app's own factory. Pass an empty header to
 * get the unauthenticated (`anon`) client — the same code path a signed-out browser reaches.
 *
 * The cast is the codebase's standing `any` gap, not a shortcut: `@/lib/supabase`'s `createClient`
 * returns supabase-js's default untyped client because there are no generated `Database` types yet
 * (`generate.ts:451-453` records the same gap at its own call site).
 */
function sessionClient(cookieHeader: string): AppSupabaseClient {
  const headers = new Headers(cookieHeader.length > 0 ? { Cookie: cookieHeader } : {});
  const client = createAppClient(headers, NOOP_COOKIES);
  if (!client) {
    throw new Error(
      "cross-account-policy: @/lib/supabase's createClient returned null, which means SUPABASE_URL or " +
        "SUPABASE_KEY is unset in the aliased astro:env/server stub (src/test/astro-env-server-stub.ts).",
    );
  }
  return client as AppSupabaseClient;
}

interface SeededAccount {
  account: SyntheticAccount;
  userId: string;
  youtubeId: string;
  videoId: string;
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
  return {
    account,
    userId: account.userId,
    youtubeId,
    videoId: video.id,
    summaryId: summary.id,
  };
}

/**
 * Two seeded accounts, disposed in **nested** `try/finally` so a throw while disposing one still
 * disposes the other. `dispose()` throws by design (impl-review.md F3), and a leaked `auth.users` row
 * aborts the *next* run's stale-account guard, so a swallowed second disposal would surface as an
 * unrelated failure one run later.
 *
 * No `youtubeIds` argument is passed to `dispose()`: this file creates no `supadata_calls` row, and the
 * seeded `videos`/`summaries` leave with the `auth.users` cascade.
 */
async function withTwoSeededAccounts(run: (a: SeededAccount, b: SeededAccount) => Promise<void>): Promise<void> {
  const accountA = await createSyntheticAccount(admin);
  try {
    const accountB = await createSyntheticAccount(admin);
    try {
      const a = await seed(accountA, CROSS_ACCOUNT_YOUTUBE_IDS.accountA);
      const b = await seed(accountB, CROSS_ACCOUNT_YOUTUBE_IDS.accountB);
      await run(a, b);
    } finally {
      await accountB.dispose();
    }
  } finally {
    await accountA.dispose();
  }
}

/** PostgREST result shape for the unfiltered owner reads — see `EMBED_SELECT` for why these are cast. */
interface OwnerColumnResult {
  data: { user_id: string }[] | null;
  error: { message: string } | null;
}

// ---------------------------------------------------------------------------------------------------
// The probes. Each catches a different regression; none can be satisfied by the service layer's own
// `.eq("user_id", …)`, because none of them goes through the service layer.
// ---------------------------------------------------------------------------------------------------

describe("cross-account data boundary (test-plan risk #4)", () => {
  it.each(CLIENT_READABLE_TABLES)("an unfiltered read of %s returns only the caller's own rows", async (table) => {
    await withTwoSeededAccounts(async (a, b) => {
      const asB = sessionClient(b.account.cookieHeader);

      const { data, error } = (await asB.from(table).select("user_id")) as unknown as OwnerColumnResult;

      expect(error, `Reading ${table} as a signed-in account failed outright.`).toBeNull();
      expect(
        (data ?? []).map((row) => row.user_id),
        `An UNFILTERED select on ${table}, issued as account B, did not return exactly B's own rows — ` +
          `account A's seeded row leaked across the boundary. This is the PRD privacy guardrail ` +
          `(prd.md:37), enforced here by ${table}'s owner-scoped SELECT policy alone: the read above ` +
          `deliberately carries no user_id filter, because listSummaries/getBalance's own ` +
          `.eq("user_id", …) would mask exactly this regression. Check the policy's using clause is ` +
          `still auth.uid() = user_id.`,
      ).toEqual([b.userId]);

      expect(
        (data ?? []).some((row) => row.user_id === a.userId),
        `Account A's ${table} row was visible to account B.`,
      ).toBe(false);
    });
  });

  it("a direct id lookup of another account's summary returns nothing", async () => {
    await withTwoSeededAccounts(async (a, b) => {
      const asB = sessionClient(b.account.cookieHeader);

      const { data, error } = await asB.from("summaries").select("*").eq("id", a.summaryId);

      expect(error, "Reading summaries by id as a signed-in account failed outright.").toBeNull();
      expect(
        data,
        "Account B fetched account A's summary by its primary key. Distinct from the unfiltered-list " +
          "case: a policy can shape a list and still hand over a row that is asked for by name. Summary " +
          "ids are uuids, but the PRD guardrail is not 'hard to guess' — it is 'not reachable'.",
      ).toEqual([]);
    });
  });

  it.each(CLIENT_DELETABLE_TABLES)(
    "deleting another account's %s row affects no rows and leaves the row intact",
    async (table) => {
      await withTwoSeededAccounts(async (a, b) => {
        const asB = sessionClient(b.account.cookieHeader);
        const targetId = table === "summaries" ? a.summaryId : a.videoId;

        const { data, error } = (await asB.from(table).delete().eq("id", targetId).select("id")) as unknown as {
          data: { id: string }[] | null;
          error: { message: string } | null;
        };

        expect(error, `Issuing a DELETE on ${table} as a signed-in account failed outright.`).toBeNull();
        expect(
          data,
          `Account B's DELETE against account A's ${table} row reported deleted rows. authenticated ` +
            `genuinely holds DELETE on ${table} (20260726120000:25-37, 20260731130000:27-39), so the ` +
            `only thing standing between B and A's data is the owner-scoped DELETE policy.`,
        ).toEqual([]);

        // Read back through the owner connection: "PostgREST reported nothing" and "nothing was
        // destroyed" are different claims, and only the second one is the user's data still existing.
        const survivors = await dbOwner<{ id: string }[]>`
          select id from ${dbOwner(table)} where id = ${targetId}
        `;
        expect(
          survivors.map((row) => row.id),
          `Account A's ${table} row is gone after account B issued a DELETE against it.`,
        ).toEqual([targetId]);

        const summarySurvivors = await dbOwner<{ id: string }[]>`
          select id from summaries where id = ${a.summaryId}
        `;
        expect(
          summarySurvivors.map((row) => row.id),
          "Account A's summary is gone. A permitted DELETE on videos would cascade to it " +
            "(20260613145120:41), so this catches the cascade even when the targeted row itself survives.",
        ).toEqual([a.summaryId]);
      });
    },
  );

  it("the production embed shape returns only the caller's summary and the caller's own video", async () => {
    await withTwoSeededAccounts(async (a, b) => {
      const asB = sessionClient(b.account.cookieHeader);

      const { data, error } = (await asB.from("summaries").select(EMBED_SELECT)) as unknown as {
        data: { id: string; videos: { youtube_id: string } | null }[] | null;
        error: { message: string } | null;
      };

      expect(error, "The listSummaries embed shape failed outright as a signed-in account.").toBeNull();
      expect(
        data,
        "The embed shape listSummaries actually issues (summary-list.ts:46-48) leaked across accounts. " +
          "An embedded table is a SECOND policy evaluation — videos' own SELECT policy — so this row " +
          "catches a videos regression the summaries-only probes above cannot: the parent could stay " +
          `owner-scoped while the join hands over another account's video metadata (A seeded ` +
          `${CROSS_ACCOUNT_YOUTUBE_IDS.accountA}).`,
      ).toEqual([{ id: b.summaryId, videos: { youtube_id: b.youtubeId } }]);
      expect(a.youtubeId, "Account A must hold a distinct video for the embed probe to mean anything.").toBe(
        CROSS_ACCOUNT_YOUTUBE_IDS.accountA,
      );
    });
  });

  it.each(CLIENT_READABLE_TABLES)("an unauthenticated session reads no rows from %s", async (table) => {
    await withTwoSeededAccounts(async (a, b) => {
      // Both accounts are seeded before this read, so there are rows to leak; the signed-out session
      // must still see none of them.
      expect([a.userId, b.userId].filter(Boolean)).toHaveLength(2);
      const signedOut = sessionClient("");

      const { data } = (await signedOut.from(table).select("user_id")) as unknown as OwnerColumnResult;

      // Two acceptable shapes, one property: nothing comes back. `anon` holds no privilege on any
      // relation in `public` (20260714140000:33-35, and authorization-invariants invariant 3), so
      // PostgREST refuses at the privilege layer and `data` is null; were a grant ever added, the
      // owner-scoped policy would still yield zero rows for a session with no `auth.uid()`.
      expect(
        data ?? [],
        `A signed-out request read rows from ${table}. Every path in this app requires authentication ` +
          `(20260714140000:33-35), so a signed-out session must reach nothing at all. Check that anon ` +
          `still holds no privilege on ${table} and that its SELECT policy is still restricted to the ` +
          `authenticated role.`,
      ).toEqual([]);
    });
  });
});
