import { describe, expect, it, vi } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { APIContext, AstroCookies } from "astro";
import { createSyntheticAccount, type SyntheticAccount } from "@/test/synthetic-account";
import { DB_LAYER_YOUTUBE_IDS } from "@/test/synthetic-fixtures";
import { getDbOwnerConnection } from "@/test/db-owner";
import { defaultSummarizeResult, generateRequestBody, readJson } from "./__fixtures__/generation-harness";

/**
 * Real-database layer — balance invariants (plan Phase 5; test-plan risk #1's core).
 *
 * Unlike the stub layer (`generate.int.test.ts`), `@/lib/supabase` and `@/lib/supabase-admin` are
 * REAL here: each test signs a synthetic account in through the app's own `createServerClient` cookie
 * path (`synthetic-account.ts`), so `getBalance`'s RLS-scoped read runs against the actual local
 * Postgres, not an injected stand-in. Only `@/lib/services/llm` is mocked (never spend real LLM
 * credit, test-plan §7) — and, for exactly one test, `@/lib/supabase-admin` is mocked to a
 * fail-on-one-RPC proxy wrapping the SAME real client (see `withFailingRpc`).
 *
 * "No live vendor contact, ever" is upheld without touching `fetch` at all: every scenario seeds
 * `transcript_cache` AND `metadata_cache` directly via the same RPCs `generate.ts` itself calls, so
 * both Supadata checkpoints are cache HITS and the budget breaker (which a cache hit bypasses by
 * construction, D5) is never reached — `supadata_budget`'s singleton row is therefore untouched by
 * this file, matching the "identical row counts before/after" criterion for it.
 *
 * Oracle: `generate.ts`'s own reservation/refund contract (`generate.ts:774-972`), `credits.ts`'s
 * documented outcomes, and the RPC bodies in `20260720160000_credit_reservations.sql` /
 * `20260722120000_link_summary_to_reservation.sql` / `20260723120000_atomic_persist_summary.sql` —
 * cross-checked against the live database (`pg_get_functiondef`), not read off the branch under test.
 *
 * **A plan/reality mismatch, resolved from the source rather than pinned (impl-review.md F4).** The
 * plan's exit-#34 table claimed `already_persisted` answers 500. The RPC's own documented contract
 * says otherwise — "'already_persisted' — this reservation already produced a summary; **ids replayed**,
 * nothing written" (`20260723120000_atomic_persist_summary.sql:42`) — so a success status is what the
 * source calls for, and the plan's oracle was wrong. The genuine defect it exposed was narrower and is
 * now fixed: the endpoint used to ship THIS request's freshly-generated text under the EARLIER row's
 * `videoId`/`summaryId`. `generate.ts` now reads the replayed row back (`readStoredSummary`) so the
 * body is internally coherent. The test below asserts that coherence, which is the actual contract.
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error(
    "generate.db.int.test.ts requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY — set by the local " +
      "stack's .env and already validated by integration-setup.ts's globalSetup.",
  );
}

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
// Table-owner connection (src/test/db-owner.ts) for transcript_cache/metadata_cache/credit_reservations
// reads and writes below — those tables deliberately grant `service_role` no direct privileges
// (impl-review.md F2), so `admin` cannot reach them outside their SECURITY DEFINER RPCs.
const dbOwner = getDbOwnerConnection();

// ---------------------------------------------------------------------------------------------------
// Cache seeding/cleanup — the substitute for a real Supadata fetch. See the file header for why this,
// not `vi.stubGlobal("fetch", ...)`, is what keeps this layer vendor-free.
// ---------------------------------------------------------------------------------------------------

async function seedCaches(youtubeId: string, content: string): Promise<void> {
  const { error: transcriptError } = await admin.rpc("save_transcript_cache", {
    p_youtube_id: youtubeId,
    p_content: content,
    p_outcome: "ok",
    p_lang: "en",
    p_available_langs: ["en"],
    p_requested_lang: "en",
    p_resolved_via: "inline",
    p_fetch_duration_ms: 0,
    p_content_chars: null,
  });
  if (transcriptError) throw new Error(`seedCaches: save_transcript_cache failed: ${transcriptError.message}`);

  const { error: metadataError } = await admin.rpc("save_metadata_cache", {
    p_youtube_id: youtubeId,
    p_title: "Synthetic video",
    p_thumbnail_url_reported: null,
    p_channel_name: "Synthetic channel",
    p_channel_id: null,
    p_duration_seconds: 120,
    p_published_at: null,
  });
  if (metadataError) throw new Error(`seedCaches: save_metadata_cache failed: ${metadataError.message}`);
}

/** A cached `unavailable` transcript, for the charged-refusal-replay scenario. No metadata needed — refusal answers before that lookup. */
async function seedUnavailableTranscriptCache(youtubeId: string): Promise<void> {
  const { error } = await admin.rpc("save_transcript_cache", {
    p_youtube_id: youtubeId,
    p_content: "",
    p_outcome: "unavailable",
    p_lang: null,
    p_available_langs: null,
    p_requested_lang: "en",
    p_resolved_via: null,
    p_fetch_duration_ms: 0,
    p_content_chars: null,
  });
  if (error) throw new Error(`seedUnavailableTranscriptCache: ${error.message}`);
}

