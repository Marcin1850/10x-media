import type { SupabaseClient } from "@supabase/supabase-js";
import { RETRY_DELAY_MS } from "./metadata";
import { captureEvent, reportEvent } from "./reporting";

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
 * How long an unsettled reservation is honoured before the sweep closes it. 600 s.
 *
 * A Worker killed mid-call leaves a row nobody will ever settle. The sweep closes it at UNKNOWN rather
 * than deleting it (see the RPC's step 1), so the credits stay held until a fresh reading supersedes
 * them — the window decides when we stop waiting for a settle, not whether the call was free. It is
 * chosen against the CEILING of the operations it guards, not the typical case, because a sweep that
 * fires early closes a call that is still running: its real `x-billable-requests` figure is then lost,
 * the late settle finds no open row, and the reservation is stuck at its pessimistic maximum.
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
 *
 * **Every field is nullable, and the nulls are not uniform — they say WHICH STATE produced them.** A
 * DECISION (`reserved`, `refused`) carries the complete set, because that is precisely what it
 * justifies. A CONTROL STATE carries less because there is less: the RPC's `refresh_required` returns
 * before the outstanding total is computed, so it carries the stale reading it is about to replace
 * with `outstanding` null, and `uninitialized` carries nothing at all, because by definition no
 * reading exists. The invariant that holds across all of them is the one that matters — whatever
 * figures are present were read under the lock that produced them. Do not "fill in" a null here from
 * a later query; that is the unlocked second read this type exists to avoid.
 */
export interface BudgetStatistics {
  maxCredits: number | null;
  usedCredits: number | null;
  /**
   * Credits held by reservations written since the reading — local spend the vendor has not seen.
   * Null when the state returned before the total was computed, NOT when it is zero.
   */
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
  /** `claimId` fences the save that follows — see `saveVendorBudget`. Only this outcome carries one. */
  | { outcome: "refreshRequired"; claimId: string; stats: BudgetStatistics }
  | { outcome: "uninitialized" }
  | { outcome: "error"; message: string };

/**
 * What `save_supadata_budget` did. Three cases, not a boolean, because the middle one is not a
 * failure and must not be logged as one.
 *
 * - `saved`      — the reading is stored and the superseded reservations are pruned.
 * - `claim-lost` — this caller stalled past the refresh claim's TTL, a successor took the claim over,
 *                  and its reading is already stored. NOTHING was written, deliberately: a late save
 *                  would move the anchor BACKWARDS over rows the successor already pruned. Worth
 *                  seeing on its own, because it means a Worker ran ~30 s behind.
 * - `failed`     — transport or RPC error. We know nothing about the stored state.
 */
type SaveBudgetResult = "saved" | "claim-lost" | "failed";

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
 *
 * Delegates to the shared reporting seam (`src/lib/services/reporting.ts`) so this event family and
 * the top-up notice reach the same receiver once one lands. `BUDGET_EVENT` and the severity rule are
 * unchanged — this is a routing change, not a payload or wording change.
 */
export function reportBudgetThreshold(event: BudgetThresholdEvent): void {
  reportEvent(BUDGET_EVENT, event.threshold, event);
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
            refresh_claim_id: string | null;
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
        // A claim without its id cannot be saved back, so the refresh would spend an HTTP call and
        // then be rejected by the fence. Same contract violation as an id-less reservation above.
        if (!row.refresh_claim_id) {
          return { outcome: "error", message: "reserve_supadata_credits granted a refresh without a claim id" };
        }
        return { outcome: "refreshRequired", claimId: row.refresh_claim_id, stats };
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
 * A credit figure we are willing to store: a nonnegative integer. `Number.isInteger` already excludes
 * `NaN` and both infinities, so this is the whole domain check. See `readVendorBudget` for why finite
 * is not sufficient.
 */
function isCreditFigure(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * What `readVendorBudget` resolved to. A failure carries WHICH failure it was, not just that there was
 * one: this string becomes the `untracked` event's `reason`, and an operator looking at that event
 * acts differently on each class — wait out a timeout or a 5xx, rotate the key on a 401, update the
 * narrowing on a changed shape. A single "failed" string made all of them look identical.
 *
 * **Never the response body or a figure's value.** The reason names the status, the error class or the
 * offending field, and stops there — the body is vendor-controlled text of unbounded size.
 */
type VendorBudgetReading = { ok: true; maxCredits: number; usedCredits: number } | { ok: false; failure: string };

/**
 * Describes a rejected `fetch` or body read. `AbortSignal.timeout` rejects with a `TimeoutError`
 * DOMException — on the request AND on a body read it outlives — so that one is named for what it is.
 */
function describeRejection(stage: "request" | "body read", cause: unknown): string {
  if (cause instanceof Error && cause.name === "TimeoutError") {
    return `GET /v1/me timed out after ${BUDGET_READ_TIMEOUT_MS} ms (${stage})`;
  }
  const detail = cause instanceof Error ? `${cause.name}: ${cause.message}` : "non-Error rejection";
  return `GET /v1/me ${stage} failed: ${detail}`;
}

/**
 * `GET /v1/me`, bounded and narrowed. Fails on ANY of: transport rejection, our own deadline, a
 * non-2xx status, a non-JSON body or a shape we do not recognise — and says which (see
 * `VendorBudgetReading`).
 *
 * The narrowing is not defensive tidiness: a vendor that changes the shape of `usedCredits`/`maxCredits`
 * must produce a REPORTED failure, not `NaN` arithmetic that silently computes a remaining balance
 * nobody can trust and a breaker that never trips.
 *
 * **Finite is not enough — the figures must be NONNEGATIVE INTEGERS.** `-1` and `1.5` are both finite,
 * and both are the same class of bug as `NaN` one step later: a negative `usedCredits` INVENTS budget
 * in `max - used - outstanding`, and a fractional one is not representable in the `integer` columns
 * that store it, so it would be silently rounded on the way in — the reading would then differ from
 * what the vendor reported, in a value whose entire purpose is to be authoritative. Rejecting them
 * routes through the same fail-open path as an unreachable `/v1/me`, which is reported, not swallowed.
 */
async function readVendorBudget(apiKey: string): Promise<VendorBudgetReading> {
  let response: Response;
  try {
    response = await fetch(`${SUPADATA_BASE_URL}/me`, {
      headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(BUDGET_READ_TIMEOUT_MS),
    });
  } catch (cause) {
    return { ok: false, failure: describeRejection("request", cause) };
  }

  if (!response.ok) return { ok: false, failure: `GET /v1/me returned HTTP ${response.status}` };

  let body: unknown;
  try {
    body = await response.json();
  } catch (cause) {
    // A body that is not JSON surfaces as a SyntaxError; anything else here is the body read itself.
    if (cause instanceof SyntaxError) {
      return { ok: false, failure: `GET /v1/me returned a non-JSON body (HTTP ${response.status})` };
    }
    return { ok: false, failure: describeRejection("body read", cause) };
  }

  if (typeof body !== "object" || body === null) {
    return { ok: false, failure: "GET /v1/me returned an unrecognised body: not a JSON object" };
  }
  const { maxCredits, usedCredits } = body as { maxCredits?: unknown; usedCredits?: unknown };
  if (!isCreditFigure(maxCredits)) {
    return { ok: false, failure: "GET /v1/me returned an unrecognised body: maxCredits is not a nonnegative integer" };
  }
  if (!isCreditFigure(usedCredits)) {
    return { ok: false, failure: "GET /v1/me returned an unrecognised body: usedCredits is not a nonnegative integer" };
  }

  return { ok: true, maxCredits, usedCredits };
}

/**
 * Stores a fresh reading and prunes what it supersedes, UNDER THE CLAIM THAT AUTHORIZED THE REFRESH.
 *
 * **No timestamp is passed, deliberately.** The snapshot boundary is `refresh_claimed_at`, generated
 * by PostgreSQL when the claim was granted and read back off the locked row inside the RPC. A
 * Worker-supplied boundary is the natural shape and it is wrong: `settled_at` is generated by
 * PostgreSQL, so comparing it against `new Date()` from a Worker compares two clocks, and under
 * positive Worker skew a call that really settled after the read began still prunes as if the vendor
 * snapshot contained it. One clock generates both sides.
 *
 * **The claim is an ownership fence, not a formality.** Its 30 s TTL bounds how long the claim is
 * honoured, not how long this Worker runs. A stalled caller loses the claim to a successor, and its
 * late save would overwrite the successor's newer reading while the rows that successor pruned are
 * already gone — spend that then appears in neither the anchor nor the reservation delta. The RPC
 * answers `false` instead, which is `claim-lost` here.
 */
async function saveVendorBudget(
  admin: SupabaseClient,
  maxCredits: number,
  usedCredits: number,
  claimId: string,
): Promise<SaveBudgetResult> {
  try {
    const { data, error } = (await admin.rpc("save_supadata_budget", {
      p_max_credits: maxCredits,
      p_used_credits: usedCredits,
      p_claim_id: claimId,
    })) as { data: boolean | null; error: { message: string } | null };

    if (error) return "failed";
    return data === true ? "saved" : "claim-lost";
  } catch {
    return "failed";
  }
}

/**
 * The whole breaker in one call, and internally a TWO-PASS one.
 *
 * Pass one asks `reserve_supadata_credits`, which decides atomically under the singleton row lock and
 * hands back one of four outcomes. `reserved`, `refused` and `uninitialized` return immediately. On
 * `refresh_required` — and ONLY this caller, which is what the claim taken under that row lock
 * enforces — it fetches `/v1/me`, saves it UNDER THE CLAIM ID it was handed, waits out the
 * rate-limit spacing, reserves AGAIN, and evaluates the warn threshold on THAT result rather than on
 * the reading, which does not know the local delta (see `reportNearMiss`). The claim makes the save
 * safe against this Worker stalling past the claim's TTL; the boundary the save prunes against comes
 * from the database, not from here (see `saveVendorBudget`).
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
 * open — never retrying and never reserving against a reading it does not have. It still pays the
 * rate-limit spacing on the way out: a `/v1/me` that failed was still a request, and paid work
 * follows a failed refresh exactly as it follows a successful one. An uninitialized deployment whose
 * very first `/v1/me` fails proceeds untracked and tries again on the next request.
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

  const reading = await readVendorBudget(apiKey);

  // Past this line a `/v1/me` request HAS BEEN SENT, so the spacing below is owed on EVERY exit —
  // which is why the failures record a reason instead of returning one. A failed refresh is followed
  // by paid Supadata work at the call site exactly like a successful one, so returning early from
  // here would skip the barrier on precisely the paths where the vendor is already unhappy and turn a
  // breaker degradation into a `limit-exceeded` on the request the user is waiting for.
  let failure: string | null = null;

  if (!reading.ok) {
    // The claim is deliberately left to EXPIRE rather than cleared: clearing it here would send the
    // next request straight back into a refresh that is currently failing, once per request.
    failure = reading.failure;
  } else {
    // No timestamp travels with the reading. The boundary is the claim's own `refresh_claimed_at`,
    // taken from PostgreSQL's clock just before this round trip started — see `saveVendorBudget`.
    const saved = await saveVendorBudget(admin, reading.maxCredits, reading.usedCredits, first.claimId);

    if (saved !== "saved") {
      // `claim-lost` means a successor has already stored a reading at least as fresh as ours, so the
      // stored state is fine — but this request has burned its one refresh and does not re-decide,
      // matching the "one refresh per call, never recursed" bound below. Fail open and say which of
      // the two it was: a lost claim means a Worker ran ~30 s behind, which is worth seeing.
      failure =
        saved === "claim-lost"
          ? "refresh claim expired and was taken over before the reading could be saved"
          : "save_supadata_budget failed";
    }
  }

  // THE BARRIER. The one place this module would otherwise contradict the rest of the pipeline:
  // `generate.ts` keeps its two Supadata requests seconds apart because the Free plan allows 1 req/s,
  // and an in-line `/v1/me` lands directly in front of the transcript fetch. Only the REFRESHING
  // caller waits, which is roughly one request per TTL — every other caller reads the stored row and
  // waits for nothing. `RETRY_DELAY_MS` is imported rather than restated: two 1200s in two files
  // linked only by a comment is the drift this phase can least afford.
  await sleep(RETRY_DELAY_MS);

  if (failure !== null) return untracked(failure, first.stats);

  const second = await callReserveRpc(admin, credits);
  switch (second.outcome) {
    case "reserved":
      reportNearMiss(second.stats);
      return second;
    case "refused":
      reportRefusal(second.stats);
      return second;
    default:
      return untracked(`second pass did not terminate: '${second.outcome}'`, first.stats);
  }
}

/**
 * The near-miss event, evaluated on the SECOND reserve rather than on the reading that preceded it.
 *
 * The reading alone cannot answer the question the event asks. `usedCredits` is what the vendor had
 * seen when the snapshot was computed; the credits reserved since then are invisible to it, so a plan
 * at 79/100 with two outstanding stays silent at an effective 81. The second reserve returns `used`,
 * `max` AND `outstanding` from one locked read, which is the only place all three coexist — a
 * follow-up query would race every other reserve and report numbers that never held together.
 *
 * **`outstanding` EXCLUDES the reservation just authorized.** The RPC totals it at step 4 and inserts
 * at step 5, so the threshold reads "spend already committed before this call", not "after". That is
 * the conservative direction for a near-miss: the stop reserve, not this event, is what keeps the
 * authorized call from overdrawing.
 *
 * Only the refreshing caller reaches this line, which is what keeps the cadence to roughly once per
 * reading TTL without a `warned_at` column — a naive "fire whenever above threshold" would make one
 * incident emit thousands of events. A refusal skips it: `reportRefusal` has already reported the
 * stronger fact, and a stop event that arrived alongside a warn would read as two separate incidents.
 */
function reportNearMiss(stats: BudgetStatistics): void {
  const { maxCredits, usedCredits, outstanding } = stats;
  // A `reserved` outcome carries the complete set by contract; the guard is what makes that contract
  // checked rather than assumed, and a missing figure means the threshold cannot be evaluated at all.
  if (maxCredits === null || usedCredits === null || outstanding === null) return;
  if (maxCredits <= 0) return;
  if (usedCredits + outstanding < maxCredits * BUDGET_WARN_FRACTION) return;

  reportBudgetThreshold({
    threshold: "warn",
    maxCredits,
    usedCredits,
    outstanding,
    readingAgeSeconds: readingAgeSeconds(stats.readAt),
  });
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
      // Forwarded as well as logged (S-13): an unsettled reservation is counted at its reserved maximum
      // until the sweep, so the breaker reasons from spend that may not exist. Its own keys, never the
      // `[supadata-budget]` threshold family's — a bookkeeping failure is not a budget crossing. The
      // reservation id is operational, not an account identifier, and is what locates the row.
      captureEvent("[supadata-budget:settle-failed]", "error", { reservationId, error: error.message });
      return;
    }

    // `false` means the row was no longer open — the call outlived RESERVATION_STALE_SECONDS and the
    // sweep already closed it at UNKNOWN, which is worth seeing rather than swallowing: the sweep's
    // pessimistic maximum, not this settle's real figure, is what the fleet will be charged until the
    // next reading supersedes the row.
    if (data !== true) {
      // eslint-disable-next-line no-console
      console.error(`${BUDGET_EVENT} settle found no open reservation ${reservationId} (swept?)`);
      captureEvent("[supadata-budget:settle-unmatched]", "error", { reservationId });
    }
  } catch (cause) {
    // eslint-disable-next-line no-console
    console.error(`${BUDGET_EVENT} settle threw for ${reservationId}:`, cause);
    captureEvent("[supadata-budget:settle-threw]", "error", { reservationId, error: String(cause) });
  }
}
