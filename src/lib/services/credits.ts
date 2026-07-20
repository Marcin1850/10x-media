import type { SupabaseClient } from "@supabase/supabase-js";
import type { AppSupabaseClient } from "@/lib/services/summaries";

/**
 * Credit enforcement shared by every generation call site (the S-01 generate endpoint).
 *
 * Debits are RESERVATIONS, not bare decrements. Because the generate endpoint debits before the paid
 * LLM call, the compensating path is what upholds "failed work never charges the user" — and a bare
 * `balance + amount` refund could neither survive its own failure (nothing recorded the debt) nor be
 * safely retried (nothing distinguished a retry from a second refund). Every debit therefore writes a
 * `reserved` row that is later moved to `settled` or `refunded`; a debit stuck in `reserved` is a
 * durable, queryable record of a user owed credits. See the reconciliation query in
 * `20260720160000_credit_reservations.sql`.
 *
 * Reads and `reserve_credits` are RLS/`auth.uid()`-scoped to the caller's own row and can only lower
 * a balance. `settleReservation` and `refundReservation` take an explicit user id and RAISE balances,
 * so they run only via the service-role admin client.
 */

/** `reserve_credits()` returns this in `new_balance` when there was nothing to spend (missing row or insufficient balance). */
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

/**
 * Discriminated on `ok` so callers narrow to a non-null `reservationId` without a redundant check:
 * a successful debit ALWAYS carries the id needed to settle or refund it.
 *
 * `balance` is the new balance after a successful reserve; on insufficient, the caller's actual
 * (unchanged) balance. `ok: false` means insufficient / missing row — never an exception.
 */
export type ReserveResult =
  | { ok: true; balance: number; reservationId: string }
  | { ok: false; balance: number; reservationId: null };

/**
 * Atomically debits `amount` credits (default 1) from the caller's own balance and opens a matching
 * ledger row, in one transaction, via the `reserve_credits()` RPC. On the insufficient sentinel it
 * re-reads the caller's actual balance so callers can report "you have <balance>" accurately (a
 * 2-credit spend at balance 1 must not report 0). Throws only on a genuine DB error.
 */
export async function reserveCredits(supabase: AppSupabaseClient, amount = 1): Promise<ReserveResult> {
  const { data, error } = await supabase.rpc("reserve_credits", { amount });

  if (error) {
    throw new Error(`Failed to reserve credits: ${error.message}`);
  }

  // `returns table(...)` arrives as a one-element array. The declared type says non-empty, but that
  // is our own hand-written shape, not a generated one — an empty array would mean the RPC contract
  // changed under us, and must not be read as a silent success. Length-checked rather than
  // `data?.[0]` so the guard survives the type saying it can't happen.
  if (data.length === 0) {
    throw new Error("Failed to reserve credits: reserve_credits returned no row");
  }
  const row = data[0];

  if (row.new_balance === INSUFFICIENT_SENTINEL) {
    return { ok: false, balance: (await getBalance(supabase)) ?? 0, reservationId: null };
  }

  if (!row.reservation_id) {
    throw new Error("Failed to reserve credits: balance was debited without a reservation id");
  }

  return { ok: true, balance: row.new_balance, reservationId: row.reservation_id };
}

/**
 * Log marker for a debit that could not be resolved. Unlike the previous bare-refund design this is
 * no longer the only trace — the reservation row stays `reserved` in the ledger, so the debt is
 * recoverable by the reconciliation query even if this log line is lost.
 */
const CREDIT_LEAK = "CREDIT_LEAK";

/**
 * Closes a reservation after a SUCCESSFUL generation: the user keeps paying for work they received.
 * Best-effort — a failure here leaves the row `reserved`, which the reconciliation sweep would treat
 * as an unresolved debit, so it logs loudly. It must never throw: the summary is already persisted
 * and returning an error for a bookkeeping failure would be worse than the stale row.
 */
export async function settleReservation(
  admin: SupabaseClient,
  userId: string,
  reservationId: string,
): Promise<boolean> {
  // The try/catch is what makes "never throws" true rather than aspirational: supabase-js resolves
  // RPC errors into `error`, but a transport-level failure still rejects the promise.
  try {
    const { data, error } = (await admin.rpc("settle_reservation", {
      target_user: userId,
      reservation: reservationId,
    })) as { data: boolean | null; error: { message: string } | null };

    if (error) {
      // eslint-disable-next-line no-console
      console.error(`${CREDIT_LEAK}: failed to settle reservation ${reservationId} for ${userId}: ${error.message}`);
      return false;
    }

    return data === true;
  } catch (cause) {
    // eslint-disable-next-line no-console
    console.error(`${CREDIT_LEAK}: failed to settle reservation ${reservationId} for ${userId}:`, cause);
    return false;
  }
}

/**
 * Reverses a debit after a FAILED generation. Raises a balance, so it runs via the service-role admin
 * client only (`refund_reservation` is granted to `service_role`). Idempotent by construction: the
 * RPC only refunds a row still in `reserved`, so retrying after an ambiguous response cannot credit
 * twice — it returns `false` instead.
 *
 * Best-effort: on any error it logs and resolves without throwing, so it never masks the original
 * generation failure being returned to the user. Returns `false` when the debit was NOT reversed —
 * either because it failed (row stays `reserved`, recoverable via reconciliation) or because it was
 * already resolved.
 */
export async function refundReservation(
  admin: SupabaseClient,
  userId: string,
  reservationId: string,
): Promise<boolean> {
  const recoverable = "row remains 'reserved' and is recoverable via the reconciliation query";

  // See settleReservation: a transport-level failure rejects rather than populating `error`, and this
  // runs on the failure path where an extra throw would mask the real generation error.
  try {
    const { data, error } = (await admin.rpc("refund_reservation", {
      target_user: userId,
      reservation: reservationId,
    })) as { data: boolean | null; error: { message: string } | null };

    if (error) {
      // eslint-disable-next-line no-console
      console.error(
        `${CREDIT_LEAK}: failed to refund reservation ${reservationId} for ${userId}: ${error.message} — ${recoverable}`,
      );
      return false;
    }

    return data === true;
  } catch (cause) {
    // eslint-disable-next-line no-console
    console.error(
      `${CREDIT_LEAK}: failed to refund reservation ${reservationId} for ${userId} — ${recoverable}:`,
      cause,
    );
    return false;
  }
}