async function cleanupCaches(youtubeId: string): Promise<void> {
  await dbOwner`delete from transcript_cache where youtube_id = ${youtubeId}`;
  await dbOwner`delete from metadata_cache where youtube_id = ${youtubeId}`;
}

// ---------------------------------------------------------------------------------------------------
// Verification reads — the balance and ledger assertions ARE the test.
// ---------------------------------------------------------------------------------------------------

async function readBalance(userId: string): Promise<number | null> {
  const { data, error } = await admin.from("user_credits").select("balance").eq("user_id", userId).maybeSingle();
  if (error) throw new Error(`readBalance failed: ${error.message}`);
  // The admin client is supabase-js's untyped default (this repo has no generated Database types), so
  // `data` is `any` — same unavoidable gap `generate.ts`'s own RPC calls carry, not a fixable unsafe-return.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  return data?.balance ?? null;
}

async function reservationStatus(reservationId: string): Promise<string> {
  const rows = await dbOwner<{ status: string }[]>`select status from credit_reservations where id = ${reservationId}`;
  if (rows.length === 0) throw new Error(`reservationStatus: row not found for ${reservationId}`);
  return rows[0].status;
}

async function activeReservationId(userId: string): Promise<string> {
  const rows = await dbOwner<{ id: string }[]>`
    select id from credit_reservations where user_id = ${userId} and status = 'reserved' limit 1
  `;
  if (rows.length === 0) throw new Error(`activeReservationId: no 'reserved' row for ${userId}`);
  return rows[0].id;
}

/** The owner of a summary row, read through the table-owner connection — the check `readStoredSummary` itself does not make. */
async function summaryOwner(summaryId: string): Promise<string> {
  const rows = await dbOwner<{ user_id: string }[]>`select user_id from summaries where id = ${summaryId}`;
  if (rows.length === 0) throw new Error(`summaryOwner: no summaries row for ${summaryId}`);
  return rows[0].user_id;
}

async function summaryCountFor(reservationId: string): Promise<number> {
  const { count, error } = await admin
    .from("summaries")
    .select("id", { count: "exact", head: true })
    .eq("reservation_id", reservationId);
  if (error) throw new Error(`summaryCountFor: ${error.message}`);
  return count ?? 0;
}

// ---------------------------------------------------------------------------------------------------
// Loading the endpoint with ONLY llm.ts (always) and, for one test, supabase-admin (via a fail-on-one-
// RPC proxy) mocked. `@/lib/supabase` is never mocked — the synthetic account's Cookie header is what
// authenticates the RLS-scoped read.
// ---------------------------------------------------------------------------------------------------

