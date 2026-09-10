import type { SupabaseClient } from "@supabase/supabase-js";
import { captureEvent } from "@/lib/services/reporting";
import type { TranscriptResolvedVia } from "@/types";

/**
 * Provider-spend guards for the generate endpoint's paid Supadata transcript fetch (F17).
 *
 * The endpoint's pre-transcript gate is a minimum-1 balance read, and a long video returns its 409
 * confirmation BEFORE any debit — so a one-credit user could otherwise fetch transcript after
 * transcript (each a paid Supadata call) sequentially without ever reaching a charge. Two guards bound
 * that:
 *
 *   - a per-user rate limit on paid fetches (`recordTranscriptAttempt`), and
 *   - a short-lived quote cache (`getTranscriptQuote` / `saveTranscriptQuote`) so the long-video
 *     confirmation round-trip reuses the transcript it already paid for instead of re-fetching.
 *
 * The cache carries the transcript's language fields alongside the body (F10). It did not originally,
 * which meant a confirmation resubmit persisted null to `videos.transcript_lang` /
 * `transcript_available_langs` — and since this path is reachable only above 40,000 characters, those
 * nulls landed exclusively on long videos, biasing the diagnostics against the longest content.
 *
 * All three back onto service-role-only RPCs (the tables are definer-only, like generation_locks), so
 * they run via the admin client the generate endpoint already requires in preflight. Postgres holds
 * the state because concurrent Worker requests can land in different isolates.
 */

// Conservative defaults: Supadata's exact billing/caching and the right window are unmeasured, so these
// are deliberately generous for legitimate use (a fetch happens only on a video's first attempt) while
// still bounding worst-case paid fetches to `MAX_ATTEMPTS` per `WINDOW` per user. Tune once measured.
export const TRANSCRIPT_RATE_WINDOW_SECONDS = 600; // 10 minutes
export const TRANSCRIPT_RATE_MAX_ATTEMPTS = 10;
// The confirmation retry must reuse the quote within this window, else it re-fetches (pre-F17 behavior).
export const TRANSCRIPT_QUOTE_TTL_SECONDS = 600; // 10 minutes

/**
 * Records one paid-fetch attempt and reports whether the caller is under the per-user rate cap. Returns
 * `false` when the cap is reached (the endpoint should 429 before fetching). Throws only on a genuine
 * DB error — the caller fails the request CLOSED rather than proceed to an unbounded fetch.
 */
export async function recordTranscriptAttempt(admin: SupabaseClient, userId: string): Promise<boolean> {
  // The admin client is supabase-js's untyped default (this repo has no generated Database types), so
  // narrow the RPC result at the boundary rather than destructuring `any`.
  const { data, error } = (await admin.rpc("record_transcript_attempt", {
    target_user: userId,
    window_seconds: TRANSCRIPT_RATE_WINDOW_SECONDS,
    max_attempts: TRANSCRIPT_RATE_MAX_ATTEMPTS,
  })) as { data: boolean | null; error: { message: string } | null };

  if (error) {
    throw new Error(`Failed to record transcript attempt: ${error.message}`);
  }

  return data === true;
}

export interface CachedTranscript {
  content: string;
  resolvedVia: TranscriptResolvedVia | null;
  lang: string | null;
  availableLangs: string[] | null;
}

/**
 * Returns a fresh (unexpired) cached transcript for (user, video, character), or `null`. Best-effort:
 * on any failure it resolves `null`, so the caller simply re-fetches — a wasted paid call at worst,
 * never a correctness problem. Never throws.
 */
