import { afterEach, describe, expect, it, vi } from "vitest";
import {
  supadataGatewayTimeout524,
  supadataMalformedBillableHeader,
  supadataMetadataOk,
  supadataMissingBillableHeader,
  supadataNonJsonContentType,
  supadataTranscriptOk,
  supadataTranscriptUnavailable206,
} from "@/lib/services/__fixtures__/supadata-responses";
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
  SYNTHETIC_USER_ID,
  stubSupadataFetch,
} from "@/pages/api/summaries/__fixtures__/generation-harness";

/**
 * Stub layer — spend reconciliation over the ledger payload (plan Phase 4 item 4; test-plan risk #2).
 *
 * **The cost of the fixtures-only decision, stated here as the plan requires** (research.md §8): with
 * no live `GET /v1/me`, this proves the code correctly maps and sums RECORDED responses into the
 * `record_supadata_calls` payload. It cannot detect that the vendor changed its pricing, stopped
 * sending the header, or altered a response shape — the very failure modes an independent-oracle
 * reconciliation exists to catch. That gap is a knowing trade, not an oversight.
 *
 * Oracle: `supadata-ledger.ts`'s own documented contract on `SupadataCallRecord.billableCredits` and
 * `SupadataMeter.billedSince` ("`null` when ANY matching row has a null billableCredits… must not be
 * coerced to 0") — never the meter's own implementation. `sumBillableCredits` below is a test-local
 * reimplementation of that SAME rule, applied to the flushed RPC payload rather than the meter's
 * internal state, which is what a real reconciliation query would do.
 */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Every column `flushSupadataCalls` sends — `supadata-ledger.ts`'s `LedgerRow`, plus the two it stamps. */
interface FlushedRow {
  user_id: string | null;
  summary_id: string | null;
  youtube_id: string | null;
  operation: string;
  outcome: string;
  resolved_via: string | null;
  billable_credits: number | null;
  http_status: number | null;
}

/**
 * Row order in the payload is the order the calls happened, which the plan does not fix as a contract —
 * normalize by `operation` so an exact comparison tests the CONTENT of the batch, not incidental
 * sequencing. Used only by the exact-payload tests; the mapping tests filter by operation instead.
 */
function byOperation(rows: FlushedRow[]): FlushedRow[] {
  return [...rows].sort((a, b) => a.operation.localeCompare(b.operation));
}

/** Unknown is contagious: one null row makes the whole batch's total unknown, never zero. */
function sumBillableCredits(rows: FlushedRow[]): number | null {
  let total = 0;
  for (const row of rows) {
    if (row.billable_credits === null) return null;
    total += row.billable_credits;
  }
  return total;
}

