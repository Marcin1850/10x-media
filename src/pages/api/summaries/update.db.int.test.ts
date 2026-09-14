import { describe, expect, it } from "vitest";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import type { APIContext, AstroCookies } from "astro";
import { createClient as createAppClient } from "@/lib/supabase";
import type { AppSupabaseClient } from "@/lib/services/summaries";
import { listSummaries } from "@/lib/services/summary-list";
import { createSyntheticAccount, type SyntheticAccount } from "@/test/synthetic-account";
import { getDbOwnerConnection } from "@/test/db-owner";
import { readJson } from "./__fixtures__/generation-harness";
import { PATCH } from "./[id]";

/**
 * Real-database layer for `PATCH /api/summaries/[id]` (S-14, plan Phase 2 §4). Shape and discipline are
 * `delete.db.int.test.ts`'s: a real `@/lib/supabase` resolving each synthetic account's `Cookie` header, rows
 * seeded through `getDbOwnerConnection()`, nothing paid on the path, disposal in nested `try/finally`.
 *
 * Three properties: **the mark persists** for the owner (read back through the owner connection, which
 * says what is stored rather than what any session can see), **a clear persists** as `null`, and **another
 * account's PATCH answers 404 and changes nothing** — the 404 and "A's value is unchanged" are different
 * claims (§6.3 rule 4), so both are asserted. One further case proves the read path: the mark comes back
 * through `listSummaries`, because a mark that vanishes on reload is not an Update at all. That read runs
 * unfiltered as the owner's own session and is a persistence check only — never an authorization one.
 *
 * Oracle: the plan's Desired End State (the choice survives reload; B cannot mark A's summary) and the PRD
 * privacy guardrail (`prd.md:36-37`), enforced by `20260914120000_summaries_worth_watching.sql`.
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error(
    "update.db.int.test.ts requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY — set by the local " +
      "stack's .env and already validated by integration-setup.ts's globalSetup.",
  );
}

const admin = createAdminClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
// Seeding and stored-value read-back only. The pool is closed by `fetch-firewall.ts`'s `afterAll`.
const dbOwner = getDbOwnerConnection();

/** One id per scenario, so a leaked row from one test can never satisfy another's `unique (user_id, youtube_id)`. */
const UPDATE_YOUTUBE_IDS = {
  setMark: "dsupd0001",
  clearMark: "dsupd0002",
  crossAccountA: "dsupd0003",
  crossAccountB: "dsupd0004",
  readPath: "dsupd0005",
} as const;

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

function makePatchContext(account: SyntheticAccount, summaryId: string, worthWatching: boolean | null): APIContext {
  return {
    locals: { user: { id: account.userId } },
    params: { id: summaryId },
    request: new Request(`http://localhost/api/summaries/${summaryId}`, {
      method: "PATCH",
      headers: { Cookie: account.cookieHeader, "content-type": "application/json" },
      body: JSON.stringify({ worth_watching: worthWatching }),
    }),
    cookies: NOOP_COOKIES,
  } as unknown as APIContext;
}

/** What is stored — through the table-owner connection, not through any session. */
async function storedMark(summaryId: string): Promise<boolean | null> {
  const rows = await dbOwner<{ worth_watching: boolean | null }[]>`
    select worth_watching from summaries where id = ${summaryId}
  `;
  if (rows.length === 0) throw new Error(`storedMark: summary ${summaryId} does not exist`);
  return rows[0].worth_watching;
}

async function withSeededAccount(youtubeId: string, run: (seeded: SeededAccount) => Promise<void>): Promise<void> {
  const account = await createSyntheticAccount(admin);
  try {
    await run(await seed(account, youtubeId));
  } finally {
    await account.dispose();
  }
}

async function withTwoSeededAccounts(run: (a: SeededAccount, b: SeededAccount) => Promise<void>): Promise<void> {
  const accountA = await createSyntheticAccount(admin);
  try {
    const accountB = await createSyntheticAccount(admin);
    try {
      const a = await seed(accountA, UPDATE_YOUTUBE_IDS.crossAccountA);
      const b = await seed(accountB, UPDATE_YOUTUBE_IDS.crossAccountB);
      await run(a, b);
    } finally {
      await accountB.dispose();
    }
  } finally {
    await accountA.dispose();
  }
}

describe("PATCH /api/summaries/[id] against the real stack (S-14)", () => {
  it("sets the mark on the caller's own summary and it is stored", async () => {
    await withSeededAccount(UPDATE_YOUTUBE_IDS.setMark, async (seeded) => {
      expect(await storedMark(seeded.summaryId), "A freshly persisted summary must start unmarked.").toBeNull();

      const response = await PATCH(makePatchContext(seeded.account, seeded.summaryId, true));

      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toEqual({ ok: true, worthWatching: true });
      expect(await storedMark(seeded.summaryId)).toBe(true);
    });
  });

  it("clears a stored mark back to null", async () => {
    await withSeededAccount(UPDATE_YOUTUBE_IDS.clearMark, async (seeded) => {
      expect((await PATCH(makePatchContext(seeded.account, seeded.summaryId, false))).status).toBe(200);
      expect(await storedMark(seeded.summaryId)).toBe(false);

      const response = await PATCH(makePatchContext(seeded.account, seeded.summaryId, null));

      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toEqual({ ok: true, worthWatching: null });
      expect(
        await storedMark(seeded.summaryId),
        "Clicking the active option must return the summary to unmarked — a null that is dropped instead of " +
          "written leaves the old verdict in place and it reappears on reload.",
      ).toBeNull();
    });
  });

  it("404s when one account marks another's summary, and that summary's mark is unchanged", async () => {
    await withTwoSeededAccounts(async (a, b) => {
      const response = await PATCH(makePatchContext(b.account, a.summaryId, true));

      expect(response.status).toBe(404);
      await expect(readJson(response)).resolves.toEqual({ error: "Summary not found" });
      expect(
        await storedMark(a.summaryId),
        "Account A's mark changed after account B issued a PATCH against it. The owner-scoped UPDATE policy " +
          "(20260914120000) is the only thing standing between B and A's row.",
      ).toBeNull();
    });
  });

  it("returns the stored mark through the list read, so it survives a reload", async () => {
    await withSeededAccount(UPDATE_YOUTUBE_IDS.readPath, async (seeded) => {
      expect((await PATCH(makePatchContext(seeded.account, seeded.summaryId, false))).status).toBe(200);

      const session = createAppClient(new Headers({ Cookie: seeded.account.cookieHeader }), NOOP_COOKIES);
      if (!session) throw new Error("update.db.int.test.ts: createClient returned null");
      const items = await listSummaries(session as AppSupabaseClient);

      expect(
        items.map((item) => ({ id: item.id, worthWatching: item.worthWatching })),
        "The list read does not carry the stored mark. Both the dashboard SSR render and GET /api/summaries " +
          "go through listSummaries, so a mark missing here is a mark that vanishes on reload.",
      ).toEqual([{ id: seeded.summaryId, worthWatching: false }]);
    });
  });
});
