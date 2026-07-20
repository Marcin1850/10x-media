import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Per-user in-flight generation lock, backed by `public.generation_locks`.
 *
 * The generate endpoint's pre-transcript gate is a plain balance read, so without a lock N
 * concurrent requests from one user would each pay for a Supadata transcript fetch before the
 * atomic debit rejects all but the affordable ones. This bounds that amplification at one.
 *
 * Both RPCs take an explicit `user_id` and are granted to `service_role` only, so they run via the
 * admin client — the generate endpoint already fails 503 in preflight when it is unavailable.
 * Postgres holds the state because concurrent Worker requests can land in different isolates.
 */

/**
 * Returns `true` when the caller now holds the lock, `false` when a generation is already in flight
 * for this user. Throws only on a genuine DB error — the caller should fail the request rather than
 * proceed unlocked, since an unlocked path is exactly the amplification this prevents.
 */
export async function acquireGenerationLock(admin: SupabaseClient, userId: string): Promise<boolean> {
  // The admin client is supabase-js's untyped default (this repo has no generated Database types),
  // so the RPC's `data` arrives as `any`. Narrow it here at the boundary rather than destructuring
  // `any` into the caller's control flow.
  const { data, error } = (await admin.rpc("acquire_generation_lock", { target_user: userId })) as {
    data: boolean | null;
    error: { message: string } | null;
  };

  if (error) {
    throw new Error(`Failed to acquire generation lock: ${error.message}`);
  }

  return data === true;
}

/**
 * Releases the lock. Best-effort and never throws: a failure here costs the user one stale-window
 * wait (the RPC sweeps locks older than its stale threshold), which must not mask the response the
 * endpoint is already returning.
 */
export async function releaseGenerationLock(admin: SupabaseClient, userId: string): Promise<void> {
  const { error } = await admin.rpc("release_generation_lock", { target_user: userId });

  if (error) {
    // eslint-disable-next-line no-console
    console.error(`releaseGenerationLock: failed to release lock for ${userId}: ${error.message}`);
  }
}
