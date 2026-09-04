import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BUDGET_STOP_RESERVE,
  METADATA_BUDGET_CREDITS,
  reserveBudget,
  TRANSCRIPT_BUDGET_CREDITS,
} from "@/lib/services/supadata-budget";
import { stubFailing, stubRejecting, stubReturning } from "@/lib/services/__fixtures__/supabase-stub";
import { supadataMeOk, supadataMeUnusable, supadataTranscriptOk } from "@/lib/services/__fixtures__/supadata-responses";
import {
  beginRow,
  createFakeAdmin,
  createFakeSupabase,
  defaultAdminScript,
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

  const meFailures: [string, () => Response][] = [
    ["a non-2xx status", () => supadataMeUnusable("not-ok")],
    ["a non-JSON body", () => supadataMeUnusable("non-json")],
    ["a negative usedCredits", () => supadataMeUnusable("negative")],
    ["a fractional maxCredits", () => supadataMeUnusable("fractional")],
    ["a missing usedCredits", () => supadataMeUnusable("missing")],
  ];

  it.each(meFailures)("fails open when the claimed refresh's /v1/me returns %s", async (_label, meResponse) => {
    const stub = stubReturning([reserveRow({ outcome: "refresh_required", refresh_claim_id: "claim-1" })]);
    stubSupadataFetch({ me: meResponse });

    const result = await reserveBudget(stub.client, API_KEY, TRANSCRIPT_BUDGET_CREDITS);

    expect(result.outcome).toBe("untracked");
  });

  it("fails open when /v1/me itself fails in transport (a timeout or network error)", async () => {
    const stub = stubReturning([reserveRow({ outcome: "refresh_required", refresh_claim_id: "claim-1" })]);
    stubSupadataFetch({
      me: () => {
        throw new TypeError("fetch failed");
      },
    });

    const result = await reserveBudget(stub.client, API_KEY, TRANSCRIPT_BUDGET_CREDITS);

    expect(result.outcome).toBe("untracked");
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
