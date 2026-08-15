import type { AppSupabaseClient } from "@/lib/services/summaries";
import type { ChannelCharacter, SummaryListItem } from "@/types";

/**
 * The read side of `summaries` (S-02). Kept out of `services/summaries.ts`, which is the write/persist
 * path: that module owns the RPC that charges a reservation and must stay service-role-only, while
 * this one is a plain RLS-scoped select any signed-in session may run.
 */

/**
 * The PostgREST row this select returns. Declared by hand because `AppDatabase` sets
 * `Relationships: []` (`services/summaries.ts:74-75`), so supabase-js cannot infer the embed's type —
 * the result is narrowed at the boundary instead, exactly as `persistSummaryAndSettle` narrows its
 * RPC result.
 *
 * `videos` is typed nullable only because the untyped embed gives us no guarantee at compile time.
 * At runtime it is always present: `summaries.video_id` / `user_id` are `NOT NULL` behind the
 * composite FK to `videos(id, user_id)` (`20260613145120_videos_and_summaries.sql:34-42`), so a
 * missing embed is a data-integrity fault, not a renderable state — the mapper throws on it.
 */
interface SummaryListRow {
  id: string;
  character: ChannelCharacter;
  content: string;
  created_at: string;
  videos: {
    youtube_id: string;
    url: string;
    title: string | null;
    thumbnail_url_reported: string | null;
    channel_name: string | null;
    channel_id: string | null;
    duration_seconds: number | null;
    published_at: string | null;
  } | null;
}

/**
 * A to-one embed across the composite FK — PostgREST detects it without a disambiguating hint.
 *
 * Note that a filter on an embedded column would NOT filter parents (it nulls the embed instead), so
 * any future filter on a `videos` field needs `!inner`. The character filter is on `summaries` itself
 * and is applied client-side anyway, so that does not bite here.
 */
const LIST_SELECT =
  "id, character, content, created_at, " +
  "videos ( youtube_id, url, title, thumbnail_url_reported, channel_name, channel_id, duration_seconds, published_at )";

/**
 * Reads the caller's own summaries with their video joined, newest first.
 *
 * When `userId` is omitted the read is scoped by RLS (`auth.uid() = user_id`) to the caller's own
 * rows, mirroring `getBalance`. Throws on a genuine DB error — the callers decide whether that is
 * fatal (the endpoint answers 500) or cosmetic (the dashboard renders an "unavailable" list) —
 * and returns `[]` when the user genuinely has none.
 */
export async function listSummaries(supabase: AppSupabaseClient, userId?: string): Promise<SummaryListItem[]> {
  const query = supabase.from("summaries").select(LIST_SELECT).order("created_at", { ascending: false });

  const { data, error } = (await (userId ? query.eq("user_id", userId) : query)) as unknown as {
    data: SummaryListRow[] | null;
    error: { message: string } | null;
  };

  if (error) {
    throw new Error(`Failed to list summaries: ${error.message}`);
  }

  return (data ?? []).map(toListItem);
}

function toListItem(row: SummaryListRow): SummaryListItem {
  // An absent embed cannot be rendered as "a summary with no video" — the FK makes it impossible, so
  // reaching here means the query or the schema changed under us. Fail loudly rather than invent a
  // placeholder video that would look like ordinary null metadata.
  if (!row.videos) {
    throw new Error(`Failed to list summaries: summary ${row.id} returned without its video`);
  }
  const video = row.videos;

  return {
    id: row.id,
    character: row.character,
    content: row.content,
    createdAt: row.created_at,
    youtubeId: video.youtube_id,
    url: video.url,
    title: video.title,
    thumbnailUrlReported: video.thumbnail_url_reported,
    channelName: video.channel_name,
    channelId: video.channel_id,
    durationSeconds: video.duration_seconds,
    publishedAt: video.published_at,
  };
}
