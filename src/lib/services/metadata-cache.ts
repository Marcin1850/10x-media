import type { SupabaseClient } from "@supabase/supabase-js";
import type { VideoMetadata } from "@/types";

/**
 * The shared, user-agnostic video metadata cache (S-09 D6).
 *
 * With S-07's `transcript_cache` live, this is where a repeat generation's saving actually comes
 * from. The transcript already costs 0 the second time; the metadata call was the remaining 100% of
 * the spend, because `fetchVideoMetadata` runs unconditionally with no lookup in front of it.
 *
 * Keyed by `youtube_id` and deliberately not stored on `videos`, for exactly the reason S-07 kept
 * transcripts off it: `videos` is per-user with `on delete cascade`, so one account deletion would
 * evict data every other user shares.
 *
 * NO negative caching (D9). A failed metadata call is billed 0, so caching the failure would save
 * nothing while persisting nulls for a video whose next attempt would likely succeed. Only a
 * successful fetch is written.
 */

/**
 * Reuse window — 30 days, for symmetry with `TRANSCRIPT_CACHE_MAX_AGE_SECONDS` (D8).
 *
 * The fields this caches age at two very different rates, and the window is set by the faster pair.
 * `duration_seconds` and `published_at` are effectively immutable once a video is published — they
 * could be cached indefinitely. `title` and `thumbnail_url_reported` genuinely do change: creators
 * re-title and re-thumbnail videos, sometimes repeatedly, and a stale title is user-visible in S-02's
 * list rather than merely internal.
 *
 * 30 days is therefore a deliberate compromise and NOT a ceiling discovered by testing. A longer
 * window would save more credits, and that is exactly why it must be argued on its own merits rather
 * than drifted into because it is cheaper — the thing it trades away is the accuracy of what the user
 * sees. Symmetry with the transcript window is the tie-breaker: two caches over the same videos with
 * two different reuse horizons is a difference a reader would have to justify, and there is no reason
 * to.
 *
 * Unlike `transcript_cache` there is only ONE window here, because there is only one outcome: D9
 * declines to cache failures, so no negative row exists to expire on a shorter clock.
 */
export const METADATA_CACHE_MAX_AGE_SECONDS = 2_592_000;

/**
 * Returns cached metadata still inside the window, or `null`.
 *
 * Best-effort and never throws, mirroring `getCachedTranscript`: a miss on error simply means a paid
 * fetch — one wasted credit at worst, never a correctness problem. The RPC result is narrowed at the
 * boundary rather than destructured as `any`, since the admin client is supabase-js's untyped default.
 *
 * Returns the vendor-shaped `VideoMetadata` DTO rather than the row, so a hit is substitutable for a
 * fetch at the call site with no mapping layer between them. That substitutability is what D12 rests
 * on: the cached values feed `persist_summary`'s `metadata` argument exactly as a fetch's would, so
 * the per-user `videos` row is populated on a hit too.
 */
export async function getCachedMetadata(admin: SupabaseClient, youtubeId: string): Promise<VideoMetadata | null> {
  try {
    const { data, error } = (await admin.rpc("get_metadata_cache", {
      p_youtube_id: youtubeId,
      p_max_age_seconds: METADATA_CACHE_MAX_AGE_SECONDS,
    })) as {
      data:
        | {
            title: string | null;
            thumbnail_url_reported: string | null;
            channel_name: string | null;
            channel_id: string | null;
            duration_seconds: number | null;
            published_at: string | null;
            fetched_at: string;
          }[]
        | null;
      error: { message: string } | null;
    };

    if (error) {
      // eslint-disable-next-line no-console
      console.error(`getCachedMetadata: ${error.message}`);
      return null;
    }
    if (!data || data.length === 0) return null;

    const row = data[0];
    // The column names are the `videos` spelling; the DTO is the vendor spelling. This is the one
    // place the two meet, which is why the cache table mirrors `videos` rather than the DTO — the
    // mapping already existed in `persistSummaryAndSettle` and is not duplicated by a second shape.
    return {
      title: row.title,
      thumbnailUrl: row.thumbnail_url_reported,
      channelName: row.channel_name,
      channelId: row.channel_id,
      durationSeconds: row.duration_seconds,
      publishedAt: row.published_at,
    };
  } catch (cause) {
    // eslint-disable-next-line no-console
    console.error("getCachedMetadata failed:", cause);
    return null;
  }
}

/**
 * Upserts the cache row, overwriting every field including `fetched_at`.
 *
 * Deliberately does NOT coalesce, unlike `persist_summary`'s `videos` upsert and for the same reason
 * `saveCachedTranscript` does not: this is only ever called after a SUCCESSFUL fetch past the window,
 * which is exactly the case where the new value must win. A re-titled video heals here.
 *
 * Call this ONLY with a non-null fetch result. D9 declines to cache failures, and a coalescing-free
 * upsert of nulls would actively poison the row for every other user.
 *
 * Best-effort and never throws: a failed cache write must not fail a generation that has already been
 * paid for twice over — the user's credit and the LLM call. The cost of losing this write is one
 * Supadata credit on the next generation of the same video.
 */
export async function saveCachedMetadata(
  admin: SupabaseClient,
  youtubeId: string,
  metadata: VideoMetadata,
): Promise<void> {
  try {
    const { error } = (await admin.rpc("save_metadata_cache", {
      p_youtube_id: youtubeId,
      p_title: metadata.title,
      p_thumbnail_url_reported: metadata.thumbnailUrl,
      p_channel_name: metadata.channelName,
      p_channel_id: metadata.channelId,
      p_duration_seconds: metadata.durationSeconds,
      p_published_at: metadata.publishedAt,
    })) as { error: { message: string } | null };

    if (error) {
      // eslint-disable-next-line no-console
      console.error(`saveCachedMetadata: ${error.message}`);
    }
  } catch (cause) {
    // eslint-disable-next-line no-console
    console.error("saveCachedMetadata failed:", cause);
  }
}
