import type { SupabaseClient } from "@supabase/supabase-js";
import { captureEvent } from "@/lib/services/reporting";
import type { FetchedResolvedVia } from "@/types";

/**
 * The shared, user-agnostic transcript cache (S-07).
 *
 * A transcript fetched once is reused by ANY user for the window below, so the second character —
 * or the second account — never re-pays Supadata for text already bought. The table is keyed by
 * `youtube_id` alone and holds no personal data; it deliberately does not live on `videos`, which is
 * per-user and would cascade a shared transcript away when one account is deleted.
 *
 * The reuse guarantee is EVENTUAL, not absolute: it holds from the first completed cache write
 * onward. Two requests that both miss on a cold video can each pay — the generation lease is keyed
 * per user by construction and cannot coordinate two users on one video. That race is measured rather
 * than assumed rare: `saveCachedTranscript` reports it (see `duplicateFetch`).
 */

/**
 * Reuse window for `'ok'` AND `'empty'` — 30 days.
 *
 * `'empty'` belongs here, not under the short window, because it is a vendor SUCCESS: the video has
 * no words and never will (an instrumental piece stays instrumental). Expiring it daily would re-pay
 * Supadata to re-confirm a permanent fact, which is exactly the spend caching an empty exists to stop.
 */
export const TRANSCRIPT_CACHE_MAX_AGE_SECONDS = 2_592_000;

/**
 * Reuse window for `'unavailable'` ALONE — 2 hours (S-09 D4; was 24 h).
 *
 * This is a RISK BOUND, not a performance tuning knob: it caps how long a wrong claim can be served.
 * `transcript-unavailable` is the only outcome that can stop being true — YouTube publishes
 * auto-captions with a lag after upload, so a fresh video can legitimately answer "no transcript" now
 * and succeed hours later, and recent videos are a core use case for this app. A day is simply too
 * long to lock a user out of a video that gained captions an hour after publication.
 *
 * The 24 h figure also rested on a reading that no longer exists. It was justified partly by
 * `unavailable` possibly meaning "the Whisper job failed" — a transient condition worth re-checking
 * slowly. Under `TRANSCRIPT_MODE = 'native'` (D1) there is no Whisper path, so the outcome can only
 * mean one thing: this video has no caption track. That is a fact about YouTube's captions, and it
 * changes on the timescale caption generation runs on, not on a daily one.
 *
 * WHAT IT COSTS, stated plainly because it runs OPPOSITE to the rest of S-09: shortening this window
 * spends operator credits to buy user-visible correctness. A caption-less video resubmitted five
 * times in one day now costs 5 credits instead of 1. That is the trade, made knowingly.
 *
 * D4 AND THE BUDGET BREAKER (lever C) ARE LOAD-BEARING FOR EACH OTHER. C is what bounds the overrun
 * this window opens. If C is ever removed, revisit this constant in the same breath — do not leave a
 * 2 h negative window standing with nothing capping the fleet's spend.
 *
 * `TRANSCRIPT_CACHE_MAX_AGE_SECONDS` (30 days) is untouched: the two constants are separate so this
 * trade can never be made by accident.
 */
export const TRANSCRIPT_CACHE_UNAVAILABLE_MAX_AGE_SECONDS = 7_200;

/**
 * What the vendor did, and what this app can do with it. Code branches on this, never on whether
 * `content` is empty.
 *
 * `'too_long'` is the odd one: the vendor SUCCEEDED and the text is real, but it exceeds
 * `HARD_MAX_TRANSCRIPT_CHARS` and will never be summarized, so the row records the size and drops the
 * body (F6). Caching the rejection rather than the payload is what keeps the deduplication promise —
 * a second attempt on the same over-long video answers 413 for free instead of re-paying Supadata —
 * while bounding what the table can hold.
 */
export type TranscriptCacheOutcome = "ok" | "empty" | "unavailable" | "too_long";

export interface CachedTranscriptRow {
  content: string;
  outcome: TranscriptCacheOutcome;
  lang: string | null;
  availableLangs: string[] | null;
  /** How the ORIGINAL fetch resolved. A reader of this row records `'stored'` on its own summary. */
  resolvedVia: FetchedResolvedVia | null;
  fetchedAt: string;
}

function isCacheOutcome(value: unknown): value is TranscriptCacheOutcome {
  return value === "ok" || value === "empty" || value === "unavailable" || value === "too_long";
}

function isFetchedResolvedVia(value: unknown): value is FetchedResolvedVia {
  return value === "inline" || value === "job";
}

/**
 * Returns a cached transcript that is still inside the window applying to its OWN outcome, or `null`.
 *
 * Best-effort and never throws, mirroring `transcript-guard.ts`: a miss on error simply means a paid
 * fetch — a wasted credit at worst, never a correctness problem. The RPC result is narrowed at the
 * boundary rather than destructured as `any`, since the admin client is supabase-js's untyped default.
 */
