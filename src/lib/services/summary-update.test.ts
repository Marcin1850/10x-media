import { describe, expect, it } from "vitest";
import { setWorthWatching } from "@/lib/services/summary-update";
import { stubUpdateFailing, stubUpdateRejecting, stubUpdating } from "@/lib/services/__fixtures__/supabase-stub";

/**
 * `setWorthWatching` — the user's watch/skip mark on one summary (S-14).
 *
 * Oracle: the plan's service contract (`context/changes/summary-watch-verdict/plan.md` Phase 2 §1), the
 * column-scoped grant and owner-scoped UPDATE policy of `20260914120000_summaries_worth_watching.sql`, and
 * `test-plan.md` §6.3 rule 3 for why the query must NOT narrow itself — mirroring `summary-delete.test.ts`.
 *
 * **Not authorization coverage.** A stub answers whatever it is told to, so every case below stays green
 * against a broadened policy. That another account cannot mark your summary is proved by
 * `cross-account-policy.int.test.ts` and `update.db.int.test.ts`, against a real database.
 */

const SUMMARY_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

describe("setWorthWatching", () => {
  it("reports true when a row was updated", async () => {
    const stub = stubUpdating([{ id: SUMMARY_ID }]);

    await expect(setWorthWatching(stub.client, SUMMARY_ID, true)).resolves.toBe(true);
  });

  it.each([
    ["an empty result", []],
    ["a null payload (no representation requested)", null],
  ] as const)("reports false for %s, rather than throwing", async (_case, rows) => {
    // Under RLS "not yours" and "already deleted" are the same observation; the endpoint answers 404.
    const stub = stubUpdating(rows as { id: string }[] | null);

    await expect(setWorthWatching(stub.client, SUMMARY_ID, false)).resolves.toBe(false);
  });

  it("throws when PostgREST returns a structured error, keeping the provider message for the log", async () => {
    const stub = stubUpdateFailing("permission denied for table summaries");

    await expect(setWorthWatching(stub.client, SUMMARY_ID, true)).rejects.toThrow(
      "permission denied for table summaries",
    );
  });

  it("lets a transport rejection propagate, so it is not mistaken for zero rows", async () => {
    const cause = new TypeError("fetch failed");
    const stub = stubUpdateRejecting(cause);

    await expect(setWorthWatching(stub.client, SUMMARY_ID, true)).rejects.toBe(cause);
  });

  it.each([true, false, null] as const)(
    "sends exactly { worth_watching: %s } to summaries by id only, asking for the affected rows back",
    async (value) => {
      // Exact payload: the column grant refuses every other column, and `null` must reach the database as
      // a clear rather than being dropped as "no change". One `eq` on id: no user_id predicate, so the
      // policy stays the trust boundary. `.select("id")`: what makes zero rows observable at all.
      const stub = stubUpdating([{ id: SUMMARY_ID }]);

      await setWorthWatching(stub.client, SUMMARY_ID, value);

      expect(stub.from).toHaveBeenCalledExactlyOnceWith("summaries");
      expect(stub.update).toHaveBeenCalledExactlyOnceWith({ worth_watching: value });
      expect(stub.eq).toHaveBeenCalledExactlyOnceWith("id", SUMMARY_ID);
      expect(stub.select).toHaveBeenCalledExactlyOnceWith("id");
    },
  );
});
