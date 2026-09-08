import { getDbOwnerConnection } from "@/test/db-owner";
import type { AdminClient } from "./admin";

/**
 * The answer to the Supadata half of the vendor problem: DATA, not code.
 *
 * `generate.ts` reaches Supadata twice — once for the transcript, once for the video metadata — and
 * both lookups sit behind a cache. Seeding those caches turns both into hits, so no fetch is ever
 * attempted and the budget breaker (which a cache hit bypasses by construction, D5) is never reached.
 * That is why the e2e layer needs an in-app seam for OpenRouter (`src/test/e2e/fake-llm.ts`) and none
 * for Supadata.
 *
 * Seeding goes through `save_transcript_cache` / `save_metadata_cache` — **the same RPCs `generate.ts`
 * itself calls** (`generate.ts:379-404,903`) — so the endpoint exercises its real cache-hit branch
 * against rows written the real way, not a stand-in shaped like one. Cleanup, by contrast, goes
 * through the table-owner connection: both tables deliberately grant `service_role` no direct
 * privileges (impl-review.md F2), so `admin` can write them through their definer RPCs and cannot
 * delete them at all.
 *
 * **Both must be seeded.** Either miss reaches a vendor — a transcript hit with a metadata miss still
 * spends real Supadata credit.
 */

/** A watch URL `extractYoutubeId` accepts, for a registry id. Specs never hand-build one. */
export function youtubeWatchUrl(youtubeId: string): string {
  return `https://www.youtube.com/watch?v=${youtubeId}`;
}

export interface SeedTranscriptOptions {
  /**
   * The transcript body. Its LENGTH is the knob the long-video case turns: over
   * `LONG_TRANSCRIPT_CHARS` the endpoint prices the summary at 2 credits and holds it for confirmation
   * (README §Summary credits).
   */
  content: string;
  /**
   * The cached vendor outcome. `"ok"` is a usable transcript; `"unavailable"` (no caption track) and
   * `"empty"` (captions containing no words) are the two negative hits that answer 422 AND charge a
   * credit — the exits Phase 3's spec exists to cover. They are distinct causes with distinct copy
   * (D3), never interchangeable.
   */
  outcome?: "ok" | "unavailable" | "empty";
}

/** Seeds `transcript_cache` so the transcript lookup is a hit. */
export async function seedTranscriptCache(
  admin: AdminClient,
  youtubeId: string,
  { content, outcome = "ok" }: SeedTranscriptOptions,
): Promise<void> {
  const { error } = await admin.rpc("save_transcript_cache", {
    p_youtube_id: youtubeId,
    p_content: content,
    p_outcome: outcome,
    p_lang: outcome === "ok" ? "pl" : null,
    p_available_langs: outcome === "ok" ? ["pl"] : null,
    p_requested_lang: "pl",
    p_resolved_via: outcome === "ok" ? "inline" : null,
    p_fetch_duration_ms: 0,
    p_content_chars: null,
  });
  if (error) throw new Error(`seedTranscriptCache(${youtubeId}): ${error.message}`);
}

/** Seeds `metadata_cache` so the metadata lookup is a hit. Title and channel are what the saved card renders. */
export async function seedMetadataCache(admin: AdminClient, youtubeId: string, title: string): Promise<void> {
  const { error } = await admin.rpc("save_metadata_cache", {
    p_youtube_id: youtubeId,
    p_title: title,
    p_thumbnail_url_reported: null,
    p_channel_name: "Kanał testowy e2e",
    p_channel_id: null,
    p_duration_seconds: 120,
    p_published_at: null,
  });
  if (error) throw new Error(`seedMetadataCache(${youtubeId}): ${error.message}`);
}

/**
 * Deletes both cache rows for a video. Called in a test's teardown BEFORE the account is disposed —
 * see the ordering note in `account.ts`'s `trackYoutubeId`.
 */
export async function deleteCacheRows(youtubeId: string): Promise<void> {
  const sql = getDbOwnerConnection();
  await sql`delete from transcript_cache where youtube_id = ${youtubeId}`;
  await sql`delete from metadata_cache where youtube_id = ${youtubeId}`;
}