describe("record_supadata_calls payload — the billable 206 reads null, never 0", () => {
  it("flushes a fresh 206 transcript-unavailable call with billable_credits: null despite being billed", async () => {
    const admin = createFakeAdmin({
      ...defaultAdminScript(),
      charge_failed_transcript: [ok([{ outcome: "charged", new_balance: 4 }])],
    });
    admin.queue("begin_generation", ok([beginRow({ outcome: "fresh" })]));
    const supabase = createFakeSupabase(5);
    stubSupadataFetch({ transcript: () => supadataTranscriptUnavailable206() });
    const { POST } = await loadEndpoint({ admin: admin.client, supabase });

    const response = await POST(makeContext({ body: generateRequestBody() }));
    expect(response.status).toBe(422); // the refusal itself belongs to generate.int.test.ts

    const rows = admin.callsTo("record_supadata_calls")[0].params?.p_calls as FlushedRow[];
    const transcriptRows = rows.filter((row) => row.operation === "transcript");
    expect(transcriptRows).toHaveLength(1);
    expect(transcriptRows[0]).toMatchObject({ outcome: "unavailable", billable_credits: null, http_status: 206 });
    // The measurement-vs-inference distinction the whole ledger rests on: NOT 0.
    expect(sumBillableCredits(rows)).toBeNull();
  });

  /**
   * All three kinds `supadataMalformedBillableHeader` defines, because each is a DIFFERENT regression
   * (the fixture's own comment, sourced from `supadata-billable-requests.md` §Parsing contract):
   *
   * - `non-numeric` / `fractional` — a `parseInt`-style prefix read accepts `"1oops"` / `"1.5"` as `1`,
   *   inventing a measurement the vendor never sent. Only a whole-string match rejects both.
   * - `out-of-range` — `"2147483648"`, one past the `int4` ceiling `record_supadata_calls` casts into.
   *   This is the one with teeth: an unrejected value here fails the whole batch INSERT, silently
   *   discarding every sibling row in it. Drop the range check and the other two rows still pass.
   */
  const malformedHeaderKinds = ["non-numeric", "fractional", "out-of-range"] as const;

  it.each(malformedHeaderKinds)(
    "flushes a %s x-billable-requests header as null, not a fabricated measurement",
    async (kind) => {
      const admin = createFakeAdmin({
        ...defaultAdminScript(),
        persist_summary: [ok([persistRow({ summary_id: `summary-malformed-${kind}` })])],
      });
      admin.queue("begin_generation", ok([beginRow({ outcome: "fresh" })]));
      admin.queue(
        "begin_generation",
        ok([beginRow({ outcome: "reserved", reservation_id: "res-debit", new_balance: 4 })]),
      );
      const supabase = createFakeSupabase(5);
      stubSupadataFetch({
        transcript: () => supadataMalformedBillableHeader(kind),
        metadata: () => supadataMetadataOk(),
      });
      const { POST } = await loadEndpoint({ admin: admin.client, supabase });

      const response = await POST(makeContext({ body: generateRequestBody() }));
      expect(response.status).toBe(200);

      const rows = admin.callsTo("record_supadata_calls")[0].params?.p_calls as FlushedRow[];
      const transcriptRows = rows.filter((row) => row.operation === "transcript");
      expect(transcriptRows[0]).toMatchObject({ outcome: "ok", billable_credits: null, http_status: 200 });
      // One unknown row poisons the whole batch's sum, even though the metadata row DID report a figure.
      expect(sumBillableCredits(rows)).toBeNull();
    },
  );

  it("flushes a 200 transcript with NO x-billable-requests header at all as null — absent, not malformed", async () => {
    const admin = createFakeAdmin({
      ...defaultAdminScript(),
      persist_summary: [ok([persistRow({ summary_id: "summary-missing-header" })])],
    });
    admin.queue("begin_generation", ok([beginRow({ outcome: "fresh" })]));
    admin.queue(
      "begin_generation",
      ok([beginRow({ outcome: "reserved", reservation_id: "res-debit", new_balance: 4 })]),
    );
    const supabase = createFakeSupabase(5);
    stubSupadataFetch({
      transcript: () => supadataMissingBillableHeader(),
      metadata: () => supadataMetadataOk(),
    });
    const { POST } = await loadEndpoint({ admin: admin.client, supabase });

    const response = await POST(makeContext({ body: generateRequestBody() }));
    expect(response.status).toBe(200);

    const rows = admin.callsTo("record_supadata_calls")[0].params?.p_calls as FlushedRow[];
    const transcriptRows = rows.filter((row) => row.operation === "transcript");
    expect(transcriptRows[0]).toMatchObject({ outcome: "ok", billable_credits: null, http_status: 200 });
    expect(sumBillableCredits(rows)).toBeNull();
  });

  it("flushes a transport failure (524 gateway timeout) as billable_credits: null with the vendor's real status", async () => {
    const admin = createFakeAdmin(defaultAdminScript());
    admin.queue("begin_generation", ok([beginRow({ outcome: "fresh" })]));
    const supabase = createFakeSupabase(5);
    stubSupadataFetch({ transcript: () => supadataGatewayTimeout524() });
    const { POST } = await loadEndpoint({ admin: admin.client, supabase });

    const response = await POST(makeContext({ body: generateRequestBody() }));
    expect(response.status).toBe(502); // a genuine upstream failure — no refusal, no charge

    const rows = admin.callsTo("record_supadata_calls")[0].params?.p_calls as FlushedRow[];
    const transcriptRows = rows.filter((row) => row.operation === "transcript");
    expect(transcriptRows[0]).toMatchObject({ outcome: "error", billable_credits: null, http_status: 524 });
    // Distinct from the 206's "reported but absent" null: here the response carried no header AND no
    // billing evidence of any kind — the vendor's own docs say a timeout still bills, so this is the
    // "unverifiable, not merely unreported" case (supadata-responses.ts comment on this factory).
    expect(sumBillableCredits(rows)).toBeNull();
  });

  it("flushes a non-JSON metadata response as an error row with billable_credits: null", async () => {
    const admin = createFakeAdmin({
      ...defaultAdminScript(),
      persist_summary: [ok([persistRow({ summary_id: "summary-metadata-nonjson" })])],
    });
    admin.queue("begin_generation", ok([beginRow({ outcome: "fresh" })]));
    admin.queue(
      "begin_generation",
      ok([beginRow({ outcome: "reserved", reservation_id: "res-debit", new_balance: 4 })]),
    );
    const supabase = createFakeSupabase(5);
    stubSupadataFetch({
      transcript: () => supadataTranscriptOk(),
      metadata: () => supadataNonJsonContentType(200),
    });
    const { POST } = await loadEndpoint({ admin: admin.client, supabase });

    const response = await POST(makeContext({ body: generateRequestBody() }));
    // fetchVideoMetadata is total by contract — a failed metadata fetch still lets the paid summary
    // through; only the ledger records the failed call.
    expect(response.status).toBe(200);

    const rows = admin.callsTo("record_supadata_calls")[0].params?.p_calls as FlushedRow[];
    const metadataRows = rows.filter((row) => row.operation === "metadata");
    expect(metadataRows[0]).toMatchObject({ outcome: "error", billable_credits: null });
    expect(sumBillableCredits(rows)).toBeNull();
  });
});

