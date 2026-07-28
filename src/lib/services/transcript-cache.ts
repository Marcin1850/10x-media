import type { SupabaseClient } from "@supabase/supabase-js";
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
 * Reuse window for `'unavailable'` ALONE — 24 hours.
 *
 * This is a RISK BOUND, not a performance tuning knob: it caps how long a wrong claim can be served.
 * `transcript-unavailable` is the only outcome that can stop being true — YouTube publishes
 * auto-captions with a lag after upload, so a fresh video can legitimately answer "no transcript" now
 * and succeed hours later, and recent videos are a core use case for this app. Widening this trades
 * user-visible correctness for credits. The two constants are separate so that trade can never be
 * made by accident.
 */
export const TRANSCRIPT_CACHE_UNAVAILABLE_MAX_AGE_SECONDS = 86_400;

/** What the vendor did. Code branches on this, never on whether `content` is empty. */
export type TranscriptCacheOutcome = "ok" | "empty" | "unavailable";

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
  return value === "ok" || value === "empty" || value === "unavailable";
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
    return null;
  }
}

export interface SaveCachedTranscriptParams {
  youtubeId: string;
  /** `''` for both negative outcomes — the column is `not null` and `outcome` is what code reads. */
  content: string;
  outcome: TranscriptCacheOutcome;
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
    })) as { data: boolean | null; error: { message: string } | null };

    if (error) {
      // eslint-disable-next-line no-console
      console.error(`saveCachedTranscript: ${error.message}`);
      return { duplicateFetch: false };
    }

    return { duplicateFetch: data === true };
  } catch (cause) {
    // eslint-disable-next-line no-console
    console.error("saveCachedTranscript failed:", cause);
    return { duplicateFetch: false };
  }
}
