import { afterEach, describe, expect, it, vi } from "vitest";
import {
  beginRow,
  createFakeAdmin,
  createFakeSupabase,
  defaultAdminScript,
  defaultSummarizeResult,
  fail,
  generateRequestBody,
  loadEndpoint,
  makeContext,
  ok,
  persistRow,
  readJson,
  stubSupadataFetch,
  SYNTHETIC_USER_ID,
  type FakeAdmin,
  type RpcHandler,
} from "./__fixtures__/generation-harness";
import type { ReportedEvent } from "@/lib/services/reporting";
import { expectPromotedEvent } from "@/lib/services/__fixtures__/reporting-recorder";
import {
  supadataMetadataOk,
  supadataTranscriptOk,
  supadataTranscriptUnavailable206,
} from "@/lib/services/__fixtures__/supadata-responses";

/**
 * Stub layer — trust boundary, preflight ordering, and the refusal exits' charged signals (plan Phase
 * 4, items 1-2; test-plan risks #1 and #5). Every seam is mocked per `generation-harness.ts`: the two
 * client constructors, `llm.ts`, and the global `fetch` for Supadata traffic. No database connection —
 * `admin.rpc` and `supabase.from(...)` are scripted in-memory.
 *
 * Oracle: `generate.ts`'s own documented contracts — the preflight ordering comment (`generate.ts:110-
 * 125`), `REFUSAL_COPY` and `refusalResponse`'s `ambiguousCharge` shape (`generate.ts:83-94,231-237`),
 * and `refuseAndCharge`'s outcome mapping (`generate.ts:274-294`) — cross-checked against research.md
 * §2.3 and §4, not read off the branch under test.
 *
 * The `creditsRemaining` cases below cover the ABSENCE half of the balance rule plus the pass-through,
 * because neither needs a real balance: a scripted `new_balance` is a stronger oracle than a real one
 * for "the endpoint forwards the ledger's number rather than computing its own". That a real debit
 * really produces that number is the real-database layer's job (`generate.db.int.test.ts`), per
 * test-plan §6.2's split.
 */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function cachedTranscriptRow(
  outcome: "unavailable" | "empty" | "ok" | "too_long",
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    content: outcome === "ok" ? "cached transcript content" : "",
    outcome,
    lang: null,
    available_langs: null,
    resolved_via: null,
    fetched_at: new Date(0).toISOString(),
    ...overrides,
  };
}