/**
 * The plan's Phase 4 item 4 contract in full: drive a batch through the endpoint, assert the EXACT
 * payload handed to `record_supadata_calls`, then sum `billable_credits` from it. Exact rather than
 * `toMatchObject` on purpose — a field-subset match cannot see a column that was silently added,
 * renamed, or stopped being stamped, and those are precisely the ways a reconciliation query goes
 * quietly wrong. Two batches, because the sum has two materially different answers.
 */
describe("record_supadata_calls payload — the exact batch, and what it sums to", () => {
  const SYNTHETIC_YOUTUBE_ID = "synthetic01";

  it("a fully reported batch: every row billed 1, exact payload, sums to a real total", async () => {
    const admin = createFakeAdmin({
      ...defaultAdminScript(),
      persist_summary: [ok([persistRow({ summary_id: "summary-full-success" })])],
    });
    admin.queue("begin_generation", ok([beginRow({ outcome: "fresh" })]));
    admin.queue(
      "begin_generation",
      ok([beginRow({ outcome: "reserved", reservation_id: "res-debit", new_balance: 4 })]),
    );
    const supabase = createFakeSupabase(5);
    stubSupadataFetch({
      transcript: () => supadataTranscriptOk({ billableRequests: "1" }),
      metadata: () => supadataMetadataOk(),
    });
    const { POST } = await loadEndpoint({ admin: admin.client, supabase });

    const response = await POST(makeContext({ body: generateRequestBody() }));
    expect(response.status).toBe(200);

    const rows = admin.callsTo("record_supadata_calls")[0].params?.p_calls as FlushedRow[];
    // `user_id` comes from flushSupadataCalls' request stamp, `summary_id` from meter.attachSummary —
    // a hole in either silently orphans the row out of every per-summary or per-user reconciliation
    // query, which is why they are compared here rather than spot-checked.
    expect(byOperation(rows)).toEqual([
      {
        user_id: SYNTHETIC_USER_ID,
        summary_id: "summary-full-success",
        youtube_id: SYNTHETIC_YOUTUBE_ID,
        operation: "metadata",
        outcome: "ok",
        resolved_via: null,
        billable_credits: 1,
        http_status: null,
      },
      {
        user_id: SYNTHETIC_USER_ID,
        summary_id: "summary-full-success",
        youtube_id: SYNTHETIC_YOUTUBE_ID,
        operation: "transcript",
        outcome: "ok",
        resolved_via: "inline",
        billable_credits: 1,
        http_status: 200,
      },
    ]);
    expect(sumBillableCredits(rows)).toBe(2);
  });

  it("a MIXED batch — one measured row beside one unmeasurable one — sums to null, not to the measured part", async () => {
    const admin = createFakeAdmin({
      ...defaultAdminScript(),
      persist_summary: [ok([persistRow({ summary_id: "summary-mixed-batch" })])],
    });
    admin.queue("begin_generation", ok([beginRow({ outcome: "fresh" })]));
    admin.queue(
      "begin_generation",
      ok([beginRow({ outcome: "reserved", reservation_id: "res-debit", new_balance: 4 })]),
    );
    const supabase = createFakeSupabase(5);
    stubSupadataFetch({
      // Billed and reported: a real measurement.
      transcript: () => supadataTranscriptOk({ billableRequests: "1" }),
      // Billed but unreportable — fetchVideoMetadata is total by contract, so the summary still ships
      // and only the ledger carries the damage.
      metadata: () => supadataNonJsonContentType(200),
    });
    const { POST } = await loadEndpoint({ admin: admin.client, supabase });

    const response = await POST(makeContext({ body: generateRequestBody() }));
    expect(response.status).toBe(200);

    const rows = admin.callsTo("record_supadata_calls")[0].params?.p_calls as FlushedRow[];
    expect(byOperation(rows)).toEqual([
      {
        user_id: SYNTHETIC_USER_ID,
        summary_id: "summary-mixed-batch",
        youtube_id: SYNTHETIC_YOUTUBE_ID,
        operation: "metadata",
        outcome: "error",
        resolved_via: null,
        billable_credits: null,
        http_status: null,
      },
      {
        user_id: SYNTHETIC_USER_ID,
        summary_id: "summary-mixed-batch",
        youtube_id: SYNTHETIC_YOUTUBE_ID,
        operation: "transcript",
        outcome: "ok",
        resolved_via: "inline",
        billable_credits: 1,
        http_status: 200,
      },
    ]);
    // THE POINT: the batch holds a genuine `1`, and the total is still unknown. Reporting `1` here
    // would understate real spend and read as a reconciliation match — the exact failure the null
    // discipline exists to prevent. Asserted as its own value, never as `not.toBe(1)`.
    expect(sumBillableCredits(rows)).toBeNull();
  });
});
