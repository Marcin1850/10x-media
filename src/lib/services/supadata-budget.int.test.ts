import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BUDGET_STOP_RESERVE,
  METADATA_BUDGET_CREDITS,
  reserveBudget,
  TRANSCRIPT_BUDGET_CREDITS,
} from "@/lib/services/supadata-budget";
import { expectPromotedEvent, recordReportedEvents } from "@/lib/services/__fixtures__/reporting-recorder";
import { stubFailing, stubRejecting, stubReturning } from "@/lib/services/__fixtures__/supabase-stub";
import { supadataMeOk, supadataMeUnusable, supadataTranscriptOk } from "@/lib/services/__fixtures__/supadata-responses";
import {
  beginRow,
  createFakeAdmin,
  createFakeSupabase,
  defaultAdminScript,
  fail,
  generateRequestBody,
  loadEndpoint,
  makeContext,
  ok,
  persistRow,
  readJson,
  reserveRow,
  stubSupadataFetch,
} from "@/pages/api/summaries/__fixtures__/generation-harness";

/**
 * Stub layer — the vendor budget breaker (plan Phase 4 item 3; test-plan risk #3). Two halves:
 *
 * - `reserveBudget` exercised directly against the admin-client seam (`__fixtures__/supabase-stub.ts`,
 *   the same convention `credits.test.ts` uses) plus the global `fetch` for `/v1/me` — this is the
 *   half the plan warns is easy to get backwards: "testing only the trip and never the fail-open tests
 *   the wrong branch" (research.md §6).
 * - The endpoint's two check points, driven through the full generation pipeline via
 *   `generation-harness.ts`, because "does not abort at the metadata checkpoint" is a CONTROL-FLOW
 *   decision inside `generate.ts`, not something `reserveBudget` alone can prove.
 *
 * Oracle: `supadata-budget.ts`'s own documented contract on `ReserveBudgetResult` and `BUDGET_STOP_
 * RESERVE`'s derivation comment, plus `generate.ts:574,865`'s two check-point comments — never the
 * switch statement each test exercises.
 */

const API_KEY = "synthetic-supadata-key";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("BUDGET_STOP_RESERVE is derived, pinned separately from any test that uses it", () => {
  it("is the sum of one generation's worst-case Supadata cost — 1 transcript + up to 2 metadata credits", () => {
    expect(BUDGET_STOP_RESERVE).toBe(TRANSCRIPT_BUDGET_CREDITS + METADATA_BUDGET_CREDITS);
    expect(BUDGET_STOP_RESERVE).toBe(3);
  });
});

describe("reserveBudget — the trip itself", () => {
  it("refuses when the RPC reports refused", async () => {
    const stub = stubReturning([reserveRow({ outcome: "refused", reservation_id: null })]);

    const result = await reserveBudget(stub.client, API_KEY, TRANSCRIPT_BUDGET_CREDITS);

    expect(result.outcome).toBe("refused");
  });

  it("reserves when the RPC reports reserved", async () => {
    const stub = stubReturning([reserveRow({ outcome: "reserved", reservation_id: "res-1" })]);

    const result = await reserveBudget(stub.client, API_KEY, TRANSCRIPT_BUDGET_CREDITS);

    expect(result).toMatchObject({ outcome: "reserved", reservationId: "res-1" });
  });

  it("completes a refresh and reserves on the second pass when /v1/me succeeds", async () => {
    // Unlike the fail-open cases below, this is the SUCCESSFUL refresh: reserve_supadata_credits is
    // called twice (once to learn a refresh is owed, once more after the reading is saved), so this
    // needs the per-fn queue rather than a single-shot stub.
    const admin = createFakeAdmin({
      reserve_supadata_credits: [
        ok([reserveRow({ outcome: "refresh_required", refresh_claim_id: "claim-2" })]),
        ok([reserveRow({ outcome: "reserved", reservation_id: "res-after-refresh" })]),
      ],
      save_supadata_budget: [ok(true)],
    });
    stubSupadataFetch({ me: () => supadataMeOk({ maxCredits: 100, usedCredits: 18 }) });

    const result = await reserveBudget(admin.client, API_KEY, TRANSCRIPT_BUDGET_CREDITS);

    expect(result).toMatchObject({ outcome: "reserved", reservationId: "res-after-refresh" });
    // The reading is saved UNDER THE CLAIM the first pass was granted — never a fresh timestamp.
    expect(admin.callsTo("save_supadata_budget")[0].params).toMatchObject({
      p_max_credits: 100,
      p_used_credits: 18,
      p_claim_id: "claim-2",
    });
  });
});