async function loadRealEndpoint(
  options: { summarize?: ReturnType<typeof vi.fn>; admin?: SupabaseClient } = {},
): Promise<typeof import("./generate")> {
  vi.resetModules();
  // `vi.doMock` registrations OUTLIVE `resetModules()` — only the imported-module cache is cleared, not
  // the mock factory. Without this, a previous test's `options.admin` proxy (registered via `doMock`)
  // silently keeps standing in for every later call that omits `admin`, since nothing re-registers the
  // real module in between. Unmock first, every time, so the real `@/lib/supabase-admin` is what a
  // caller gets unless THIS call asks for the proxy.
  vi.doUnmock("@/lib/supabase-admin");
  const summarize = options.summarize ?? vi.fn().mockResolvedValue(defaultSummarizeResult());
  vi.doMock("@/lib/services/llm", () => ({ summarize }));
  if (options.admin) {
    const proxied = options.admin;
    vi.doMock("@/lib/supabase-admin", () => ({ createAdminClient: () => proxied }));
  }
  return import("./generate");
}

/** Wraps a real client so ONE named RPC fails while every other call (including on the SAME client) goes through for real. */
function withFailingRpc(real: SupabaseClient, failingFn: string, message: string): SupabaseClient {
  const handler: ProxyHandler<SupabaseClient> = {
    get(target, prop, receiver) {
      if (prop === "rpc") {
        return (fn: string, params?: Record<string, unknown>) => {
          if (fn === failingFn) {
            return Promise.resolve({ data: null, error: { message } });
          }
          return target.rpc(fn, params);
        };
      }
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return -- ProxyHandler.get's return type is `any` by the lib.es2015.proxy spec
      return Reflect.get(target, prop, receiver);
    },
  };
  return new Proxy(real, handler);
}

function makeDbContext(account: SyntheticAccount, body: unknown): APIContext {
  return {
    locals: { user: { id: account.userId } },
    request: new Request("http://localhost/api/summaries/generate", {
      method: "POST",
      headers: { "content-type": "application/json", Cookie: account.cookieHeader },
      body: JSON.stringify(body),
    }),
    cookies: {
      get: () => undefined,
      set: () => undefined,
      delete: () => undefined,
      has: () => false,
    } as unknown as AstroCookies,
  } as unknown as APIContext;
}

function youtubeUrl(id: string): string {
  return `https://www.youtube.com/watch?v=${id}`;
}

async function withAccount(youtubeId: string, run: (account: SyntheticAccount) => Promise<void>): Promise<void> {
  const account = await createSyntheticAccount(admin);
  try {
    await run(account);
  } finally {
    await cleanupCaches(youtubeId);
    await account.dispose([youtubeId]);
  }
}

/**
 * Two accounts for one scenario (plan Phase 3). Teardown is nested rather than sequential because
 * `dispose()` throws by design (impl-review.md F3): a sequential `await a.dispose(); await b.dispose();`
 * would let a failure on A leak B's `auth.users` row, which aborts the NEXT run's stale-account guard
 * instead of failing the test that caused it. The inner `finally` runs the user-agnostic
 * `cleanupCaches` once — both accounts share the one `youtube_id` — before either account goes, so
 * `supadata_calls` rows (`on delete set null`) never outlive the `auth.users` row they point at and
 * orphan into the ledger sums (test-plan §6.2).
 */
async function withTwoAccounts(
  youtubeId: string,
  run: (accountA: SyntheticAccount, accountB: SyntheticAccount) => Promise<void>,
): Promise<void> {
  const accountA = await createSyntheticAccount(admin);
  try {
    const accountB = await createSyntheticAccount(admin);
    try {
      await run(accountA, accountB);
    } finally {
      await cleanupCaches(youtubeId);
      await accountB.dispose([youtubeId]);
    }
  } finally {
    await accountA.dispose([youtubeId]);
  }
}