// The three configuration 503s keep three distinct `error` strings and deliberately SHARE one
// `code`. That is not a leak in the distinction — the strings are what an operator reads in a log and
// they still say which secret is missing, while the code drives what a USER is told, and a user can
// do exactly nothing different about any of the three. The 503 split that does matter to a user is
// preserved by a separate code: `budgetExhausted` means "come back shortly", `notConfigured` means
// "this is broken", and telling those apart is why the client used to prefer the server's string.
describe("trust boundary — preflight exits (research.md §2.3, both 503s land before the 401)", () => {
  it("503s distinctly when a vendor key is unset — the FIRST preflight, before the admin client exists", async () => {
    const { POST } = await loadEndpoint({ env: { SUPADATA_API_KEY: null } });

    const response = await POST(makeContext({ body: generateRequestBody() }));

    expect(response.status).toBe(503);
    await expect(readJson(response)).resolves.toEqual({
      error: "Transcript/LLM services are not configured",
      code: "notConfigured",
    });
  });

  it("503s distinctly when the admin client cannot be built — a different message, same status", async () => {
    const { POST } = await loadEndpoint({ admin: null });

    const response = await POST(makeContext({ body: generateRequestBody() }));

    expect(response.status).toBe(503);
    await expect(readJson(response)).resolves.toEqual({
      error: "Summary generation is not configured",
      code: "notConfigured",
    });
  });

  it("reaches that SAME 503 from a missing SUPABASE_SERVICE_ROLE_KEY, through the real createAdminClient", async () => {
    // The test above hands the endpoint `admin: null` outright, which proves generate.ts's null branch
    // but not what produces the null. This one leaves `@/lib/supabase-admin` unmocked and unsets the
    // secret, so the assertion runs the whole documented chain — `astro:env/server` → the REAL
    // `createAdminClient()` (`supabase-admin.ts:15`) → the 503 (impl-review.md F8). It is the wiring a
    // deploy missing the Worker secret actually exercises, and the README's stated consequence
    // ("skip it and both endpoints return 503") is the oracle.
    const { POST } = await loadEndpoint({ realAdminModule: true, env: { SUPABASE_SERVICE_ROLE_KEY: null } });

    const response = await POST(makeContext({ body: generateRequestBody() }));

    expect(response.status).toBe(503);
    await expect(readJson(response)).resolves.toEqual({
      error: "Summary generation is not configured",
      code: "notConfigured",
    });
  });

  it("and does NOT 503 through that real constructor once the service-role key IS set", async () => {
    // The companion to the test above, and the reason it isn't vacuous: `admin` defaults to null, so a
    // `realAdminModule` that silently did nothing would still produce the 503 and look green. Here the
    // secret is present, so the REAL createAdminClient must return a client and the endpoint must move
    // past both preflights — reaching the 401 for the unauthenticated caller instead. If the real
    // module were still being mocked away, this would 503 and fail.
    const { POST } = await loadEndpoint({ realAdminModule: true });

    const response = await POST(makeContext({ user: null, body: generateRequestBody() }));

    expect(response.status).toBe(401);
    await expect(readJson(response)).resolves.toEqual({ error: "Unauthorized" });
  });

  it("401s an unauthenticated caller once both preflights pass", async () => {
    const admin = createFakeAdmin();
    const { POST } = await loadEndpoint({ admin: admin.client });

    const response = await POST(makeContext({ user: null, body: generateRequestBody() }));

    expect(response.status).toBe(401);
    await expect(readJson(response)).resolves.toEqual({ error: "Unauthorized" });
  });

  it("an unauthenticated caller can still distinguish a service-unconfigured 503 from a 401 — the ordering finding", async () => {
    // Both 503 preflights run BEFORE the 401 check (generate.ts:110-125). Proven here by omitting a
    // vendor key on a request with NO authenticated user and seeing 503, not 401.
    const { POST } = await loadEndpoint({ env: { SUPADATA_API_KEY: null } });

    const response = await POST(makeContext({ user: null, body: generateRequestBody() }));

    expect(response.status).toBe(503);
  });
});

describe("trust boundary — schema rejections (risk #5: the server refuses what the UI would never send)", () => {
  async function postBody(body: unknown): Promise<Response> {
    const admin = createFakeAdmin();
    const { POST } = await loadEndpoint({ admin: admin.client });
    return POST(makeContext({ body }));
  }

  it("400s a missing requestId — required at the schema boundary", async () => {
    const response = await postBody(generateRequestBody({ requestId: null }));

    expect(response.status).toBe(400);
    const json = (await readJson(response)) as { error: string };
    expect(json.error).toMatch(/requestId/);
  });

  it("400s a malformed requestId that is not a UUID", async () => {
    const response = await postBody(generateRequestBody({ requestId: "not-a-uuid" }));

    expect(response.status).toBe(400);
  });

  it("400s a character outside the enum", async () => {
    const response = await postBody(generateRequestBody({ character: "entertaining" }));

    expect(response.status).toBe(400);
    const json = (await readJson(response)) as { error: string };
    expect(json.error).toMatch(/character/);
  });

  it("400s a non-web URL scheme — new URL() parses it, but it names no YouTube video", async () => {
    const response = await postBody(generateRequestBody({ url: "ftp://example.com/video" }));

    expect(response.status).toBe(400);
    const json = (await readJson(response)) as { error: string };
    expect(json.error).toMatch(/YouTube/);
  });
});

