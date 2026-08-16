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
 * Balance reads are RLS/`auth.uid()`-scoped to the caller's own row and can only observe it.
 * `beginGeneration` and `refundReservation` take an explicit user id — the first replays another
 * attempt's summary, the second RAISES a balance — so both run only via the service-role admin client.
 *
 * There is deliberately no `settleReservation` here. Settling used to be a best-effort call made after
 * the summary was persisted, which is exactly the gap F23 closed: the charge is now decided inside the
 * same transaction that writes the summary (`persistSummaryAndSettle` in `services/summaries.ts`). The
 * `settle_reservation()` RPC itself remains in the database as an operator-side recovery tool.
 */

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
  // changed under us and must not be read as a silent success — same guard as persistSummaryAndSettle.
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
        // A missing credits row reads as zero, matching the `insufficient` outcome below.
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
 * Why a submission was refused, for a refusal that COSTS the user a credit (S-09 D14). Mirrors the
 * `credit_reservations.refusal_reason` CHECK exactly — the endpoint reconstructs the 422 body from the
 * stored value on a replay, so a reason with no copy behind it would be unanswerable.
 *
 * - `unavailable` — the vendor says this video has no caption track (a fresh 206, or a negative cache row)
 * - `empty`       — a vendor SUCCESS on a wordless video, answered from the cache
 * - `whitespace`  — a transcript arrived and holds no words
 *
 * The transient `failed`/`timeout` outcome is deliberately NOT here: an `error` with a null billable
 * header means the operator's cost is *unknown*, and charging would resolve our own ambiguity against
 * the user.
 */
export type RefusalReason = "unavailable" | "empty" | "whitespace";

/**
 * The outcome of a refusal charge. Deliberately mirrors `beginGeneration`'s vocabulary rather than
 * inventing a second one for the same ledger:
 *
 * - `charged`      — one credit taken, one settled reservation written; `balance` is the result.
 * - `replay`       — this `(userId, requestId)` already carries a non-refunded row. Nothing charged.
 * - `insufficient` — the balance will not cover it. Nothing charged, and NOT an error: the 402 gate
 *                    upstream blocks a zero balance before any paid call, so reaching here short of
 *                    credit means the balance moved mid-request.
 * - `notCharged`   — PostgREST returned a structured error for the RPC call. The reserve-and-settle
 *                    statement raised inside its own transaction, which rolled back atomically — this
 *                    is the one failure mode that PROVES nothing was charged.
 * - `ambiguous`    — the outcome cannot be proven either way: the request promise rejected (a
 *                    transport failure can happen after Postgres commits the debit but before the
 *                    reply arrives), or PostgREST answered without an `error` yet the row was
 *                    missing/malformed — which means the statement most likely ran to completion.
 *                    Callers MUST NOT assert `charged: false` for this outcome.
 */
export type ChargeFailedTranscriptResult =
  | { outcome: "charged"; balance: number }
  | { outcome: "replay"; balance: number }
  | { outcome: "insufficient"; balance: number }
  | { outcome: "notCharged" }
  | { outcome: "ambiguous" };

export interface ChargeFailedTranscriptParams {
  userId: string;
  /**
   * The request's OWN key, never a freshly generated one — that is the single easiest way to get this
   * wrong. A charge keyed independently would bypass both the endpoint's replay handling and the
   * partial unique index, so a client retrying an ambiguous failure would be billed once per attempt.
   * Non-null by type: the caller SKIPS the charge when the client sent no key (a pre-F22 client),
   * because failing toward not charging is the right direction for a fee the user cannot see.
   */
  requestId: string;
  amount: number;
  refusalReason: RefusalReason;
}

/**
 * Log marker for a refusal charge PROVEN not to land (a structured PostgREST error, whose transaction
 * rolled back). The operator absorbed the Supadata credit for this submission; the user was not
 * billed. A cost signal, not a user-facing failure.
 */
const REFUSAL_NOT_CHARGED = "REFUSAL_NOT_CHARGED";

/**
 * Log marker for a refusal charge whose outcome is UNKNOWN — unlike `REFUSAL_NOT_CHARGED`, this does
 * NOT mean the user was not billed. It flags a row worth checking against the ledger by hand (or via
 * the reconciliation query) rather than assuming either direction.
 */
const REFUSAL_CHARGE_AMBIGUOUS = "REFUSAL_CHARGE_AMBIGUOUS";

/**
 * Charges one app credit for a submission we refused and the operator paid for (D14).
 *
 * Reserve and settle are ONE statement inside the RPC, not two calls: there is no work between them
 * to fail, and a row left `reserved` is exactly what the hourly reconciliation sweep refunds — so a
 * pair would be racing that sweep for no benefit.
 *
 * **It never throws, and the direction is the opposite of the debit on the success path.** There, a
 * throw protects the user from paying for work that did not happen. Here, a failure to charge costs
 * the OPERATOR one credit while the user still gets the 422 they were owed — and answering the
 * request matters more than collecting a fee on it.
 *
 * Every failure resolves as `notCharged` or `ambiguous`, never a throw — but the two are NOT
 * interchangeable. `notCharged` is reserved for the one case that proves the debit never landed: a
 * structured PostgREST error, which means the single reserve-and-settle statement raised inside its
 * own transaction and rolled back atomically. Every other failure — a rejected promise, or a
 * successful-looking response with a missing or unrecognised row — cannot rule out that the
 * statement actually committed and only the reply was lost, so it resolves as `ambiguous` instead of
 * guessing `notCharged`.
 */
