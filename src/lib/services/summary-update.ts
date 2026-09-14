import type { AppSupabaseClient } from "@/lib/services/summaries";

/**
 * The update side of `summaries` (S-14) — and the only one a client may reach. Every other column is
 * written by the service-role `persist_summary` RPC alone (`20260731130000_summaries_single_writer.sql`);
 * `authenticated` holds UPDATE on `worth_watching` and nothing else
 * (`20260914120000_summaries_worth_watching.sql`). Same trust class as `deleteSummary`: a plain RLS-scoped
 * statement, so it takes the anon SSR client and never the admin one.
 */

/**
 * Sets the user's watch/skip mark on one summary: `true` worth watching, `false` not worth watching,
 * `null` clears it.
 *
 * Returns `true` when a row was updated and `false` when zero rows matched — under RLS "someone else's
 * row" and "a row that no longer exists" are the same observation, so the caller answers one `404` for
 * both. Throws on a PostgREST error; a transport rejection propagates.
 *
 * **The payload is exactly `{ worth_watching }`.** The column grant refuses any other column, so sending
 * one would fail every mark. **No `user_id` predicate**, for the reason `deleteSummary` gives: the
 * owner-scoped `summaries_update_authenticated` policy is the trust boundary, and a filter here would mask
 * a broadened one (`test-plan.md` §6.3 rule 3). `.select("id")` makes the affected-row count observable.
 */
export async function setWorthWatching(
  supabase: AppSupabaseClient,
  summaryId: string,
  value: boolean | null,
): Promise<boolean> {
  const { data, error } = (await supabase
    .from("summaries")
    .update({ worth_watching: value })
    .eq("id", summaryId)
    .select("id")) as unknown as {
    data: { id: string }[] | null;
    error: { message: string } | null;
  };

  if (error) {
    throw new Error(`Failed to update summary: ${error.message}`);
  }

  return (data ?? []).length > 0;
}