describe("trust boundary — allowLong sent unprompted is pre-authorization, not a free pass on cost", () => {
  it("skips the 409 confirmation but the debit still uses the real, higher cost", async () => {
    const admin = createFakeAdmin(defaultAdminScript());
    admin.queue("begin_generation", ok([beginRow({ outcome: "fresh" })])); // the idempotency probe
    admin.queue(
      "begin_generation",
      ok([beginRow({ outcome: "reserved", reservation_id: "res-debit", new_balance: 3 })]),
    );
    admin.queue("persist_summary", ok([persistRow()]));
    const supabase = createFakeSupabase(5);
    // > LONG_TRANSCRIPT_CHARS (40000), so summaryCost() prices this at 2, not 1.
    const longTranscript = "x".repeat(50_000);
    stubSupadataFetch({
      transcript: () => supadataTranscriptOk({ content: longTranscript }),
      metadata: () => supadataMetadataOk(),
    });

    const { POST } = await loadEndpoint({ admin: admin.client, supabase });
    const response = await POST(makeContext({ body: generateRequestBody({ allowLong: true }) }));

    expect(response.status).toBe(200); // not 409 — allowLong pre-authorized the confirmation
    const debitCall = admin.callsTo("begin_generation")[1];
    expect(debitCall.params).toMatchObject({ amount: 2 });
  });
});