describe("reserveBudget — every fail-open path proceeds with NO reservation (research.md §6)", () => {
  it("fails open on an RPC error — the reserve statement itself could not be evaluated", async () => {
    const stub = stubFailing("connection refused");

    const result = await reserveBudget(stub.client, API_KEY, TRANSCRIPT_BUDGET_CREDITS);

    expect(result.outcome).toBe("untracked");
  });

  it("fails open on a rejected reserve request", async () => {
    const stub = stubRejecting(new TypeError("fetch failed"));

    const result = await reserveBudget(stub.client, API_KEY, TRANSCRIPT_BUDGET_CREDITS);

    expect(result.outcome).toBe("untracked");
  });

  it("fails open when uninitialized — no reading exists and another caller already holds the refresh claim", async () => {
    const stub = stubReturning([{ outcome: "uninitialized" }]);

    const result = await reserveBudget(stub.client, API_KEY, TRANSCRIPT_BUDGET_CREDITS);

    expect(result.outcome).toBe("untracked");
  });

  /**
   * Every way `/v1/me` can fail, each with the REASON an operator reads off the `untracked` event.
   * Oracle: `VendorBudgetReading`'s contract — the reason names the failure class (timeout, transport,
   * HTTP status, non-JSON, which field is malformed), because each is acted on differently. The
   * patterns are the class, not the exact wording; each row catches a different collapse back into one
   * generic string.
   */
  const meFailures: [label: string, me: () => Response, reason: RegExp][] = [
    ["a non-2xx status", () => supadataMeUnusable("not-ok"), /HTTP 503/],
    ["a non-JSON body", () => supadataMeUnusable("non-json"), /non-JSON body/],
    ["a negative usedCredits", () => supadataMeUnusable("negative"), /usedCredits is not a nonnegative integer/],
    ["a fractional maxCredits", () => supadataMeUnusable("fractional"), /maxCredits is not a nonnegative integer/],
    ["a missing usedCredits", () => supadataMeUnusable("missing"), /usedCredits is not a nonnegative integer/],
    [
      "our own deadline (AbortSignal.timeout)",
      () => {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      },
      /timed out after \d+ ms/,
    ],
    [
      "a transport error",
      () => {
        throw new TypeError("fetch failed");
      },
      /request failed: TypeError: fetch failed/,
    ],
  ];

  it.each(meFailures)(
    "fails open, naming the cause, when the claimed refresh's /v1/me hits %s",
    async (_label, meResponse, reason) => {
      const stub = stubReturning([reserveRow({ outcome: "refresh_required", refresh_claim_id: "claim-1" })]);
      stubSupadataFetch({ me: meResponse });

      const result = await reserveBudget(stub.client, API_KEY, TRANSCRIPT_BUDGET_CREDITS);

      expect(result).toMatchObject({ outcome: "untracked", reason: expect.stringMatching(reason) as unknown });
    },
  );

  describe("the reason reaches the operator's event, not just the return value", () => {
    const events = recordReportedEvents();

    beforeEach(() => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
    });

    it("carries the HTTP status in the [supadata-budget] untracked payload", async () => {
      const stub = stubReturning([reserveRow({ outcome: "refresh_required", refresh_claim_id: "claim-1" })]);
      stubSupadataFetch({ me: () => supadataMeUnusable("not-ok") });

      await reserveBudget(stub.client, API_KEY, TRANSCRIPT_BUDGET_CREDITS);

      // Field set unchanged — this change alters a value, never the payload's shape.
      expectPromotedEvent(events, {
        key: "[supadata-budget]",
        severity: "untracked",
        fields: ["threshold", "maxCredits", "usedCredits", "outstanding", "readingAgeSeconds", "reason"],
        withheld: [API_KEY, "internal-error"],
      });
      const payload = events[0].context.payload as { reason: string };
      expect(payload.reason).toMatch(/HTTP 503/);
    });
  });

  /**
   * The reading came back fine; STORING it is what went wrong (`reserveBudget`'s `saveVendorBudget` branch). Both
   * arms fail open with no second reserve — a refresh is spent once per call, never retried into a
   * loop. `claim-lost` is deliberately NOT a failure of the stored state (a successor already saved a
   * reading at least as fresh); it still ends the call, because this caller has burned its one refresh.
   */
  const saveOutcomes: [string, ReturnType<typeof ok>][] = [
    ["errors", fail("save_supadata_budget: connection refused")],
    ["reports claim-lost (a successor stored a fresher reading first)", ok(false)],
  ];

  it.each(saveOutcomes)("fails open when save_supadata_budget %s", async (_label, saveResult) => {
    const admin = createFakeAdmin({
      reserve_supadata_credits: [ok([reserveRow({ outcome: "refresh_required", refresh_claim_id: "claim-3" })])],
      save_supadata_budget: [saveResult],
    });
    const fetchMock = stubSupadataFetch({ me: () => supadataMeOk({ maxCredits: 100, usedCredits: 18 }) });

    const result = await reserveBudget(admin.client, API_KEY, TRANSCRIPT_BUDGET_CREDITS);

    expect(result.outcome).toBe("untracked");
    // No reservation to settle — the caller proceeds unmetered rather than holding a phantom one.
    expect(result).not.toHaveProperty("reservationId");
    // The refresh ends here: no SECOND reserve pass, and exactly one /v1/me for the whole call. The
    // fake admin throws on an unscripted call, so a second reserve would fail loudly — this asserts it
    // positively anyway, because that is the bound the module documents ("one refresh per call").
    expect(admin.callsTo("reserve_supadata_credits")).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  /**
   * The second reserve pass ran but did not terminate (`reserveBudget`'s second-pass `switch`). Its `default`
   * arm is the guard against accidental recursion: re-entering the refresh from here would fetch
   * `/v1/me` again, once per pass, against a vendor that is already unhappy. Each row is a distinct
   * regression — remove the arm and one of them recurses, remove the fail-open and one of them refuses
   * a request the breaker was never able to evaluate.
   */
  const nonTerminalSecondPass: [string, ReturnType<typeof ok>][] = [
    [
      "refresh_required again (the recursion the `default` arm exists to stop)",
      ok([reserveRow({ outcome: "refresh_required", refresh_claim_id: "claim-5" })]),
    ],
    [
      "uninitialized (the saved reading vanished under a concurrent prune)",
      ok([reserveRow({ outcome: "uninitialized" })]),
    ],
    ["an RPC error", fail("reserve_supadata_credits: connection reset")],
  ];

  it.each(nonTerminalSecondPass)("fails open when the second reserve pass returns %s", async (_label, secondPass) => {
    const admin = createFakeAdmin({
      reserve_supadata_credits: [
        ok([reserveRow({ outcome: "refresh_required", refresh_claim_id: "claim-4" })]),
        secondPass,
      ],
      save_supadata_budget: [ok(true)],
    });
    const fetchMock = stubSupadataFetch({ me: () => supadataMeOk({ maxCredits: 100, usedCredits: 18 }) });

    const result = await reserveBudget(admin.client, API_KEY, TRANSCRIPT_BUDGET_CREDITS);

    expect(result.outcome).toBe("untracked");
    expect(result).not.toHaveProperty("reservationId");
    // Exactly two reserve passes and ONE /v1/me — the refresh is not re-entered from the second pass.
    expect(admin.callsTo("reserve_supadata_credits")).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("the breaker at the endpoint's two check points (generate.ts:574,865)", () => {
  it("refuses the WHOLE request when the transcript check point trips — 503, before any fetch", async () => {
    const admin = createFakeAdmin({
      ...defaultAdminScript(),
      reserve_supadata_credits: [ok([reserveRow({ outcome: "refused" })])],
    });
    admin.queue("begin_generation", ok([beginRow({ outcome: "fresh" })]));
    const supabase = createFakeSupabase(5);
    const { POST } = await loadEndpoint({ admin: admin.client, supabase });

    const response = await POST(makeContext({ body: generateRequestBody() }));

    expect(response.status).toBe(503);
    const json = (await readJson(response)) as { error: string };
    expect(json.error).toMatch(/transcript service limit/i);
    // The breaker refuses BEFORE the rate-limit guard and the fetch — neither ever runs.
    expect(admin.callsTo("record_transcript_attempt")).toHaveLength(0);
  });

  it("does NOT abort when the metadata check point trips — persists the summary with skipped_budget and nulls", async () => {
    const admin = createFakeAdmin({
      ...defaultAdminScript(),
      reserve_supadata_credits: [
        ok([reserveRow({ outcome: "reserved", reservation_id: "res-transcript" })]), // transcript: fine
        ok([reserveRow({ outcome: "refused" })]), // metadata: refused
      ],
      persist_summary: [ok([persistRow()])],
    });
    admin.queue("begin_generation", ok([beginRow({ outcome: "fresh" })]));
    admin.queue(
      "begin_generation",
      ok([beginRow({ outcome: "reserved", reservation_id: "res-debit", new_balance: 4 })]),
    );
    const supabase = createFakeSupabase(5);
    // No `metadata` handler is scripted — if the endpoint tried to fetch it anyway despite the
    // refusal, stubSupadataFetch would throw and fail the test.
    stubSupadataFetch({ transcript: () => supadataTranscriptOk() });
    const { POST } = await loadEndpoint({ admin: admin.client, supabase });

    const response = await POST(makeContext({ body: generateRequestBody() }));

    expect(response.status).toBe(200);
    const persistCall = admin.callsTo("persist_summary")[0];
    expect(persistCall.params).toMatchObject({
      p_metadata_via: "skipped_budget",
      p_title: null,
      p_thumbnail_url_reported: null,
      p_channel_name: null,
      p_channel_id: null,
      p_duration_seconds: null,
      p_published_at: null,
    });
  });
});
