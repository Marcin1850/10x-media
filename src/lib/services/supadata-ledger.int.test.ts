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

interface FlushedRow {
  user_id: string | null;
  summary_id: string | null;
  operation: string;
  outcome: string;
  billable_credits: number | null;
  http_status: number | null;
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

  it("flushes a malformed x-billable-requests header as null, not a fabricated measurement", async () => {
    const admin = createFakeAdmin({
      ...defaultAdminScript(),
      persist_summary: [ok([persistRow({ summary_id: "summary-malformed-header" })])],
    });
    admin.queue("begin_generation", ok([beginRow({ outcome: "fresh" })]));
    admin.queue(
      "begin_generation",
      ok([beginRow({ outcome: "reserved", reservation_id: "res-debit", new_balance: 4 })]),
    );
    const supabase = createFakeSupabase(5);
    stubSupadataFetch({
      transcript: () => supadataMalformedBillableHeader("non-numeric"),
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
  });

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

describe("record_supadata_calls payload — a fully reported batch sums to a real total", () => {
  it("sums a mixed transcript+metadata batch, both billed 1, and stamps user/summary onto every row", async () => {
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
    expect(rows.map((row) => row.operation).sort()).toEqual(["metadata", "transcript"]);
    expect(sumBillableCredits(rows)).toBe(2);
    // meter.attachSummary stamps every collected row with the summary it helped produce, and
    // flushSupadataCalls stamps the request's user — asserted here because a hole in either would
    // silently orphan the row out of every per-summary or per-user reconciliation query.
    for (const row of rows) {
      expect(row.user_id).toBe(SYNTHETIC_USER_ID);
      expect(row.summary_id).toBe("summary-full-success");
    }
  });
});