describe("refusal exits — each charges (or doesn't) exactly as chargeFailedTranscript's outcome says", () => {
  it("charges a cached `unavailable` refusal", async () => {
    const admin = createFakeAdmin({
      ...defaultAdminScript(),
      get_transcript_cache: [ok([cachedTranscriptRow("unavailable")])],
      charge_failed_transcript: [ok([{ outcome: "charged", new_balance: 4 }])],
    });
    admin.queue("begin_generation", ok([beginRow({ outcome: "fresh" })]));
    const supabase = createFakeSupabase(5);
    const { POST } = await loadEndpoint({ admin: admin.client, supabase });

    const response = await POST(makeContext({ body: generateRequestBody() }));
    const json = (await readJson(response)) as { error: string; charged?: boolean };

    expect(response.status).toBe(422);
    expect(json.charged).toBe(true);
    expect(typeof json.error).toBe("string");
    expect(admin.callsTo("charge_failed_transcript")[0].params).toMatchObject({
      p_refusal_reason: "unavailable",
      p_amount: 1,
    });
  });

  it("charges a cached `empty` refusal", async () => {
    const admin = createFakeAdmin({
      ...defaultAdminScript(),
      get_transcript_cache: [ok([cachedTranscriptRow("empty")])],
      charge_failed_transcript: [ok([{ outcome: "charged", new_balance: 4 }])],
    });
    admin.queue("begin_generation", ok([beginRow({ outcome: "fresh" })]));
    const supabase = createFakeSupabase(5);
    const { POST } = await loadEndpoint({ admin: admin.client, supabase });

    const response = await POST(makeContext({ body: generateRequestBody() }));
    const json = (await readJson(response)) as { error: string; charged?: boolean };

    expect(response.status).toBe(422);
    expect(json.charged).toBe(true);
    expect(admin.callsTo("charge_failed_transcript")[0].params).toMatchObject({ p_refusal_reason: "empty" });
  });

  it("charges a FRESH fetch's `unavailable` outcome — the 206 we just paid a Supadata credit for", async () => {
    const admin = createFakeAdmin({
      ...defaultAdminScript(),
      charge_failed_transcript: [ok([{ outcome: "charged", new_balance: 4 }])],
    });
    admin.queue("begin_generation", ok([beginRow({ outcome: "fresh" })]));
    const supabase = createFakeSupabase(5);
    stubSupadataFetch({ transcript: () => supadataTranscriptUnavailable206() });
    const { POST } = await loadEndpoint({ admin: admin.client, supabase });

    const response = await POST(makeContext({ body: generateRequestBody() }));
    const json = (await readJson(response)) as { error: string; charged?: boolean };

    expect(response.status).toBe(422);
    expect(json.charged).toBe(true);
    expect(admin.callsTo("charge_failed_transcript")[0].params).toMatchObject({ p_refusal_reason: "unavailable" });
    // The paid 206 is cached negative, so a re-submit within the window answers free.
    expect(admin.callsTo("save_transcript_cache")[0].params).toMatchObject({ p_outcome: "unavailable" });
  });

  it("charges a whitespace-only transcript, distinct from a cached `empty` row", async () => {
    const admin = createFakeAdmin({
      ...defaultAdminScript(),
      charge_failed_transcript: [ok([{ outcome: "charged", new_balance: 4 }])],
    });
    admin.queue("begin_generation", ok([beginRow({ outcome: "fresh" })]));
    const supabase = createFakeSupabase(5);
    stubSupadataFetch({ transcript: () => supadataTranscriptOk({ content: "   \n\t  " }) });
    const { POST } = await loadEndpoint({ admin: admin.client, supabase });

    const response = await POST(makeContext({ body: generateRequestBody() }));
    const json = (await readJson(response)) as { error: string; charged?: boolean };

    expect(response.status).toBe(422);
    expect(json.charged).toBe(true);
    expect(admin.callsTo("charge_failed_transcript")[0].params).toMatchObject({ p_refusal_reason: "whitespace" });
    // The fetch outcome cached is `empty` (a vendor SUCCESS on wordless content) — a different fact
    // from the `whitespace` reason this refusal is charged under, per D3's split.
    expect(admin.callsTo("save_transcript_cache")[0].params).toMatchObject({ p_outcome: "empty" });
  });

  it.each(["failed", "timeout"] as const)(
    "does NOT charge the transient `%s` transcript outcome — cost is unknown, not zero",
    async (reason) => {
      const admin = createFakeAdmin(defaultAdminScript());
      admin.queue("begin_generation", ok([beginRow({ outcome: "fresh" })]));
      const supabase = createFakeSupabase(5);
      const fetchTranscript = vi.fn().mockResolvedValue({ ok: false, reason });
      const { POST } = await loadEndpoint({ admin: admin.client, supabase, fetchTranscript });

      const response = await POST(makeContext({ body: generateRequestBody() }));
      const json = (await readJson(response)) as Record<string, unknown>;

      expect(response.status).toBe(422);
      expect(json.charged).toBe(false);
      expect(admin.callsTo("charge_failed_transcript")).toHaveLength(0);
      // Transient outcomes are never cached — D3/D4 only cache the durable `unavailable` verdict.
      expect(admin.callsTo("save_transcript_cache")).toHaveLength(0);
      // No ledger call means no balance was read, and the rule is report-what-you-know: the client
      // keeps the number it already had, which is still correct because nothing moved.
      expect(json).not.toHaveProperty("creditsRemaining");
    },
  );

  // The other half of the balance rule, and the shape the value tests cannot reach: the charge was
  // ATTEMPTED and its statement rolled back, so `charged: false` is provable while the balance is
  // simply unknown. An endpoint that answered 0 here — or echoed the pre-attempt balance — would be
  // making up a number about someone's money on the one path that learned nothing.
  it("omits `creditsRemaining` when the charge rolled back, though it can still prove `charged: false`", async () => {
    const admin = createFakeAdmin({
      ...defaultAdminScript(),
      get_transcript_cache: [ok([cachedTranscriptRow("unavailable")])],
      charge_failed_transcript: [fail('relation "credit_reservations" does not exist')],
    });
    admin.queue("begin_generation", ok([beginRow({ outcome: "fresh" })]));
    const supabase = createFakeSupabase(5);
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { POST } = await loadEndpoint({ admin: admin.client, supabase });

    const response = await POST(makeContext({ body: generateRequestBody() }));
    const json = (await readJson(response)) as Record<string, unknown>;

    expect(response.status).toBe(422);
    expect(json.charged).toBe(false);
    expect(json).not.toHaveProperty("creditsRemaining");
    spy.mockRestore();
  });

  // The pass-through, pinned by a number the endpoint could not have produced on its own. The account
  // holds 5 credits, so anything that recomputed the post-charge balance locally would answer 4; only
  // forwarding `chargeFailedTranscript`'s `new_balance` yields 41. That is the whole contract — the
  // ledger owns the arithmetic, the endpoint owns nothing but the wire.
  it("forwards the LEDGER's balance as `creditsRemaining`, never a number of its own", async () => {
    const admin = createFakeAdmin({
      ...defaultAdminScript(),
      get_transcript_cache: [ok([cachedTranscriptRow("unavailable")])],
      charge_failed_transcript: [ok([{ outcome: "charged", new_balance: 41 }])],
    });
    admin.queue("begin_generation", ok([beginRow({ outcome: "fresh" })]));
    const supabase = createFakeSupabase(5);
    const { POST } = await loadEndpoint({ admin: admin.client, supabase });

    const response = await POST(makeContext({ body: generateRequestBody() }));
    const json = (await readJson(response)) as { charged?: boolean; creditsRemaining?: number };

    expect(response.status).toBe(422);
    expect(json.charged).toBe(true);
    expect(json.creditsRemaining).toBe(41);
  });

  it("reports the ambiguous shape by its own fields — never `charged: false`", async () => {
    const admin = createFakeAdmin({
      ...defaultAdminScript(),
      get_transcript_cache: [ok([cachedTranscriptRow("unavailable")])],
      charge_failed_transcript: [ok([])], // an empty row set: the statement ran, the outcome is unknown
    });
    admin.queue("begin_generation", ok([beginRow({ outcome: "fresh" })]));
    const supabase = createFakeSupabase(5);
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const events: ReportedEvent[] = [];
    const { POST } = await loadEndpoint({ admin: admin.client, supabase, events });

    const response = await POST(makeContext({ body: generateRequestBody() }));
    const json = (await readJson(response)) as Record<string, unknown>;

    expect(response.status).toBe(422);
    expect(json.ambiguousCharge).toBe(true);
    expect(json).not.toHaveProperty("charged");
    // Silent about the balance for the same reason it is silent about `charged`: the statement may
    // have committed, so any number here could already be one credit stale.
    expect(json).not.toHaveProperty("creditsRemaining");
    // The user is told to retry; the OPERATOR is told which row to check (S-13 Phase 4). This is the
    // scenario the reconciliation family was built for, so it is asserted end to end through the
    // endpoint rather than only against `credits.ts` in isolation.
    expectPromotedEvent(events, {
      key: "[charge-ambiguous:no-row]",
      severity: "error",
      fields: ["userId", "requestId", "refusalReason"],
    });
    spy.mockRestore();
  });

  // The localisation contract at the wire. `error` is what a log or an untranslated consumer reads;
  // `code` is what the UI localises, and the two 422s that deliberately SHARE an English string must
  // not share a code — a video with no captions (charged, permanent) and a vendor outage (free,
  // retryable) are different things to tell a user, and before codes existed the client had no way
  // to say so in Polish. Which sentence each code renders is `useGenerateSummary.test.ts`'s job.
  it.each([
    ["unavailable", "noCaptions", "the caption-specific claim D3 keeps distinct"],
    ["empty", "transcriptUnavailable", "a transcript arrived and holds no words — one thing to say"],
  ] as const)("sends code `%s` → `%s`: %s", async (outcome, expectedCode, _why) => {
    const admin = createFakeAdmin({
      ...defaultAdminScript(),
      get_transcript_cache: [ok([cachedTranscriptRow(outcome)])],
      charge_failed_transcript: [ok([{ outcome: "charged", new_balance: 4 }])],
    });
    admin.queue("begin_generation", ok([beginRow({ outcome: "fresh" })]));
    const supabase = createFakeSupabase(5);
    const { POST } = await loadEndpoint({ admin: admin.client, supabase });

    const response = await POST(makeContext({ body: generateRequestBody() }));
    const json = (await readJson(response)) as { code?: string; error?: string };

    expect(response.status).toBe(422);
    expect(json.code).toBe(expectedCode);
    // The English string stays on the body beside the code, never replaced by it.
    expect(typeof json.error).toBe("string");
  });

  it.each(["failed", "timeout"] as const)(
    "sends the transient `%s` exit its OWN code, though it shares the generic English string",
    async (reason) => {
      const admin = createFakeAdmin(defaultAdminScript());
      admin.queue("begin_generation", ok([beginRow({ outcome: "fresh" })]));
      const supabase = createFakeSupabase(5);
      const fetchTranscript = vi.fn().mockResolvedValue({ ok: false, reason });
      const { POST } = await loadEndpoint({ admin: admin.client, supabase, fetchTranscript });

      const response = await POST(makeContext({ body: generateRequestBody() }));
      const json = (await readJson(response)) as { code?: string };

      expect(response.status).toBe(422);
      expect(json.code).toBe("transcriptFetchFailed");
    },
  );

  it("REFUSAL_COPY differs between `unavailable` and the generic reasons, and is stable within a group", async () => {
    async function bodyFor(outcome: "unavailable" | "empty"): Promise<{ error: string }> {
      const admin = createFakeAdmin({
        ...defaultAdminScript(),
        get_transcript_cache: [ok([cachedTranscriptRow(outcome)])],
        charge_failed_transcript: [ok([{ outcome: "charged", new_balance: 4 }])],
      });
      admin.queue("begin_generation", ok([beginRow({ outcome: "fresh" })]));
      const supabase = createFakeSupabase(5);
      const { POST } = await loadEndpoint({ admin: admin.client, supabase });
      const response = await POST(makeContext({ body: generateRequestBody() }));
      return (await readJson(response)) as { error: string };
    }

    const unavailableBody = await bodyFor("unavailable");
    const emptyBody = await bodyFor("empty");

    expect(unavailableBody.error).not.toBe(emptyBody.error);
  });
});

