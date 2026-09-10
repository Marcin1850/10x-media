import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { releaseGenerationLease } from "@/lib/services/generation-lock";
import { expectPromotedEvent, recordReportedEvents } from "@/lib/services/__fixtures__/reporting-recorder";
import { stubFailing, stubRejecting, stubReturning } from "@/lib/services/__fixtures__/supabase-stub";

/**
 * Promotion rows for the generation lock's release (S-13 Phase 5). The acquire side throws rather than
 * swallowing, so its event is raised by the endpoint that catches it and is asserted in
 * `generate.int.test.ts`.
 */

const USER_ID = "00000000-0000-4000-8000-000000000001";
const LEASE = "lease-synthetic";

/**
 * Oracle: the plan's Promotion Roster and Phase 5 §2 — release failures route at `error`, and a lease
 * already swept as stale routes at `warn` because that is expected under load — plus `reporting.ts`'s
 * PERSONAL DATA contract. The console lines name the account; the forwarded events may not.
 *
 * The swept row is the one that proves the severity argument is real rather than a constant: it is the
 * only `warn` in the degradation family.
 */
describe("operator events — a lock that would not release cleanly", () => {
  const events = recordReportedEvents();

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const rows: [key: string, severity: string, why: string, run: () => Promise<unknown>, fields: string[]][] = [
    [
      "[generation-lock:release-failed]",
      "error",
      "the release rolled back, so the user's next generation waits out the stale window",
      () => releaseGenerationLease(stubFailing("synthetic release failure").client, USER_ID, LEASE),
      ["error"],
    ],
    [
      "[generation-lock:release-swept]",
      "warn",
      "the lease was already swept — expected under load, so a warning and not an error",
      () => releaseGenerationLease(stubReturning(false).client, USER_ID, LEASE),
      [],
    ],
    [
      "[generation-lock:release-threw]",
      "error",
      "the release never answered, so the lock may still be held",
      () => releaseGenerationLease(stubRejecting(new TypeError("fetch failed")).client, USER_ID, LEASE),
      ["error"],
    ],
  ];

  it.each(rows)("%s (%s): %s", async (key, severity, _why, run, fields) => {
    await run();

    expectPromotedEvent(events, { key, severity, fields, withheld: [USER_ID] });
  });

  it("stays silent on a clean release — every generation ends in one, so a report here would be the whole inbox", async () => {
    await releaseGenerationLease(stubReturning(true).client, USER_ID, LEASE);

    expect(events).toEqual([]);
  });
});
