import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Append-only ledger of real Supadata HTTP calls (S-07).
 *
 * Why a meter rather than columns on `summaries`: a generation that returns 422, 413, 409 or 502
 * still made — and still paid for — Supadata calls, and no column on a summary row that was never
 * written can record that. The meter collects one record per HTTP call during a request; the endpoint
 * flushes it once in a `finally`, so every exit path leaves a trace.
 *
 * The credit figure is MEASURED, never inferred. `billableCredits` is whatever the response's
 * `x-billable-requests` header said, passed through untouched: `null` means the vendor reported
 * nothing (or no response arrived), `0` means it reported free. Keeping those distinct is what makes
 * a reconciliation gap against `GET /v1/me` diagnosable instead of merely visible. Nothing here
 * derives a price from `resolvedVia` — see the plan's "No inferred credit figure, anywhere".
 */

export type SupadataOperation = "transcript" | "transcript_poll" | "metadata";
export type SupadataCallOutcome = "ok" | "unavailable" | "error";

export interface SupadataCallRecord {
  operation: SupadataOperation;
  outcome: SupadataCallOutcome;
  youtubeId?: string | null;
  /** Observed fetch mechanism when known. Diagnostic — nothing is priced from it. */
  resolvedVia?: string | null;
  /** Verbatim `x-billable-requests`. `null` = not reported; `0` = reported free. Never inferred. */
  billableCredits: number | null;
}

interface LedgerRow {
  user_id: string | null;
  summary_id: string | null;
  youtube_id: string | null;
  operation: SupadataOperation;
  outcome: SupadataCallOutcome;
  resolved_via: string | null;
  billable_credits: number | null;
}

export interface SupadataMeter {
  /**
   * Appends one record. A plain in-memory push that CANNOT throw — it runs inside the catch blocks
   * that make the transcript and metadata services total, so a throwing meter would defeat the very
   * totality guarantee those services provide.
   */
  record: (call: SupadataCallRecord) => void;
  /** Stamps every collected row with the summary it belongs to. Called once after a successful persist. */
  attachSummary: (summaryId: string) => void;
  drain: () => LedgerRow[];
}

export function createSupadataMeter(): SupadataMeter {
  const rows: LedgerRow[] = [];

  return {
    record({ operation, outcome, youtubeId = null, resolvedVia = null, billableCredits }) {
      rows.push({
        user_id: null,
        summary_id: null,
        youtube_id: youtubeId,
        operation,
        outcome,
        resolved_via: resolvedVia,
        billable_credits: billableCredits,
      });
    },
    attachSummary(summaryId) {
      for (const row of rows) {
        row.summary_id = summaryId;
      }
    },
    drain() {
      return rows.slice();
    },
  };
}

/**
 * Writes the whole batch in ONE round trip via `record_supadata_calls`, whatever the request's
 * outcome was.
 *
 * Best-effort and never throws: a lost ledger row is a lost measurement, not a failed generation, and
 * this runs in the endpoint's `finally` where a rejection would replace an already-decided response.
 *
 * Takes the ADMIN client — `supadata_calls` is a definer-only table, reachable only through the
 * service-role RPC, like every other guard table in this repo.
 */
export async function flushSupadataCalls(
  admin: SupabaseClient,
  { userId, youtubeId }: { userId: string | null; youtubeId: string | null },
  meter: SupadataMeter,
): Promise<void> {
  const rows = meter.drain();
  if (rows.length === 0) return;

  // Stamped at flush time rather than at record time. Both values are properties of the REQUEST, not
  // of an individual call: one request has one user and concerns one video, while the services making
  // the calls see only a URL and an API key. Recording them per call would mean threading request
  // context into two modules that have no other use for it. A row that set its own `youtube_id` keeps
  // it.
  const stamped = rows.map((row) => ({
    ...row,
    user_id: userId,
    youtube_id: row.youtube_id ?? youtubeId,
  }));

  try {
    const { error } = (await admin.rpc("record_supadata_calls", { p_calls: stamped })) as {
      error: { message: string } | null;
    };

    if (error) {
      // eslint-disable-next-line no-console
      console.error(`flushSupadataCalls: ${error.message}`);
    }
  } catch (cause) {
    // eslint-disable-next-line no-console
    console.error("flushSupadataCalls failed:", cause);
  }
}

/**
 * Parses `x-billable-requests` off a response. `null` when the header is absent or unparseable —
 * never a throw, and never a guess.
 *
 * The header's UNIT is still open: the name says requests, the only documentation sentence describing
 * it says credits, and the two diverge exactly on the Whisper `job` path (1 request vs 2 credits per
 * minute). Phase 5 run 3 settles it. The value is stored verbatim either way, so the answer changes
 * the column's name, not its contents. See
 * `context/changes/persist-time-and-cost/docs/supadata-billable-requests.md`.
 */
export function readBillableCredits(response: Response): number | null {
  const raw = response.headers.get("x-billable-requests");
  if (raw === null) return null;

  // Deliberately NOT `Number.parseInt`, which reads a valid PREFIX and discards the rest: it turns
  // `"1oops"` and `"1.5"` into `1`, inventing a precise-looking measurement out of a value the vendor
  // did not send. This ledger's whole claim is that the figure is measured rather than inferred, so a
  // header we cannot read in full has to become `null` — honestly unreported — not a plausible guess.
  if (!/^\d+$/.test(raw.trim())) return null;

  // The column is a PostgreSQL `integer`. An out-of-range value would fail the cast inside
  // `record_supadata_calls`, and because the flush is ONE batch insert, that failure would discard
  // every other row for the request — losing good measurements to one bad header.
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed <= 2_147_483_647 ? parsed : null;
}