/**
 * Paid-path integrity reaches the operator (S-13 Phase 4).
 *
 * Oracle: the plan's Promotion Roster ("charge and delivery can end up out of step") and `reporting.ts`'s
 * PERSONAL DATA contract, under which this family carries the failing detail and no account identifier.
 * Every one of these exits is SWALLOWED into a 500 or 502 rather than thrown, so `withSentry`'s
 * automatic capture never sees them — and the response-level suites above stay green with every
 * `captureEvent` in `generate.ts` deleted.
 *
 * One row per stage, driven through the harness's existing seams: the scripted `admin.rpc`, the mocked
 * `summarize`, and the Supadata `fetch` stub. The recording sink goes in through `loadEndpoint`'s
 * `events` option, never a top-level `setReportingSink` — see that option for why.
 */
describe("paid-path integrity — every swallowed failure past the debit reaches the operator under its own key", () => {
  interface Arranged {
    admin: FakeAdmin;
    summarize: ReturnType<typeof vi.fn>;
  }

  function summarizing(): ReturnType<typeof vi.fn> {
    return vi.fn().mockResolvedValue(defaultSummarizeResult());
  }

  /** An ordinary run up to and including a successful debit; `script` supplies the stage under test. */
  function debitedAdmin(script: Record<string, RpcHandler[]>): FakeAdmin {
    const admin = createFakeAdmin({ ...defaultAdminScript(), ...script });
    admin.queue(
      "begin_generation",
      ok([beginRow({ outcome: "fresh" })]), // the idempotency probe
      ok([beginRow({ outcome: "reserved", reservation_id: "res-debit", new_balance: 4 })]),
    );
    return admin;
  }

  /** `readStoredSummary` reads through the query builder, which the scripted admin fake does not carry. */
  function withFailingSummaryRead(admin: FakeAdmin): FakeAdmin {
    const maybeSingle = (): Promise<unknown> =>
      Promise.resolve({ data: null, error: { message: "synthetic summary read failure" } });
    Object.assign(admin.client, { from: () => ({ select: () => ({ eq: () => ({ maybeSingle }) }) }) });
    return admin;
  }

  const rows: [key: string, why: string, arrange: () => Arranged, fields: string[]][] = [
    [
      "[paid-path:begin]",
      "the debiting call itself failed, so the endpoint cannot say what it did to the balance",
      () => {
        const admin = createFakeAdmin(defaultAdminScript());
        admin.queue(
          "begin_generation",
          ok([beginRow({ outcome: "fresh" })]), // the idempotency probe passes
          fail("synthetic begin_generation failure"), // the debit does not
        );
        return { admin, summarize: summarizing() };
      },
      ["error"],
    ],
    [
      "[paid-path:summarize]",
      "debited, then the paid LLM call failed — nothing was delivered",
      () => ({
        admin: debitedAdmin({ refund_reservation: [ok(true)] }),
        summarize: vi.fn().mockRejectedValue(new Error("synthetic llm failure")),
      }),
      ["error"],
    ],
    [
      "[paid-path:persist]",
      "a finished, paid-for summary could not be saved",
      () => ({
        admin: debitedAdmin({ persist_summary: [fail("synthetic persist failure")], refund_reservation: [ok(true)] }),
        summarize: summarizing(),
      }),
      ["error"],
    ],
    [
      "[paid-path:persist-skipped]",
      "the reservation was closed under a running request, so its summary belongs to no row",
      () => ({
        admin: debitedAdmin({
          persist_summary: [ok([persistRow({ outcome: "not_reserved", video_id: null, summary_id: null })])],
        }),
        summarize: summarizing(),
      }),
      ["reason"],
    ],
    [
      "[paid-path:replay-readback]",
      "the work is saved and charged, but the response that delivers it cannot be built",
      () => ({
        admin: withFailingSummaryRead(
          debitedAdmin({ persist_summary: [ok([persistRow({ outcome: "already_persisted" })])] }),
        ),
        summarize: summarizing(),
      }),
      ["error"],
    ],
  ];

  it.each(rows)("%s: %s", async (key, _why, arrange, fields) => {
    const { admin, summarize } = arrange();
    stubSupadataFetch({
      transcript: () => supadataTranscriptOk({ content: "a short synthetic transcript with words in it" }),
      metadata: () => supadataMetadataOk(),
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const events: ReportedEvent[] = [];
    const { POST } = await loadEndpoint({ admin: admin.client, supabase: createFakeSupabase(5), summarize, events });

    await POST(makeContext({ body: generateRequestBody() }));

    expectPromotedEvent(events, { key, severity: "error", fields });
  });
});

/**
 * The degradation sites the endpoint owns reach the operator (S-13 Phase 5).
 *
 * Oracle: the plan's Promotion Roster — `acquireGenerationLease failed` belongs to the lock family and
 * `recordTranscriptAttempt failed` to the guard family; both are caught HERE because those two service
 * functions throw rather than swallow — and `reporting.ts`'s PERSONAL DATA contract, which keeps the
 * account out of the degradation family. Both exits fail the request closed with a 500; delete either
 * `captureEvent` and every response-level assertion above stays green.
 */
describe("degradation — a lock or rate limiter that fails closed reaches the operator under its own key", () => {
  const rows: [key: string, why: string, arrange: () => FakeAdmin][] = [
    [
      "[generation-lock:acquire-threw]",
      "no lease can be taken, so every generation for this user fails",
      () => createFakeAdmin({ ...defaultAdminScript(), acquire_generation_lease: [fail("synthetic lease failure")] }),
    ],
    [
      "[transcript-guard:record-threw]",
      "the rate limiter in front of the unbounded fetch is down, so every paid request fails",
      () => {
        const admin = createFakeAdmin({
          ...defaultAdminScript(),
          record_transcript_attempt: [fail("synthetic rate-limit failure")],
        });
        admin.queue("begin_generation", ok([beginRow({ outcome: "fresh" })])); // the idempotency probe
        return admin;
      },
    ],
  ];

  it.each(rows)("%s: %s", async (key, _why, arrange) => {
    const admin = arrange();
    stubSupadataFetch({
      transcript: () => supadataTranscriptOk({ content: "a short synthetic transcript with words in it" }),
      metadata: () => supadataMetadataOk(),
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const events: ReportedEvent[] = [];
    const { POST } = await loadEndpoint({ admin: admin.client, supabase: createFakeSupabase(5), events });

    await POST(makeContext({ body: generateRequestBody() }));

    expectPromotedEvent(events, { key, severity: "error", fields: ["error"], withheld: [SYNTHETIC_USER_ID] });
  });
});
