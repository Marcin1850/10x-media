import { describe, expect, it } from "vitest";
import { deleteSummary } from "@/lib/services/summary-delete";
import { stubDeleteFailing, stubDeleteRejecting, stubDeleting } from "@/lib/services/__fixtures__/supabase-stub";

/**
 * `deleteSummary` — what the service reports, and what it refuses to decide for itself.
 *
 * Oracle: the owner-scoped `summaries_delete_authenticated` policy
 * (`20260613145120_videos_and_summaries.sql:61-63`), which is the trust boundary, and
 * `test-plan.md` §6.3 rule 3, which is why the query must NOT narrow itself. The three return
 * shapes come from the service's documented contract — "nothing to delete" and "the delete failed"
 * are different answers because the endpoint owes the client a different status for each — not from
 * reading the branch that implements them.
 *
 * **This file is NOT authorization coverage, and nothing here should be read as such.**
 * `test-plan.md` §2 risk #4 names the exact anti-pattern: *"Testing the service function instead of
 * the policy — the service is not the trust boundary."* A stub answers whatever it is told to, so
 * every case below stays green against a policy broadened to `using (true)`. What these prove is
 * that the service does not narrow the query itself. That another account genuinely cannot delete
 * your row is proved only by `delete.db.int.test.ts` (Phase 2, case 3), against a real database and
 * two real sessions.
 */

const SUMMARY_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

describe("deleteSummary", () => {
  it("reports true when a row was removed", async () => {
    const stub = stubDeleting([{ id: SUMMARY_ID }]);

    await expect(deleteSummary(stub.client, SUMMARY_ID)).resolves.toBe(true);
  });

  it("reports false when nothing matched, rather than throwing", async () => {
    // Under RLS this is both "already deleted" and "not yours" — indistinguishable here by design.
    // The endpoint turns it into a 404; treating it as an error would turn it into a 500.
    const stub = stubDeleting([]);

    await expect(deleteSummary(stub.client, SUMMARY_ID)).resolves.toBe(false);
  });

  it("throws when PostgREST returns a structured error, keeping the provider message for the log", async () => {
    const stub = stubDeleteFailing("permission denied for table summaries");

    await expect(deleteSummary(stub.client, SUMMARY_ID)).rejects.toThrow("permission denied for table summaries");
  });

  it("lets a transport rejection propagate, so it is not mistaken for zero rows", async () => {
    const cause = new TypeError("fetch failed");
    const stub = stubDeleteRejecting(cause);

    await expect(deleteSummary(stub.client, SUMMARY_ID)).rejects.toBe(cause);
  });

  it("targets summaries by id only — no user_id predicate", async () => {
    // The property that keeps the POLICY, not the query, as the trust boundary. A future
    // "let's be more precise" edit adding `.eq("user_id", …)` would mask a broadened policy from
    // the integration suite (test-plan.md §6.3 rule 3), and this is what would go red.
    const stub = stubDeleting([{ id: SUMMARY_ID }]);

    await deleteSummary(stub.client, SUMMARY_ID);

    expect(stub.from).toHaveBeenCalledExactlyOnceWith("summaries");
    expect(stub.eq).toHaveBeenCalledExactlyOnceWith("id", SUMMARY_ID);
  });

  it("asks for the affected rows back, which is what makes zero rows observable", async () => {
    // A PostgREST DELETE without `.select()` returns nothing and cannot distinguish "deleted one"
    // from "matched none" — the whole true/false contract above rests on this call.
    const stub = stubDeleting([{ id: SUMMARY_ID }]);

    await deleteSummary(stub.client, SUMMARY_ID);

    expect(stub.select).toHaveBeenCalledExactlyOnceWith("id");
  });
});
