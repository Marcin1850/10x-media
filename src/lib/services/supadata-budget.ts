import type { SupabaseClient } from "@supabase/supabase-js";
import { RETRY_DELAY_MS } from "./metadata";

/**
 * Lever C — the Supadata budget breaker (S-09 D5).
 *
 * Lever A bounds what ONE generation can cost. Nothing bounds the FLEET, so a Free (100/mo) plan can
 * still be drained by ordinary traffic and the first anyone hears of it is users seeing errors. This
 * module refuses to START paid work when the plan is nearly exhausted.
 *
 * It gates SPEND, NOT THE REQUEST (D5, minimal form). A cache hit costs 0 and is never blocked — the
 * breaker sits in front of the two paid provider calls and nowhere else.
 *
 * Two sources, neither sufficient alone. `GET /v1/me` is authoritative but is an HTTP call that would
 * land directly in front of the transcript fetch and break the 1 req/s spacing `generate.ts` maintains
 * between its two Supadata requests. Reservations are free and instant but do not know when the
 * vendor's billing period resets, so a purely local total drifts out of phase. The reading ANCHORS,
 * the reservations TRACK SPEND SINCE THE ANCHOR, and `reserve_supadata_credits` combines them under
 * one row lock (see `20260731150000_supadata_budget.sql`).
 *
 * **Total by contract**, like every other provider service here, and for a sharper reason than usual:
 * the second check point sits AFTER the user has been debited and the LLM has been paid for, where a
 * throw would bypass the refund path and strand both the app-credit reservation and the provider
 * reservation. `reserveBudget` and `settleBudget` are typed to resolve, never reject.
 *
 * **Fails open.** With neither a stored reading nor a usable `/v1/me`, the answer is "proceed" — a
 * vendor outage on a FREE bookkeeping endpoint must not break a product whose transcript API is fine.
 * This differs from `recordTranscriptAttempt`'s fail-closed rate limit, deliberately: that guard
 * protects against unbounded spend, this one against a bounded overrun of a recoverable budget. The
 * unreadable state is itself reported through the seam — otherwise the guard is silently off during
 * exactly the window nobody can see.
 */

/**
 * How long a stored reading is trusted before one caller is sent to refresh it. 15 minutes.
 *
 * The reading only has to be good enough to anchor: every credit spent since it was taken is tracked
 * locally in `supadata_reservations`, so a stale reading does not mean an unknown balance — it means
 * an unknown RESET, since only the vendor knows when the billing period rolls over. Fifteen minutes
 * bounds that blind spot while costing roughly four `/v1/me` calls an hour, all of them free.
 */
export const BUDGET_READING_MAX_AGE_SECONDS = 900;

/** Report a near-miss once the plan is this far spent. Decorative until a receiver lands (D5b). */
export const BUDGET_WARN_FRACTION = 0.8;

/**
 * What the transcript check point reserves. Exactly 1: `TRANSCRIPT_MODE = 'native'` (D1) caps a
 * transcript at one billable request, which is lever A's entire contribution.
 */
export const TRANSCRIPT_BUDGET_CREDITS = 1;

/**
 * What the metadata check point reserves. **2, not 1** — `fetchVideoMetadata` retries a retryable
 * failure once and that retry is a SEPARATELY BILLED request (`metadata.ts`, `isRetryable` +
 * `RETRY_DELAY_MS`). The retry happens INSIDE the helper, so the breaker cannot gate it; what it can
 * do is refuse to start the call unless BOTH requests fit. **Reserve the maximum, not the
 * expectation** — this is where the 3-credit ceiling stops being an aspiration and becomes enforced.
 */
export const METADATA_BUDGET_CREDITS = 2;

/**
 * Credits kept in reserve — a call is refused when it would leave fewer than this behind.
 *
 * **Derived, not picked**, and written as the sum so the derivation cannot rot: it is the worst-case
 * Supadata cost of ONE generation under lever A — 1 transcript request plus **up to 2** metadata
 * requests. A reader who counts one metadata call will "correct" this to 2 and reopen exactly the
 * overdraw the constant exists to close; the two operands above each carry their own reasoning.
 * Refusing when `max - used - outstanding < 3` is precisely the condition under which a generation
 * could take the plan negative.
 */
export const BUDGET_STOP_RESERVE = TRANSCRIPT_BUDGET_CREDITS + METADATA_BUDGET_CREDITS;