describe("charge-versus-delivery invariants (research.md §3, §5)", () => {
  it("success debits exactly the documented cost and settles", async () => {
    const youtubeId = DB_LAYER_YOUTUBE_IDS.success;
    await withAccount(youtubeId, async (account) => {
      await seedCaches(youtubeId, "a short synthetic transcript, well under the long threshold");
      const { POST } = await loadRealEndpoint();

      const response = await POST(
        makeDbContext(account, generateRequestBody({ url: youtubeUrl(youtubeId), requestId: crypto.randomUUID() })),
      );
      const json = (await readJson(response)) as { creditsRemaining: number; cost: number; summaryId: string };

      expect(response.status).toBe(200);
      expect(json.cost).toBe(1);
      expect(json.creditsRemaining).toBe(4);
      await expect(readBalance(account.userId)).resolves.toBe(4);
      const reservationId = await activeOrSettledReservationId(account.userId);
      await expect(reservationStatus(reservationId)).resolves.toBe("settled");
    });
  });

  it("an LLM failure debits then restores the balance", async () => {
    const youtubeId = DB_LAYER_YOUTUBE_IDS.llmFailure;
    await withAccount(youtubeId, async (account) => {
      await seedCaches(youtubeId, "a short synthetic transcript for the llm-failure case");
      const summarize = vi.fn().mockRejectedValue(new Error("synthetic llm failure"));
      const { POST } = await loadRealEndpoint({ summarize });

      const response = await POST(
        makeDbContext(account, generateRequestBody({ url: youtubeUrl(youtubeId), requestId: crypto.randomUUID() })),
      );

      expect(response.status).toBe(502);
      await expect(readBalance(account.userId)).resolves.toBe(5);
    });
  });

  it("a persistence failure likewise refunds", async () => {
    const youtubeId = DB_LAYER_YOUTUBE_IDS.persistFailure;
    await withAccount(youtubeId, async (account) => {
      await seedCaches(youtubeId, "a short synthetic transcript for the persist-failure case");
      const failingAdmin = withFailingRpc(admin, "persist_summary", "synthetic persistence failure");
      const { POST } = await loadRealEndpoint({ admin: failingAdmin });

      const response = await POST(
        makeDbContext(account, generateRequestBody({ url: youtubeUrl(youtubeId), requestId: crypto.randomUUID() })),
      );

      expect(response.status).toBe(500);
      await expect(readBalance(account.userId)).resolves.toBe(5);
    });
  });

  it("reports `insufficient` at a 1-credit balance against a 2-cost long video (the prose's omitted case)", async () => {
    const youtubeId = DB_LAYER_YOUTUBE_IDS.insufficientLong;
    await withAccount(youtubeId, async (account) => {
      // Explicit test setup for a NON-default balance — the account's initial 5 still came from the
      // trigger (createSyntheticAccount never sets it), this is a later, separate step.
      const { error: setBalanceError } = await admin
        .from("user_credits")
        .update({ balance: 1 })
        .eq("user_id", account.userId);
      if (setBalanceError) throw new Error(`failed to set balance for insufficient test: ${setBalanceError.message}`);

      await seedCaches(youtubeId, "x".repeat(50_000)); // > LONG_TRANSCRIPT_CHARS (40000) => cost 2
      const { POST } = await loadRealEndpoint();

      const response = await POST(
        makeDbContext(
          account,
          generateRequestBody({ url: youtubeUrl(youtubeId), requestId: crypto.randomUUID(), allowLong: true }),
        ),
      );
      const json = (await readJson(response)) as { error: string };

      expect(response.status).toBe(402);
      expect(json.error).toBe("You need 2 credits for this video; you have 1");
      await expect(readBalance(account.userId)).resolves.toBe(1); // untouched — the conditional decrement never fired
    });
  });

  it("replays the same requestId without a second debit or a second LLM call", async () => {
    const youtubeId = DB_LAYER_YOUTUBE_IDS.replay;
    await withAccount(youtubeId, async (account) => {
      await seedCaches(youtubeId, "a short synthetic transcript for the replay case");
      const summarize = vi.fn().mockResolvedValue(defaultSummarizeResult());
      const requestId = crypto.randomUUID();
      const body = generateRequestBody({ url: youtubeUrl(youtubeId), requestId });

      const first = await loadRealEndpoint({ summarize });
      const firstResponse = await first.POST(makeDbContext(account, body));
      const firstJson = (await readJson(firstResponse)) as { summaryId: string; creditsRemaining: number };
      expect(firstResponse.status).toBe(200);
      expect(firstJson.creditsRemaining).toBe(4);

      const second = await loadRealEndpoint({ summarize });
      const secondResponse = await second.POST(makeDbContext(account, body));
      const secondJson = (await readJson(secondResponse)) as { summaryId: string; creditsRemaining: number };

      expect(secondResponse.status).toBe(200);
      expect(secondJson.summaryId).toBe(firstJson.summaryId);
      expect(secondJson.creditsRemaining).toBe(4); // not debited again
      expect(summarize).toHaveBeenCalledTimes(1); // the replay never reaches the LLM call
      await expect(readBalance(account.userId)).resolves.toBe(4);
    });
  });

  it("a charged refusal replays as `charged: true` without a second charge", async () => {
    const youtubeId = DB_LAYER_YOUTUBE_IDS.chargedRefusalReplay;
    await withAccount(youtubeId, async (account) => {
      await seedUnavailableTranscriptCache(youtubeId);
      const requestId = crypto.randomUUID();
      const body = generateRequestBody({ url: youtubeUrl(youtubeId), requestId });

      const first = await loadRealEndpoint();
      const firstResponse = await first.POST(makeDbContext(account, body));
      const firstJson = (await readJson(firstResponse)) as { charged?: boolean };
      expect(firstResponse.status).toBe(422);
      expect(firstJson.charged).toBe(true);
      await expect(readBalance(account.userId)).resolves.toBe(4);

      const second = await loadRealEndpoint();
      const secondResponse = await second.POST(makeDbContext(account, body));
      const secondJson = (await readJson(secondResponse)) as { charged?: boolean };

      expect(secondResponse.status).toBe(422);
      expect(secondJson.charged).toBe(true);
      await expect(readBalance(account.userId)).resolves.toBe(4); // not charged twice
    });
  });
});