export async function getCachedTranscript(
  admin: SupabaseClient,
  youtubeId: string,
): Promise<CachedTranscriptRow | null> {
  try {
    const { data, error } = (await admin.rpc("get_transcript_cache", {
      p_youtube_id: youtubeId,
      p_max_age_seconds: TRANSCRIPT_CACHE_MAX_AGE_SECONDS,
      p_unavailable_max_age_seconds: TRANSCRIPT_CACHE_UNAVAILABLE_MAX_AGE_SECONDS,
    })) as {
      data:
        | {
            content: string | null;
            outcome: string | null;
            lang: string | null;
            available_langs: string[] | null;
            resolved_via: string | null;
            fetched_at: string;
          }[]
        | null;
      error: { message: string } | null;
    };

    if (error) {
      // eslint-disable-next-line no-console
      console.error(`getCachedTranscript: ${error.message}`);
      // Forwarded as well as logged (S-13). A cache that cannot be read re-pays Supadata on every request
      // while the app keeps working, so nothing user-visible would ever surface it. One key per operation
      // and failure shape — a rolled-back statement and a dead transport are repaired differently — and no
      // user identifiers: the degradation family is outside the seam's exception (`reporting.ts`).
      captureEvent("[transcript-cache:get-failed]", "error", { error: error.message });
      return null;
    }
    if (!data || data.length === 0) return null;

    const row = data[0];
    // An unrecognised `outcome` is treated as a miss rather than guessed at. The column is CHECKed, so
    // this is unreachable short of a schema change — and on a schema change a paid re-fetch is a far
    // better failure than branching the wrong way on a value this code does not understand.
    if (!isCacheOutcome(row.outcome)) return null;

    return {
      content: row.content ?? "",
      outcome: row.outcome,
      lang: row.lang,
      availableLangs: row.available_langs,
      resolvedVia: isFetchedResolvedVia(row.resolved_via) ? row.resolved_via : null,
      fetchedAt: row.fetched_at,
    };
  } catch (cause) {
    // eslint-disable-next-line no-console
    console.error("getCachedTranscript failed:", cause);
    captureEvent("[transcript-cache:get-threw]", "error", { error: String(cause) });
    return null;
  }
}

export interface SaveCachedTranscriptParams {
  youtubeId: string;
  /**
   * `''` for both negative outcomes AND for `'too_long'` — the column is `not null` and `outcome` is
   * what code reads. A `'too_long'` body is deliberately discarded rather than stored: the app can
   * never summarize it, so keeping it would cost storage and read bandwidth to deliver a 413.
   */
  content: string;
  outcome: TranscriptCacheOutcome;
  /**
   * Observed transcript length. Only meaningful for `'too_long'`, where the body is gone and this is
   * the sole surviving record of how far over the cap it was; `null` elsewhere, where `content`
   * answers it directly. Diagnostic — gates nothing.
   */
  contentChars?: number | null;
  lang: string | null;
  availableLangs: string[] | null;
  /** Which `lang` the app asked for. Diagnostic only — gates nothing. */
  requestedLang: string | null;
  resolvedVia: FetchedResolvedVia | null;
  /**
   * How long OUR fetch took, in milliseconds — an elapsed duration, never a timestamp. The RPC
   * compares it against the overwritten row's age using Postgres's own clock, so the duplicate-fetch
   * signal is immune to skew between the Worker and the database.
   */
  fetchDurationMs: number;
}

/**
 * Upserts the cache row, overwriting every field including `fetched_at`.
 *
 * Deliberately does NOT coalesce, unlike `persist_summary`'s video upsert: a refresh past the window
 * is exactly the case where the new value must win, and a later successful fetch replacing a negative
 * row outright is how a video that gains captions heals.
 *
 * `duplicateFetch` is true when the row this call overwrote was written AFTER our fetch started —
 * only possible if another request paid for the same video while ours was in flight. It is the sole
 * instrumentation for the concurrency race the plan accepts rather than prevents.
 *
 * Best-effort and never throws: a failed write must not fail a generation. A failed write reports
 * `duplicateFetch: false` — the signal is an OBSERVATION, and absence of evidence must not be
 * reported as evidence.
 */
export async function saveCachedTranscript(
  admin: SupabaseClient,
  {
    youtubeId,
    content,
    outcome,
    contentChars = null,
    lang,
    availableLangs,
    requestedLang,
    resolvedVia,
    fetchDurationMs,
  }: SaveCachedTranscriptParams,
): Promise<{ duplicateFetch: boolean }> {
  try {
    const { data, error } = (await admin.rpc("save_transcript_cache", {
      p_youtube_id: youtubeId,
      p_content: content,
      p_outcome: outcome,
      p_lang: lang,
      p_available_langs: availableLangs,
      p_requested_lang: requestedLang,
      p_resolved_via: resolvedVia,
      p_fetch_duration_ms: Math.round(fetchDurationMs),
      p_content_chars: contentChars,
    })) as { data: boolean | null; error: { message: string } | null };

    if (error) {
      // eslint-disable-next-line no-console
      console.error(`saveCachedTranscript: ${error.message}`);
      captureEvent("[transcript-cache:save-failed]", "error", { error: error.message });
      return { duplicateFetch: false };
    }

    return { duplicateFetch: data === true };
  } catch (cause) {
    // eslint-disable-next-line no-console
    console.error("saveCachedTranscript failed:", cause);
    captureEvent("[transcript-cache:save-threw]", "error", { error: String(cause) });
    return { duplicateFetch: false };
  }
}