/**
 * How long an unsettled reservation is honoured before the sweep reclaims it. 600 s.
 *
 * A Worker killed mid-call leaves a row behind; without a sweep that row holds its credits against the
 * fleet forever. The window is chosen against the CEILING of the operations it guards, not the typical
 * case, because a sweep that fires early un-reserves a call that is still running and reopens the very
 * race the reservation exists to close:
 *
 *   Transcript fetch      90 s  — `TRANSCRIPT_TIMEOUT_MS`
 *   Job poll path       ~240 s  — 12 attempts, 1 s doubling to a 30 s cap. UNREACHABLE under D1
 *   Metadata, both       ~21 s  — `METADATA_TIMEOUT_MS` 10 s x 2 plus the 1.2 s spacing
 *
 * 600 s clears the longest REACHABLE ceiling by more than 6x and still clears the unreachable poll
 * path by 2.5x — so the number survives D1 ever being reverted, which is the scenario that would
 * otherwise silently invalidate it. Erring long costs a temporarily over-conservative breaker; erring
 * short costs correctness. It also matches `acquire_generation_lease`'s existing 600 s default, so the
 * two stale windows in this codebase stay one number rather than a pair a reader has to distinguish.
 *
 * Passed to the RPC rather than restated in SQL, so the window is one number in one place.
 */
export const RESERVATION_STALE_SECONDS = 600;

/**
 * Deadline for `GET /v1/me`. Deliberately ONE FIFTH of `METADATA_TIMEOUT_MS`.
 *
 * Metadata's 10 s buys a real user-visible value and is spent after the debit; this call is advisory
 * bookkeeping that sits IN FRONT OF paid work. Waiting ten seconds to discover we cannot learn
 * anything is strictly worse than failing open in two, because the wait is added to the request that
 * claimed the refresh. Two seconds is far above the observed latency of a small JSON endpoint and far
 * below the point where a user notices.
 *
 * Enforced with `AbortSignal.timeout`, the same mechanism `METADATA_TIMEOUT_MS` uses and for the same
 * reason: Cloudflare caps CPU time, not time spent waiting on a subrequest, so nothing else bounds it.
 */
export const BUDGET_READ_TIMEOUT_MS = 2_000;

/** The origin the vendor's REST API is served from, matching `metadata.ts`. */
const SUPADATA_BASE_URL = "https://api.supadata.ai/v1";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The figures behind a decision, read under the SAME row lock that made it.
 *
 * Not telemetry padding: `reportBudgetThreshold` promises a self-sufficient payload, and the only
 * alternative is a second query after the lock is released — which races every other reserve and
 * reports numbers that never coexisted. That is worse than useless in an incident.
 */
export interface BudgetStatistics {
  maxCredits: number | null;
  usedCredits: number | null;
  /** Credits held by reservations written since the reading — local spend the vendor has not seen. */
  outstanding: number | null;
  /** When the reading was taken. Null only when the decision was made without one. */
  readAt: string | null;
}

/**
 * What `reserveBudget` resolved to. A THREE-CASE UNION, not `id | null` — see `untracked`.
 *
 * - `reserved`  — the spend is authorized. The caller MUST settle in a `finally`.
 * - `refused`   — over the stop reserve. The caller skips the call.
 * - `untracked` — we could not track this call, so PROCEED AND SETTLE NOTHING.
 *
 * **`untracked` must not be collapsed into either neighbour.** Failing open means proceeding WITHOUT a
 * reservation, so it is not `reserved` — there is no id to settle, and a settle against a missing row
 * is exactly the silent corruption the sweep cannot detect. Nor is it `refused` — the call goes ahead.
 * Every fail-open path lands here: an RPC error, an `uninitialized` reading nobody has refreshed yet, a
 * failed or timed-out `/v1/me`, a malformed body, and a second pass that did not terminate. Typing
 * this as `id | null` and branching on truthiness is the predictable shortcut, and it makes "we could
 * not track this call" and "we tracked it" indistinguishable at the call site.
 */
export type ReserveBudgetResult =
  | { outcome: "reserved"; reservationId: string; stats: BudgetStatistics }
  | { outcome: "refused"; stats: BudgetStatistics }
  | { outcome: "untracked"; reason: string };

/** The raw RPC outcome, before the refresh is resolved. `refreshRequired` never escapes this module. */
type ReserveRpcResult =
  | { outcome: "reserved"; reservationId: string; stats: BudgetStatistics }
  | { outcome: "refused"; stats: BudgetStatistics }
  | { outcome: "refreshRequired"; stats: BudgetStatistics }
  | { outcome: "uninitialized" }
  | { outcome: "error"; message: string };

/**
 * A budget event worth someone's attention. Its payload is SELF-SUFFICIENT by design — used, max, the
 * local delta, which threshold fired and how old the reading was — so the event is legible without a
 * database query, which is the whole point of an event that will one day be delivered somewhere else.
 */