export async function chargeFailedTranscript(
  admin: SupabaseClient,
  { userId, requestId, amount, refusalReason }: ChargeFailedTranscriptParams,
): Promise<ChargeFailedTranscriptResult> {
  // supabase-js resolves RPC errors into `error`, but a transport-level failure still REJECTS the
  // promise. The try/catch is what makes "never throws" true rather than aspirational — same reason
  // refundReservation carries one. A rejection here means we never learned whether the statement
  // committed, so it resolves as `ambiguous`, not `notCharged`.
  try {
    // The admin client is supabase-js's untyped default (this repo has no generated Database types),
    // so narrow the RPC result at the boundary rather than destructuring `any` — same as
    // beginGeneration.
    const { data, error } = (await admin.rpc("charge_failed_transcript", {
      p_user_id: userId,
      p_request_id: requestId,
      p_amount: amount,
      p_refusal_reason: refusalReason,
    })) as {
      data: { outcome: string; new_balance: number | null }[] | null;
      error: { message: string } | null;
    };

    if (error) {
      // A structured error from PostgREST means the RPC's own statement raised and its transaction
      // rolled back — the one outcome that PROVES no debit landed.
      // eslint-disable-next-line no-console
      console.error(`${REFUSAL_NOT_CHARGED}: ${refusalReason} for ${userId}/${requestId}: ${error.message}`);
      return { outcome: "notCharged" };
    }

    // `returns table(...)` arrives as a one-element array. An empty one means the RPC contract changed
    // under us — but no `error` means the statement executed without raising, so the debit may well
    // have landed. Report it as ambiguous rather than asserting the money was never taken.
    if (!data || data.length === 0) {
      // eslint-disable-next-line no-console
      console.error(`${REFUSAL_CHARGE_AMBIGUOUS}: charge_failed_transcript returned no row for ${userId}/${requestId}`);
      return { outcome: "ambiguous" };
    }
    const row = data[0];

    switch (row.outcome) {
      case "charged":
      case "replay":
      case "insufficient":
        // A missing credits row reads as zero, matching beginGeneration's `insufficient` branch.
        return { outcome: row.outcome, balance: row.new_balance ?? 0 };
      default:
        // Same reasoning as the empty-row branch: the call succeeded, so an unrecognised outcome is a
        // contract mismatch, not proof of no charge.
        // eslint-disable-next-line no-console
        console.error(`${REFUSAL_CHARGE_AMBIGUOUS}: unknown outcome '${row.outcome}' for ${userId}/${requestId}`);
        return { outcome: "ambiguous" };
    }
  } catch (cause) {
    // eslint-disable-next-line no-console
    console.error(`${REFUSAL_CHARGE_AMBIGUOUS}: ${refusalReason} for ${userId}/${requestId}:`, cause);
    return { outcome: "ambiguous" };
  }
}

/**
 * Answers "was this request key closed by a refusal CHARGE, and if so why?" — `null` when it was not.
 *
 * This is what keeps the fee's idempotency honest. The endpoint's identity probe runs before any
 * transcript work, so a repeated `requestId` reaches `begin_generation` first, which sees our settled
 * summary-less row and reports `unavailable` — answered today with a 409 "start a new generation".
 * Without this lookup the retry of a caption-less submit would silently lose the caption-specific 422,
 * and a balance-only check would pass while it happened.
 *
 * **It also never throws, but the fail direction is the OPPOSITE of the charge above and deliberately
 * so**: an error returns `null`, which yields today's 409 rather than a replayed 422. Failing toward
 * the existing behaviour is right for a lookup whose only job is to *improve* a reply that already
 * exists.
 *
 * `null` covers both "no row on this key" and "a row that is not a refusal charge" — the second case
 * is load-bearing rather than a fallback: an operator-side settle writes a settled, summary-less row
 * with no reason, and that row must keep the 409 it was written for.
 */
export async function lookupRefusalReplay(
  admin: SupabaseClient,
  { userId, requestId }: { userId: string; requestId: string },
): Promise<RefusalReason | null> {
  try {
    const { data, error } = (await admin.rpc("get_refusal_replay", {
      p_user_id: userId,
      p_request_id: requestId,
    })) as { data: string | null; error: { message: string } | null };

    if (error) {
      // eslint-disable-next-line no-console
      console.error(`get_refusal_replay failed for ${userId}/${requestId}: ${error.message}`);
      return null;
    }

    // Narrowed at the boundary: the column is CHECKed, but the RPC is untyped here and an unrecognised
    // value has no copy to reconstruct — treat it as "no replay" rather than answer with a lookup miss
    // in the response body.
    if (data === "unavailable" || data === "empty" || data === "whitespace") {
      return data;
    }
    return null;
  } catch (cause) {
    // eslint-disable-next-line no-console
    console.error(`get_refusal_replay failed for ${userId}/${requestId}:`, cause);
    return null;
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