describe("exit #34 — persistSummaryAndSettle's ok:false fork, pinned by outcome, not as each other's negation (research.md §3)", () => {
  it("sweep-refunded (reconcile_reservation, no linked summary): 500, and the user is whole", async () => {
    const youtubeId = DB_LAYER_YOUTUBE_IDS.exit34SweepRefunded;
    await withAccount(youtubeId, async (account) => {
      await seedCaches(youtubeId, "a short synthetic transcript for the sweep-refund case");
      const summarize = vi.fn(async () => {
        const reservationId = await activeReservationId(account.userId);
        const { error } = await admin.rpc("reconcile_reservation", {
          target_user: account.userId,
          reservation: reservationId,
        });
        if (error) throw new Error(`reconcile_reservation failed: ${error.message}`);
        return defaultSummarizeResult();
      });
      const { POST } = await loadRealEndpoint({ summarize });

      const response = await POST(
        makeDbContext(account, generateRequestBody({ url: youtubeUrl(youtubeId), requestId: crypto.randomUUID() })),
      );

      expect(response.status).toBe(500);
      await expect(readBalance(account.userId)).resolves.toBe(5); // whole
    });
  });

  it("operator-settled (settle_reservation, no summary): 500, and the balance stays down", async () => {
    const youtubeId = DB_LAYER_YOUTUBE_IDS.exit34OperatorSettled;
    await withAccount(youtubeId, async (account) => {
      await seedCaches(youtubeId, "a short synthetic transcript for the operator-settle case");
      const summarize = vi.fn(async () => {
        const reservationId = await activeReservationId(account.userId);
        const { error } = await admin.rpc("settle_reservation", {
          target_user: account.userId,
          reservation: reservationId,
        });
        if (error) throw new Error(`settle_reservation failed: ${error.message}`);
        return defaultSummarizeResult();
      });
      const { POST } = await loadRealEndpoint({ summarize });

      const response = await POST(
        makeDbContext(account, generateRequestBody({ url: youtubeUrl(youtubeId), requestId: crypto.randomUUID() })),
      );

      expect(response.status).toBe(500);
      await expect(readBalance(account.userId)).resolves.toBe(4); // the genuine charge-without-delivery
    });
  });

  it("already_persisted (a summary already cites this reservation): 200 replaying THAT row — ids and text agree", async () => {
    const youtubeId = DB_LAYER_YOUTUBE_IDS.exit34AlreadyPersisted;
    await withAccount(youtubeId, async (account) => {
      await seedCaches(youtubeId, "a short synthetic transcript for the already-persisted case");
      const outOfBandContent = "out-of-band content, persisted before this request's own persist_summary call";
      let outOfBandSummaryId: string | undefined;
      let outOfBandVideoId: string | undefined;

      const summarize = vi.fn(async () => {
        const reservationId = await activeReservationId(account.userId);
        const { data, error } = (await admin.rpc("persist_summary", {
          target_user: account.userId,
          reservation: reservationId,
          p_url: youtubeUrl(youtubeId),
          p_youtube_id: youtubeId,
          p_character: "informational",
          p_content: outOfBandContent,
          p_model: "synthetic-out-of-band-model",
          p_resolved_via: "stored",
          p_title: null,
          p_thumbnail_url_reported: null,
          p_channel_name: null,
          p_channel_id: null,
          p_duration_seconds: null,
          p_published_at: null,
          p_transcript_lang: null,
          p_transcript_available_langs: null,
          p_transcript_chars: null,
          p_generation_ms: null,
          p_transcript_ms: null,
          p_llm_ms: null,
          p_metadata_ms: null,
          p_cost_usd: null,
          p_prompt_tokens: null,
          p_completion_tokens: null,
          p_metadata_via: null,
        })) as {
          data: { outcome: string; video_id: string; summary_id: string }[] | null;
          error: { message: string } | null;
        };
        if (error || !data || data.length === 0) {
          throw new Error(`out-of-band persist_summary failed: ${error?.message ?? "no row"}`);
        }
        outOfBandVideoId = data[0].video_id;
        outOfBandSummaryId = data[0].summary_id;
        return defaultSummarizeResult();
      });
      const { POST } = await loadRealEndpoint({ summarize });

      const response = await POST(
        makeDbContext(account, generateRequestBody({ url: youtubeUrl(youtubeId), requestId: crypto.randomUUID() })),
      );
      const json = (await readJson(response)) as { summary: string; model: string; videoId: string; summaryId: string };

      // The RPC replays the existing row's ids and writes nothing, so this is a success, not a failure
      // (`20260723120000_atomic_persist_summary.sql:42`) — the plan's claimed 500 contradicted its own
      // source. See the file header.
      expect(response.status).toBe(200);
      // The ids in the response are the EARLIER, out-of-band row's — not a fresh one.
      expect(json.videoId).toBe(outOfBandVideoId);
      expect(json.summaryId).toBe(outOfBandSummaryId);
      // THE POINT OF THIS TEST (impl-review.md F4): the body is internally coherent. `summary` is the
      // content of the row `summaryId` names — not this request's own freshly-generated text, which
      // belongs to no row at all. Asserted positively AND against the discarded text, so a regression
      // that reverts to shipping `summary.text` fails here rather than passing by omission.
      expect(json.summary).toBe(outOfBandContent);
      expect(json.summary).not.toBe(defaultSummarizeResult().text);
      expect(json.model).toBe("synthetic-out-of-band-model");
      // Only the ONE debit from begin_generation ever happened — the out-of-band persist_summary call
      // does not touch the balance.
      await expect(readBalance(account.userId)).resolves.toBe(4);
      await expect(summaryCountFor(await activeOrSettledReservationId(account.userId))).resolves.toBe(1);
    });
  });
});