export interface BudgetThresholdEvent {
  /**
   * - `stop`      — a paid call was REFUSED. An incident.
   * - `warn`      — the plan is `BUDGET_WARN_FRACTION` spent. A near miss.
   * - `untracked` — the guard could not evaluate and let the call through. The guard being blind.
   */
  threshold: "stop" | "warn" | "untracked";
  maxCredits: number | null;
  usedCredits: number | null;
  outstanding: number | null;
  /** Age of the reading the decision rested on, in seconds. Null when there was no reading. */
  readingAgeSeconds: number | null;
  /** Why the call could not be tracked. Only ever set on `untracked`. */
  reason?: string;
}

/** Stable search key for every budget event. Counted per threshold in Workers logs. DO NOT REWORD. */
const BUDGET_EVENT = "[supadata-budget]";

/**
 * The notification seam (D5) — ONE named function, deliberately, and not a logging abstraction.
 *
 * Error-monitoring tools capture exceptions and treat console output as breadcrumbs attached to OTHER
 * events, so a bare `console.warn` at each call site may never become an alert. This is the single
 * swappable point for when a receiver lands.
 *
 * **`stop` and `untracked` emit at higher severity than `warn`.** A refusal is an incident, not a
 * warning, and reporting only the warn level would surface the near-miss while hiding the actual
 * outage; a guard that cannot evaluate is likewise not a near-miss.
 *
 * **Deliberately incomplete (D5b)**: nothing receives these events yet. Until a monitoring tool lands
 * the warn threshold is decorative, and budget exhaustion surfaces through the stop threshold — users
 * seeing an error, the worst channel and the one lever C exists to avoid.
 */
export function reportBudgetThreshold(event: BudgetThresholdEvent): void {
  const payload = JSON.stringify(event);
  if (event.threshold === "warn") {
    // eslint-disable-next-line no-console
    console.warn(`${BUDGET_EVENT} ${payload}`);
    return;
  }
  // eslint-disable-next-line no-console
  console.error(`${BUDGET_EVENT} ${payload}`);
}

/** Seconds since a reading was taken, or null when there is none. Never throws on a bad timestamp. */
function readingAgeSeconds(readAt: string | null): number | null {
  if (readAt === null) return null;
  const taken = new Date(readAt).getTime();
  if (Number.isNaN(taken)) return null;
  return Math.max(0, Math.round((Date.now() - taken) / 1000));
}

/** Reports the fail-open and returns it, so every `untracked` exit is one expression. */
function untracked(reason: string, stats?: BudgetStatistics): ReserveBudgetResult {
  reportBudgetThreshold({
    threshold: "untracked",
    maxCredits: stats?.maxCredits ?? null,
    usedCredits: stats?.usedCredits ?? null,
    outstanding: stats?.outstanding ?? null,
    readingAgeSeconds: readingAgeSeconds(stats?.readAt ?? null),
    reason,
  });
  return { outcome: "untracked", reason };
}

/**
 * One `reserve_supadata_credits` round trip, narrowed at the boundary.
 *
 * Never throws: a Supabase error resolves as `error`, which the caller turns into a fail-open. The
 * admin client is supabase-js's untyped default, so the row is narrowed rather than destructured as
 * `any` — the same treatment `beginGeneration` gives its RPC.
 */
async function callReserveRpc(admin: SupabaseClient, credits: number): Promise<ReserveRpcResult> {
  try {
    const { data, error } = (await admin.rpc("reserve_supadata_credits", {
      p_credits: credits,
      p_stop_reserve: BUDGET_STOP_RESERVE,
      p_reading_max_age_seconds: BUDGET_READING_MAX_AGE_SECONDS,
      p_stale_seconds: RESERVATION_STALE_SECONDS,
    })) as {
      data:
        | {
            outcome: string;
            reservation_id: string | null;
            max_credits: number | null;
            used_credits: number | null;
            outstanding: number | null;
            read_at: string | null;
          }[]
        | null;
      error: { message: string } | null;
    };

    if (error) return { outcome: "error", message: error.message };
    if (!data || data.length === 0) {
      return { outcome: "error", message: "reserve_supadata_credits returned no row" };
    }

    const row = data[0];
    const stats: BudgetStatistics = {
      maxCredits: row.max_credits,
      usedCredits: row.used_credits,
      outstanding: row.outstanding,
      readAt: row.read_at,
    };

    switch (row.outcome) {
      case "reserved":
        // A reservation without its id is unsettleable, so it is a contract violation rather than a
        // success — and treating it as one would hold credits against the fleet until the sweep.
        if (!row.reservation_id) {
          return { outcome: "error", message: "reserve_supadata_credits authorized spend without an id" };
        }
        return { outcome: "reserved", reservationId: row.reservation_id, stats };
      case "refused":
        return { outcome: "refused", stats };
      case "refresh_required":
        return { outcome: "refreshRequired", stats };
      case "uninitialized":
        return { outcome: "uninitialized" };
      default:
        return { outcome: "error", message: `unknown outcome '${row.outcome}'` };
    }
  } catch (cause) {
    return { outcome: "error", message: cause instanceof Error ? cause.message : "reserve RPC rejected" };
  }
}

