import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { createSupadataMeter, flushSupadataCalls, type SupadataMeter } from "@/lib/services/supadata-ledger";
import { expectPromotedEvent, recordReportedEvents } from "@/lib/services/__fixtures__/reporting-recorder";
import { stubFailing, stubRejecting } from "@/lib/services/__fixtures__/supabase-stub";

/**
 * Promotion rows for the ledger flush (S-13 Phase 5). The ledger's payload mapping and reconciliation
 * are `supadata-ledger.int.test.ts`'s, driven through the endpoint; this file covers only whether a
 * swallowed flush failure reaches the operator.
 */

const USER_ID = "00000000-0000-4000-8000-000000000001";
const YOUTUBE_ID = "SYNTHETIC01";

/** A flush with no rows returns before the RPC, so every row here needs one call on the meter. */
function meterWithOneCall(): SupadataMeter {
  const meter = createSupadataMeter();
  meter.record({ operation: "transcript", outcome: "ok", billableCredits: 1, httpStatus: 200 });
  return meter;
}

/**
 * Oracle: the plan's Promotion Roster ("bookkeeping failures make the budget guard's own numbers
 * untrustworthy") and `reporting.ts`'s PERSONAL DATA contract. The rows being flushed are stamped with
 * the account, which is exactly why the withheld check is here: forwarding the batch, or an error
 * string built from it, would carry the user id into the degradation family.
 */
describe("operator events — a ledger flush that was lost", () => {
  const events = recordReportedEvents();

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const rows: [key: string, why: string, run: () => Promise<unknown>][] = [
    [
      "[supadata-ledger:flush-failed]",
      "the insert rolled back, so the request's real Supadata calls are missing from the ledger",
      () =>
        flushSupadataCalls(
          stubFailing("synthetic flush failure").client,
          { userId: USER_ID, youtubeId: YOUTUBE_ID },
          meterWithOneCall(),
        ),
    ],
    [
      "[supadata-ledger:flush-threw]",
      "the insert's outcome was never learned — the rows may or may not be there",
      () =>
        flushSupadataCalls(
          stubRejecting(new TypeError("fetch failed")).client,
          { userId: USER_ID, youtubeId: YOUTUBE_ID },
          meterWithOneCall(),
        ),
    ],
  ];

  it.each(rows)("%s: %s", async (key, _why, run) => {
    await run();

    expectPromotedEvent(events, { key, severity: "error", fields: ["error"], withheld: [USER_ID] });
  });
});
