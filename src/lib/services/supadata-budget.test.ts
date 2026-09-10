import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settleBudget } from "@/lib/services/supadata-budget";
import { expectPromotedEvent, recordReportedEvents } from "@/lib/services/__fixtures__/reporting-recorder";
import { stubFailing, stubRejecting, stubReturning } from "@/lib/services/__fixtures__/supabase-stub";

/**
 * Promotion rows for budget settlement (S-13 Phase 5). The breaker itself — the trip, the fail-open
 * branches and the threshold events — is `supadata-budget.int.test.ts`'s. `settleBudget` needs nothing
 * but an injected client, so its swallowed failures are covered here, in the unit project.
 */

const RESERVATION_ID = "budget-res-synthetic";

/**
 * Oracle: the plan's Promotion Roster ("bookkeeping failures make the budget guard's own numbers
 * untrustworthy") and Phase 5 §2 — every settle failure routes at `error`, and reservation ids are
 * operational identifiers that may travel — plus `reporting.ts`'s PERSONAL DATA contract.
 *
 * These are deliberately NOT the `[supadata-budget]` threshold family: a reservation that could not be
 * settled is a bookkeeping failure, not a budget crossing, and sharing that key would merge the two
 * into one issue.
 */
describe("operator events — a reservation that could not be settled", () => {
  const events = recordReportedEvents();

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const rows: [key: string, why: string, run: () => Promise<unknown>, fields: string[]][] = [
    [
      "[supadata-budget:settle-failed]",
      "the settle rolled back, so the reservation counts at its maximum until the sweep",
      () => settleBudget(stubFailing("synthetic settle failure").client, RESERVATION_ID, 1),
      ["reservationId", "error"],
    ],
    [
      "[supadata-budget:settle-unmatched]",
      "the call outlived the stale window and the sweep closed it at the pessimistic figure",
      () => settleBudget(stubReturning(false).client, RESERVATION_ID, 1),
      ["reservationId"],
    ],
    [
      "[supadata-budget:settle-threw]",
      "the settle's outcome was never learned",
      () => settleBudget(stubRejecting(new TypeError("fetch failed")).client, RESERVATION_ID, 1),
      ["reservationId", "error"],
    ],
  ];

  it.each(rows)("%s: %s", async (key, _why, run, fields) => {
    await run();

    expectPromotedEvent(events, { key, severity: "error", fields });
  });

  it("stays silent on a clean settle — every paid call ends in one", async () => {
    await settleBudget(stubReturning(true).client, RESERVATION_ID, 1);

    expect(events).toEqual([]);
  });
});
