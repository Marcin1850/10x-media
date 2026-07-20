import type { SupabaseClient } from "@supabase/supabase-js";
import type { AppSupabaseClient } from "@/lib/services/summaries";

/**
 * Credit enforcement shared by every generation call site (the S-01 generate endpoint).
 * Reads are RLS-scoped to the caller's own row; the only user-reachable balance mutation exposed
 * here is the atomic `spend_credits()` RPC, which can only ever lower the caller's own balance.
 * `refundCredits` reverses a debit and RAISES a balance, so it runs only via the admin client.
 */

/** The `spend_credits()` SQL function returns this sentinel when there was nothing to spend (missing row or insufficient balance). */
const INSUFFICIENT_SENTINEL = -1;

/**
 * Reads the caller's current balance. When `userId` is omitted the read is scoped by RLS
 * (`auth.uid() = user_id`) to the caller's own row. Returns `null` when no row exists.
 */
export async function getBalance(supabase: AppSupabaseClient, userId?: string): Promise<number | null> {
  const query = supabase.from("user_credits").select("balance");
  const { data, error } = await (userId ? query.eq("user_id", userId) : query).maybeSingle();

  if (error) {
    throw new Error(`Failed to read credit balance: ${error.message}`);
  }

  return data?.balance ?? null;
}

export interface SpendResult {
  /** `false` when the balance was insufficient / the row was missing — never an exception. */
  ok: boolean;
  /** The new balance after a successful spend; on insufficient, the caller's actual (unchanged) balance. */
  balance: number;
}

/**
 * Atomically spends `amount` credits (default 1) from the caller's own balance via the
 * `spend_credits()` RPC. On the insufficient sentinel it re-reads the caller's actual balance so
 * callers can report "you have <balance>" accurately (a 2-credit spend at balance 1 must not report 0).
 * Throws only on a genuine DB error.
 */
export async function spendCredit(supabase: AppSupabaseClient, amount = 1): Promise<SpendResult> {
  const { data, error } = await supabase.rpc("spend_credits", { amount });

  if (error) {
    throw new Error(`Failed to spend credit: ${error.message}`);
  }

  if (data === INSUFFICIENT_SENTINEL) {
    return { ok: false, balance: (await getBalance(supabase)) ?? 0 };
  }

  return { ok: true, balance: data };
}

/**
 * Log marker for a debit that could not be reversed. Grep for it to find users owed credits — this
 * is the manual reconciliation path until a reservation ledger exists.
 */
const CREDIT_LEAK = "CREDIT_LEAK";

/**
 * Reverses a debit after a failed generation by crediting `amount` back to `userId`. Because it
 * raises a balance it must never be user-callable — it runs via the service-role admin client and
 * the `refund_credits` RPC is granted to `service_role` only. Best-effort compensating action:
 * on any error it logs and resolves without throwing, so it never masks the original generation
 * failure being returned to the user. Returns `false` when the user is still charged, so callers
 * can tell an honoured invariant from a leaked debit.
 *
 * Callers must ensure `admin` is non-null *before* debiting (the generate endpoint fails 503 in
 * preflight when it isn't) — a null client here means the debit is already unrecoverable.
 */
export async function refundCredits(admin: SupabaseClient | null, userId: string, amount: number): Promise<boolean> {
  if (!admin) {
    // eslint-disable-next-line no-console
    console.error(`${CREDIT_LEAK}: admin client unavailable, cannot refund ${amount} credit(s) to ${userId}`);
    return false;
  }

  const { error } = await admin.rpc("refund_credits", { target_user: userId, amount });
  if (error) {
    // eslint-disable-next-line no-console
    console.error(`${CREDIT_LEAK}: failed to refund ${amount} credit(s) to ${userId}: ${error.message}`);
    return false;
  }

  return true;
}