/**
 * `GET /v1/me`, bounded and narrowed. Returns null on ANY failure — transport rejection, our own
 * deadline, a non-2xx status, a non-JSON body or a shape we do not recognise.
 *
 * The narrowing is not defensive tidiness: a vendor that changes the shape of `usedCredits`/`maxCredits`
 * must produce a REPORTED failure, not `NaN` arithmetic that silently computes a remaining balance
 * nobody can trust and a breaker that never trips.
 */
async function readVendorBudget(apiKey: string): Promise<{ maxCredits: number; usedCredits: number } | null> {
  try {
    const response = await fetch(`${SUPADATA_BASE_URL}/me`, {
      headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(BUDGET_READ_TIMEOUT_MS),
    });

    if (!response.ok) return null;

    const body = (await response.json()) as unknown;
    if (typeof body !== "object" || body === null) return null;
    const { maxCredits, usedCredits } = body as { maxCredits?: unknown; usedCredits?: unknown };
    if (typeof maxCredits !== "number" || !Number.isFinite(maxCredits)) return null;
    if (typeof usedCredits !== "number" || !Number.isFinite(usedCredits)) return null;

    return { maxCredits, usedCredits };
  } catch {
    return null;
  }
}

/** Stores a fresh reading and prunes what it supersedes. Returns false on any failure. */
async function saveVendorBudget(
  admin: SupabaseClient,
  maxCredits: number,
  usedCredits: number,
  readTakenAt: string,
): Promise<boolean> {
  try {
    const { error } = (await admin.rpc("save_supadata_budget", {
      p_max_credits: maxCredits,
      p_used_credits: usedCredits,
      p_read_taken_at: readTakenAt,
    })) as { error: { message: string } | null };

    return error === null;
  } catch {
    return false;
  }
}

/**
 * The whole breaker in one call, and internally a TWO-PASS one.
 *
 * Pass one asks `reserve_supadata_credits`, which decides atomically under the singleton row lock and
 * hands back one of four outcomes. `reserved`, `refused` and `uninitialized` return immediately. On
 * `refresh_required` — and ONLY this caller, which is what the claim taken under that row lock
 * enforces — it fetches `/v1/me`, saves it with the timestamp taken BEFORE the request, evaluates the
 * warn threshold, waits out the rate-limit spacing, and reserves AGAIN.
 *
 * **The second pass is not an optimization; it is the only place the refreshed reading is used.** A
 * refresh that does not re-decide has spent an HTTP call to learn a number it then ignores — and the
 * first pass deliberately returned no reservation, so there is nothing to spend against yet. It is
 * also what keeps the reservation strictly NEWER than the reading that authorized it, which is the
 * property `save_supadata_budget`'s retention rule depends on.
 *
 * **The second pass must not loop.** It can only come back `refresh_required` if the claim was cleared
 * and re-taken in between; any non-terminal outcome there is treated as `untracked` and reported,
 * never recursed. One refresh per call, bounded by construction.
 *
 * If the refresh fails at any step, NO save happens, the claim is left to expire, and the call fails
 * open — never retrying and never reserving against a reading it does not have. An uninitialized
 * deployment whose very first `/v1/me` fails proceeds untracked and tries again on the next request.
 */