export async function getTranscriptQuote(
  admin: SupabaseClient,
  userId: string,
  youtubeId: string,
  character: string,
): Promise<CachedTranscript | null> {
  try {
    const { data, error } = (await admin.rpc("get_transcript_quote", {
      target_user: userId,
      p_youtube_id: youtubeId,
      p_character: character,
    })) as {
      data:
        | {
            transcript_content: string;
            resolved_via: TranscriptResolvedVia | null;
            lang: string | null;
            available_langs: string[] | null;
          }[]
        | null;
      error: { message: string } | null;
    };

    if (error) {
      // eslint-disable-next-line no-console
      console.error(`getTranscriptQuote: ${error.message}`);
      // Forwarded as well as logged (S-13): a quote cache that cannot be read makes every long-video
      // confirmation pay for its transcript twice, and nothing user-visible says so. One key per operation
      // and failure shape. NO user identifiers — every function here takes a `userId`, and none of them
      // may pass it on: the degradation family is outside the seam's exception (`reporting.ts`).
      captureEvent("[transcript-guard:quote-get-failed]", "error", { error: error.message });
      return null;
    }
    if (!data || data.length === 0) {
      return null;
    }

    return {
      content: data[0].transcript_content,
      resolvedVia: data[0].resolved_via,
      // Null-coalesced rather than asserted: rows written by the pre-F10 Worker predate these columns
      // and legitimately carry null. Indistinguishable from a genuine null, which is fine — both mean
      // "no language data for this cached transcript".
      lang: data[0].lang ?? null,
      availableLangs: data[0].available_langs ?? null,
    };
  } catch (cause) {
    // eslint-disable-next-line no-console
    console.error("getTranscriptQuote failed:", cause);
    captureEvent("[transcript-guard:quote-get-threw]", "error", { error: String(cause) });
    return null;
  }
}

/**
 * Caches a freshly fetched transcript so the long-video confirmation retry reuses it. Best-effort and
 * never throws: on failure the confirmation simply re-fetches (the pre-F17 behavior), which must not
 * fail the 409 the endpoint is already returning.
 */
export async function saveTranscriptQuote(
  admin: SupabaseClient,
  {
    userId,
    youtubeId,
    character,
    content,
    resolvedVia,
    lang,
    availableLangs,
  }: {
    userId: string;
    youtubeId: string;
    character: string;
    content: string;
    resolvedVia: TranscriptResolvedVia | null;
    lang: string | null;
    availableLangs: string[] | null;
  },
): Promise<void> {
  try {
    const { error } = (await admin.rpc("save_transcript_quote", {
      target_user: userId,
      p_youtube_id: youtubeId,
      p_character: character,
      p_content: content,
      p_resolved_via: resolvedVia,
      ttl_seconds: TRANSCRIPT_QUOTE_TTL_SECONDS,
      p_lang: lang,
      p_available_langs: availableLangs,
    })) as { error: { message: string } | null };

    if (error) {
      // eslint-disable-next-line no-console
      console.error(`saveTranscriptQuote: ${error.message}`);
      captureEvent("[transcript-guard:quote-save-failed]", "error", { error: error.message });
    }
  } catch (cause) {
    // eslint-disable-next-line no-console
    console.error("saveTranscriptQuote failed:", cause);
    captureEvent("[transcript-guard:quote-save-threw]", "error", { error: String(cause) });
  }
}

/**
 * Drops the cached quote for (user, video, character) once the summary that used it is durably saved
 * (F24). The confirmation round-trip the cache exists to serve is over at that point, so keeping up to
 * 200k characters of third-party transcript for the rest of the TTL buys nothing.
 *
 * Called only AFTER a successful persist, never on a failure path: a failed attempt still wants the
 * quote so its retry reuses the fetch instead of paying Supadata again. Best-effort and never throws —
 * a leftover row expires on its own and is swept by the bounded prune, which must not turn a delivered,
 * already-charged summary into an error response.
 */
export async function discardTranscriptQuote(
  admin: SupabaseClient,
  userId: string,
  youtubeId: string,
  character: string,
): Promise<void> {
  try {
    const { error } = (await admin.rpc("discard_transcript_quote", {
      target_user: userId,
      p_youtube_id: youtubeId,
      p_character: character,
    })) as { error: { message: string } | null };

    if (error) {
      // eslint-disable-next-line no-console
      console.error(`discardTranscriptQuote: ${error.message}`);
      captureEvent("[transcript-guard:quote-discard-failed]", "error", { error: error.message });
    }
  } catch (cause) {
    // eslint-disable-next-line no-console
    console.error("discardTranscriptQuote failed:", cause);
    captureEvent("[transcript-guard:quote-discard-threw]", "error", { error: String(cause) });
  }
}
