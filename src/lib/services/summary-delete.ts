import type { AppSupabaseClient } from "@/lib/services/summaries";

/**
 * The delete side of `summaries` (S-03). Kept out of `services/summaries.ts`, which is the
 * write/persist path and must stay service-role-only, and out of `summary-list.ts`, whose header
 * scopes it to the read side. This is the same trust class as `listSummaries`: a plain RLS-scoped
 * operation any signed-in session may run, so it takes the anon SSR client and never the admin one.
 */

/**
 * Deletes one summary, reporting whether a row was actually removed.
 *
 * Returns `true` when exactly one row was deleted and `false` when zero rows matched. Under RLS
 * those zero-row cases are indistinguishable — "someone else's row" and "a row that no longer
 * exists" are the same observation — which is why the caller answers a single `404` for both.
 * Throws on a genuine PostgREST error, so the caller can tell "nothing to delete" (a 404) apart
 * from "the delete failed" (a 500).
 *
 * **No `user_id` predicate, deliberately.** The owner-scoped `summaries_delete_authenticated`
 * policy (`20260613145120_videos_and_summaries.sql:61-63`) is the trust boundary; adding a filter
 * here would mask a broadened policy from the tests exactly as `test-plan.md` §6.3 rule 3
 * describes. `.select("id")` is what makes the affected-row count observable at all — a PostgREST
 * `DELETE` without it returns no rows and cannot distinguish "deleted one" from "matched none".
 */
export async function deleteSummary(supabase: AppSupabaseClient, summaryId: string): Promise<boolean> {
  const { data, error } = (await supabase.from("summaries").delete().eq("id", summaryId).select("id")) as unknown as {
    data: { id: string }[] | null;
    error: { message: string } | null;
  };

  if (error) {
    throw new Error(`Failed to delete summary: ${error.message}`);
  }

  return (data ?? []).length > 0;
}