export async function reserveBudget(
  admin: SupabaseClient,
  apiKey: string,
  credits: number,
): Promise<ReserveBudgetResult> {
  const first = await callReserveRpc(admin, credits);

  switch (first.outcome) {
    case "reserved":
      return first;
    case "refused":
      reportRefusal(first.stats);
      return first;
    case "uninitialized":
      // No reading has ever been taken AND another caller already holds the refresh claim. There is
      // nothing to decide against and nothing for us to do about it — fail open, explicitly.
      return untracked("no stored reading; another caller holds the refresh claim");
    case "error":
      return untracked(`reserve failed: ${first.message}`);
    case "refreshRequired":
      break;
  }

  // Taken BEFORE the request, not after: `save_supadata_budget` prunes reservations settled at or
  // before this instant, and a post-call timestamp would sweep away calls that settled DURING the
  // round trip — calls the vendor's snapshot provably cannot contain.
  const readTakenAt = new Date().toISOString();
  const reading = await readVendorBudget(apiKey);
  if (reading === null) {
    // The claim is deliberately left to EXPIRE rather than cleared: clearing it here would send the
    // next request straight back into a refresh that is currently failing, once per request.
    return untracked("GET /v1/me failed, timed out, or returned an unusable body", first.stats);
  }

  if (!(await saveVendorBudget(admin, reading.maxCredits, reading.usedCredits, readTakenAt))) {
    return untracked("save_supadata_budget failed", first.stats);
  }

  // Warn is evaluated HERE, on the fresh reading, by the one caller that refreshed it. That is why no
  // `warned_at` column or period-reset logic is needed: the refresh claim already limits this to about
  // once per reading TTL, where a naive "fire whenever above threshold" would make one incident emit
  // thousands of events.
  if (reading.maxCredits > 0 && reading.usedCredits >= reading.maxCredits * BUDGET_WARN_FRACTION) {
    reportBudgetThreshold({
      threshold: "warn",
      maxCredits: reading.maxCredits,
      usedCredits: reading.usedCredits,
      outstanding: null,
      readingAgeSeconds: 0,
    });
  }

  // The one place this module would otherwise contradict the rest of the pipeline: `generate.ts`
  // keeps its two Supadata requests seconds apart because the Free plan allows 1 req/s, and an
  // in-line `/v1/me` lands directly in front of the transcript fetch. Only the REFRESHING caller
  // waits, which is roughly one request per TTL — every other caller reads the stored row and waits
  // for nothing. `RETRY_DELAY_MS` is imported rather than restated: two 1200s in two files linked
  // only by a comment is the drift this phase can least afford.
  await sleep(RETRY_DELAY_MS);

  const second = await callReserveRpc(admin, credits);
  switch (second.outcome) {
    case "reserved":
      return second;
    case "refused":
      reportRefusal(second.stats);
      return second;
    default:
      return untracked(`second pass did not terminate: '${second.outcome}'`, first.stats);
  }
}

/** A refusal is an incident, not a near-miss — see `reportBudgetThreshold`. */
function reportRefusal(stats: BudgetStatistics): void {
  reportBudgetThreshold({
    threshold: "stop",
    maxCredits: stats.maxCredits,
    usedCredits: stats.usedCredits,
    outstanding: stats.outstanding,
    readingAgeSeconds: readingAgeSeconds(stats.readAt),
  });
}

/**
 * Records what a reserved call actually billed. **Must be invoked on EVERY exit from the paid call,
 * including the throwing ones** — for the same reason the meter flush lives in `POST.finally`: a
 * reservation that is never settled is a credit the whole fleet keeps believing is spent until the
 * sweep window elapses.
 *
 * Pass `null` when the vendor reported no `x-billable-requests` header. That is "unknown", and the RPC
 * deliberately keeps counting it at the reserved MAXIMUM rather than treating it as free — a `206
 * transcript-unavailable` is billed 1 credit and reports no header.
 *
 * Never throws. A failure is reported and dropped: the sweep is the backstop that makes an unsettled
 * row self-correcting rather than permanent, and this runs on paths where a rejection would replace an
 * already-decided response.
 */
export async function settleBudget(
  admin: SupabaseClient,
  reservationId: string,
  actualCredits: number | null,
): Promise<void> {
  try {
    const { data, error } = (await admin.rpc("settle_supadata_reservation", {
      p_reservation_id: reservationId,
      p_actual_credits: actualCredits,
    })) as { data: boolean | null; error: { message: string } | null };

    if (error) {
      // eslint-disable-next-line no-console
      console.error(`${BUDGET_EVENT} settle failed for ${reservationId}: ${error.message}`);
      return;
    }

    // `false` means the row was already gone — swept because the call outlived
    // RESERVATION_STALE_SECONDS, which is worth seeing rather than swallowing: it means a paid call
    // ran unreserved for part of its life and the sweep, not this settle, decided the accounting.
    if (data !== true) {
      // eslint-disable-next-line no-console
      console.error(`${BUDGET_EVENT} settle found no open reservation ${reservationId} (swept?)`);
    }
  } catch (cause) {
    // eslint-disable-next-line no-console
    console.error(`${BUDGET_EVENT} settle threw for ${reservationId}:`, cause);
  }
}
