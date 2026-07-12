import type { AppSupabaseClient } from "@/lib/services/summaries";

/**
 * Credit enforcement shared by every generation call site (the F-02 probe today, S-01 later).
 * Reads are RLS-scoped to the caller's own row; the only balance mutation exposed here is the
 * atomic `spend_credit()` RPC, which can only ever lower the caller's own balance.
 */

/** The `spend_credit()` SQL function returns this sentinel when there was nothing to spend (missing row or already 0). */
const INSUFFICIENT_SENTINEL = -1;

/** Reads the caller's current balance (own row, RLS-scoped). Returns `null` when no row exists. */
export async function getBalance(supabase: AppSupabaseClient, userId: string): Promise<number | null> {
  const { data, error } = await supabase.from("user_credits").select("balance").eq("user_id", userId).maybeSingle();

  if (error) {
    throw new Error(`Failed to read credit balance: ${error.message}`);
  }

  return data?.balance ?? null;
}

export interface SpendResult {
  /** `false` when the balance was already 0 / the row was missing — never an exception. */
  ok: boolean;
  /** The new balance after a successful spend; `0` when insufficient (nothing was debited). */
  balance: number;
}

/**
 * Atomically spends one credit from the caller's own balance via the `spend_credit()` RPC.
 * Returns `{ ok: false, balance: 0 }` when there was nothing to spend (the insufficient sentinel);
 * throws only on a genuine DB error.
 */
export async function spendCredit(supabase: AppSupabaseClient): Promise<SpendResult> {
  const { data, error } = await supabase.rpc("spend_credit");

  if (error) {
    throw new Error(`Failed to spend credit: ${error.message}`);
  }

  if (data === INSUFFICIENT_SENTINEL) {
    return { ok: false, balance: 0 };
  }

  return { ok: true, balance: data };
}
