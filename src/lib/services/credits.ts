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
 * a balance. `beginGeneration` and `refundReservation` take an explicit user id — the first replays
 * another attempt's summary, the second RAISES a balance — so both run only via the service-role
 * admin client.
 *
 * There is deliberately no `settleReservation` here. Settling used to be a best-effort call made after
 * the summary was persisted, which is exactly the gap F23 closed: the charge is now decided inside the
 * same transaction that writes the summary (`persistSummaryAndSettle` in `services/summaries.ts`). The
 * `settle_reservation()` RPC itself remains in the database as an operator-side recovery tool.
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
 * The outcome of an idempotent generation start. Discriminated on `outcome` so each branch carries
 * exactly the fields it can supply:
 *
 * - `reserved`    — a new operation: the balance is debited and `reservationId` must be settled (by
 *                   `persistSummaryAndSettle`) or refunded on every exit path past this point.
 * - `fresh`       — probe only: no prior attempt on this key, so the caller may do the expensive work.
 * - `replay`      — this request key already produced a summary. NOTHING was written or charged; the
 *                   caller returns the original result verbatim and never calls the LLM.
 * - `inProgress`  — another attempt on this key is still running.
 * - `unavailable` — this key's debit was closed without producing a summary. Neither replayable nor
 *                   re-runnable; the caller must start a new operation.
 * - `insufficient`— not enough credits; `balance` is the caller's actual, unchanged balance.
 */
export type BeginGenerationResult =
  | { outcome: "reserved"; reservationId: string; balance: number }
  | { outcome: "fresh" }
  | {
      outcome: "replay";
      reservationId: string;
      balance: number;
      cost: number;
      summaryId: string;
      videoId: string;
      content: string;
      model: string | null;
    }
  | { outcome: "inProgress" }
  | { outcome: "unavailable" }
  | { outcome: "insufficient"; balance: number };

export interface BeginGenerationParams {
  userId: string;
  /**
   * Client-generated key identifying ONE user-initiated generation, repeated verbatim when the client
   * retries after an ambiguous failure. `null` disables deduplication for this call — the expand-only
   * fallback for a cached client that predates F22, which behaves exactly like a bare reserve.
   */
  requestId: string | null;
  /**
   * Credits to debit, or `null` to PROBE — answer the identity question without charging. The endpoint
   * probes before the paid transcript fetch (it cannot price the work until it has the transcript, and
   * re-fetching one just to throw it away is duplicate provider spend) and debits for real afterwards.
   */
  amount: number | null;
}

/**
 * Opens a debit for a generation, or recognises the request as a repeat of one already done (F22).
 *
 * This supersedes `reserveCredits` on the generate path. The endpoint debits before the paid LLM call
 * and appends a summary after it, so before this existed an ambiguous retry — request delivered, reply
 * lost — started a genuinely second operation: second reservation, second OpenRouter call, second
 * summary row. The reservation ledger could not help, because at its level of description two
 * generations really did happen. Idempotency has to sit above it, keyed by an identity the client owns
 * and repeats.
 *
 * Deciding "new or repeat?" and acting on it must be one transaction or two concurrent duplicates both
 * decide "new" — hence a single RPC rather than a read followed by `reserveCredits`. Takes the ADMIN
 * client: the RPC debits on an explicit user's behalf and reads back that user's summary to replay it,
 * so it is service_role only. Throws only on a genuine DB error.
 */
export async function beginGeneration(
  admin: SupabaseClient,
  { userId, requestId, amount }: BeginGenerationParams,
): Promise<BeginGenerationResult> {
  // The admin client is supabase-js's untyped default (this repo has no generated Database types), so
  // narrow the RPC result at the boundary rather than destructuring `any` — same as persistSummaryAndSettle.
  const { data, error } = (await admin.rpc("begin_generation", {
    target_user: userId,
    request: requestId,
    amount,
  })) as {
    data:
      | {
          outcome: string;
          reservation_id: string | null;
          new_balance: number | null;
          summary_id: string | null;
          video_id: string | null;
          content: string | null;
          model: string | null;
          cost: number | null;
        }[]
      | null;
    error: { message: string } | null;
  };

  if (error) {
    throw new Error(`Failed to begin generation: ${error.message}`);
  }

  // `returns table(...)` arrives as a one-element array. An empty one would mean the RPC contract
  // changed under us and must not be read as a silent success — same guard as reserveCredits.
  if (!data || data.length === 0) {
    throw new Error("Failed to begin generation: begin_generation returned no row");
  }
  const row = data[0];

  switch (row.outcome) {
    case "reserved": {
      // A debit without its id is unrecoverable — nothing could later settle or refund it. Treat the
      // contract violation as an error rather than returning a reservation the caller cannot close.
      if (!row.reservation_id || row.new_balance === null) {
        throw new Error("Failed to begin generation: balance was debited without a reservation id");
      }
      return { outcome: "reserved", reservationId: row.reservation_id, balance: row.new_balance };
    }
    case "replay": {
      if (!row.reservation_id || !row.summary_id || !row.video_id || row.content === null) {
        throw new Error("Failed to begin generation: replay returned without a summary");
      }
      return {
        outcome: "replay",
        reservationId: row.reservation_id,
        // A missing credits row reads as zero, matching reserveCredits' insufficient path.
        balance: row.new_balance ?? 0,
        cost: row.cost ?? 1,
        summaryId: row.summary_id,
        videoId: row.video_id,
        content: row.content,
        model: row.model,
      };
    }
    case "fresh":
      return { outcome: "fresh" };
    case "in_progress":
      return { outcome: "inProgress" };
    case "unavailable":
      return { outcome: "unavailable" };
    case "insufficient":
      return { outcome: "insufficient", balance: row.new_balance ?? 0 };
    default:
      throw new Error(`Failed to begin generation: unknown outcome '${row.outcome}'`);
  }
}

/**
 * Log marker for a debit that could not be resolved. Unlike the previous bare-refund design this is
 * no longer the only trace — the reservation row stays `reserved` in the ledger, so the debt is
 * recoverable by the reconciliation query even if this log line is lost.
 */
const CREDIT_LEAK = "CREDIT_LEAK";

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

  // supabase-js resolves RPC errors into `error`, but a transport-level failure still REJECTS the
  // promise — and this runs on the failure path, where an extra throw would mask the real generation
  // error. The try/catch is what makes "never throws" true rather than aspirational.
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