describe("cross-account replay boundary (test-plan risk #4; plan Phase 3)", () => {
  /**
   * `readStoredSummary` (`summaries.ts:387-404`) reads a summary by id through the ADMIN client — RLS
   * bypassed, no `user_id` predicate. Nothing in that function keeps one account off another's row;
   * what does is that the id it is handed was derived double-scoped, `where cr.user_id = target_user
   * and cr.request_id = request` (`20260723130000_idempotent_generation.sql:123-128,143-144`), and that
   * the partial unique index behind it is on `(user_id, request_id)` — not on `request_id` alone
   * (`20260723130000:48-50`). Until now that was an argument. This is the evidence.
   *
   * Oracle: the PRD privacy guardrail (`prd.md:36-37`) plus `begin_generation`'s own documented lookup,
   * read from the migration rather than from `generate.ts`. A `requestId` is client-supplied, so two
   * accounts colliding on one is not exotic — a shared UUID, a copied cURL, a retry replayed from
   * another session. The contract is that the key is scoped to its owner: B's POST must be a FRESH
   * generation, not a replay of A's.
   */
  it("two accounts posting the SAME requestId each generate their own summary, and neither sees the other's", async () => {
    const youtubeId = DB_LAYER_YOUTUBE_IDS.crossAccountReplay;
    await withTwoAccounts(youtubeId, async (accountA, accountB) => {
      await seedCaches(youtubeId, "a short synthetic transcript for the cross-account replay case");

      // Per-call distinguishable text: the whole point is that a leak would be VISIBLE in the body.
      // Identical content would let a genuine cross-account replay pass unnoticed.
      const contentA = "# Account A's summary\n\n- a point only A generated";
      const contentB = "# Account B's summary\n\n- a point only B generated";
      const texts = [contentA, contentB];
      let callIndex = 0;
      const summarize = vi.fn(() => {
        const text = texts[Math.min(callIndex, texts.length - 1)];
        callIndex += 1;
        return Promise.resolve({ ...defaultSummarizeResult(), text });
      });

      // ONE key, submitted by BOTH accounts — the collision under test.
      const requestId = crypto.randomUUID();
      const body = generateRequestBody({ url: youtubeUrl(youtubeId), requestId });

      const endpointA = await loadRealEndpoint({ summarize });
      const responseA = await endpointA.POST(makeDbContext(accountA, body));
      const jsonA = (await readJson(responseA)) as {
        summary: string;
        videoId: string;
        summaryId: string;
        creditsRemaining: number;
      };
      expect(responseA.status).toBe(200);
      expect(jsonA.summary).toBe(contentA);
      expect(jsonA.creditsRemaining).toBe(4);

      const endpointB = await loadRealEndpoint({ summarize });
      const responseB = await endpointB.POST(makeDbContext(accountB, body));
      const jsonB = (await readJson(responseB)) as {
        summary: string;
        videoId: string;
        summaryId: string;
        creditsRemaining: number;
      };

      expect(responseB.status).toBe(200);
      // B's body is B's own work, asserted positively AND against A's — so a regression that replays
      // A's row fails here rather than passing by omission.
      expect(jsonB.summary).toBe(contentB);
      expect(jsonB.summary).not.toBe(contentA);
      expect(jsonB.summaryId).not.toBe(jsonA.summaryId);
      expect(jsonB.videoId).not.toBe(jsonA.videoId);
      // The id in B's body names a row B owns — the ownership check `readStoredSummary` does not make.
      await expect(summaryOwner(jsonB.summaryId)).resolves.toBe(accountB.userId);
      await expect(summaryOwner(jsonA.summaryId)).resolves.toBe(accountA.userId);
      // B was DEBITED: a replay costs nothing (see the same-account replay case above), so a balance
      // still at 5 would mean B's request resolved against A's reservation instead of opening its own.
      expect(jsonB.creditsRemaining).toBe(4);
      await expect(readBalance(accountB.userId)).resolves.toBe(4);
      await expect(readBalance(accountA.userId)).resolves.toBe(4);
      // Twice, not once: the second POST reached the LLM call, which a replay never does.
      expect(summarize).toHaveBeenCalledTimes(2);
    });
  });
});

/**
 * After a SUCCESSFUL generation the reservation is 'settled', so `activeReservationId` (which only
 * matches 'reserved') can no longer find it. Falls back to the most recent reservation for the user —
 * safe here because each test's account is single-use and this runs only after the one debit a test
 * performs.
 */
async function activeOrSettledReservationId(userId: string): Promise<string> {
  const rows = await dbOwner<{ id: string }[]>`
    select id from credit_reservations where user_id = ${userId} order by created_at desc limit 1
  `;
  if (rows.length === 0) throw new Error(`activeOrSettledReservationId: no reservation found for ${userId}`);
  return rows[0].id;
}
