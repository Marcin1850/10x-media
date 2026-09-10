import type { SupabaseClient } from "@supabase/supabase-js";
import { captureEvent } from "@/lib/services/reporting";

/**
 * Per-user in-flight generation lock, backed by `public.generation_locks`.
 *
 * The generate endpoint's pre-transcript gate is a plain balance read, so without a lock N
 * concurrent requests from one user would each pay for a Supadata transcript fetch before the
 * atomic debit rejects all but the affordable ones. This bounds that amplification at one.
 *
 * Each acquisition mints an opaque lease id and release requires it. Without that identity, release
 * is ownerless: a request that stalls past the stale window is swept and replaced, and its later
 * release would delete its *successor's* lock — letting a third request run alongside the second,
 * which is the amplification this exists to prevent.
 *
 * Both RPCs take an explicit `user_id` and are granted to `service_role` only, so they run via the
 * admin client — the generate endpoint already fails 503 in preflight when it is unavailable.
 * Postgres holds the state because concurrent Worker requests can land in different isolates.
 */

/**
 * Returns the lease id when the caller now holds the lock, `null` when a generation is already in
 * flight for this user. Throws only on a genuine DB error — the caller should fail the request
 * rather than proceed unlocked, since an unlocked path is exactly the amplification this prevents.
 */
export async function acquireGenerationLease(admin: SupabaseClient, userId: string): Promise<string | null> {
  // The admin client is supabase-js's untyped default (this repo has no generated Database types),
  // so the RPC's `data` arrives as `any`. Narrow it here at the boundary rather than destructuring
  // `any` into the caller's control flow.
  const { data, error } = (await admin.rpc("acquire_generation_lease", { target_user: userId })) as {
    data: string | null;
    error: { message: string } | null;
  };

  if (error) {
    throw new Error(`Failed to acquire generation lock: ${error.message}`);
  }

  return data;
}

/**
 * Releases the caller's own lease. Best-effort and never throws: a failure here costs the user one
 * stale-window wait (the acquire RPC sweeps locks older than its stale threshold), which must not
 * mask the response the endpoint is already returning.
 *
 * A `false` result is not an error but is worth logging — it means the lease was already swept, so
 * this generation ran past the stale window and may have overlapped a successor.
 */
export async function releaseGenerationLease(admin: SupabaseClient, userId: string, lease: string): Promise<void> {
  // The whole RPC is wrapped so a transport-level rejection (not just an application `error`) can't
  // escape: this runs in the endpoint's `finally`, where a throw would replace the response the
  // endpoint already produced — turning a saved-and-charged success into a framework 500 and inviting
  // a duplicate retry. Losing the lock only costs one stale-window wait, so we always resolve.
  try {
    const { data, error } = (await admin.rpc("release_generation_lease", {
      target_user: userId,
      lease,
    })) as { data: boolean | null; error: { message: string } | null };

    if (error) {
      // eslint-disable-next-line no-console
      console.error(`releaseGenerationLease: failed to release lock for ${userId}: ${error.message}`);
      // Forwarded as well as logged (S-13): a lock that will not release makes every next generation for
      // that user wait out the stale window, and nothing but this line says why. The console keeps the
      // account; the forwarded event does not — the degradation family is outside the seam's identifier
      // exception (`reporting.ts`), so the payload carries the failure only.
      captureEvent("[generation-lock:release-failed]", "error", { error: error.message });
      return;
    }

    if (data !== true) {
      // eslint-disable-next-line no-console
      console.warn(`releaseGenerationLease: lease ${lease} for ${userId} was already swept as stale`);
      // `warn`, not `error`: a sweep is expected under load. What the operator wants is the RATE, which the
      // issue's event count already is — so the payload is deliberately empty rather than carrying a lease
      // id that names nothing once the row is gone.
      captureEvent("[generation-lock:release-swept]", "warn", {});
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`releaseGenerationLease: RPC threw releasing lock for ${userId}:`, err);
    captureEvent("[generation-lock:release-threw]", "error", { error: String(err) });
  }
}
