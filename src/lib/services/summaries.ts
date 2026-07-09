import type { SupabaseClient } from "@supabase/supabase-js";
import type { ChannelCharacter, TranscriptResolvedVia } from "@/types";

interface VideoRow {
  id: string;
  user_id: string;
  url: string;
  youtube_id: string;
  title: string | null;
  thumbnail_url: string | null;
  created_at: string;
}

interface VideoInsert {
  user_id: string;
  url: string;
  youtube_id: string;
}

interface SummaryRow {
  id: string;
  user_id: string;
  video_id: string;
  character: ChannelCharacter;
  content: string;
  model: string | null;
  resolved_via: TranscriptResolvedVia | null;
  created_at: string;
}

interface SummaryInsert {
  user_id: string;
  video_id: string;
  character: ChannelCharacter;
  content: string;
  model: string | null;
  resolved_via: TranscriptResolvedVia | null;
}

/** Minimal local schema shape for the two tables this service touches — this codebase has no generated Database types yet. */
export interface AppDatabase {
  public: {
    Tables: {
      videos: { Row: VideoRow; Insert: VideoInsert; Update: Partial<VideoInsert>; Relationships: [] };
      summaries: { Row: SummaryRow; Insert: SummaryInsert; Update: Partial<SummaryInsert>; Relationships: [] };
    };
    Views: Record<never, never>;
    Functions: Record<never, never>;
  };
}

/**
 * All four `SupabaseClient` generics must be spelled out explicitly — supabase-js's multi-hop
 * default type parameters (Database -> SchemaNameOrClientOptions -> SchemaName -> Schema) don't
 * resolve when only `Database` is supplied, silently collapsing table Row/Insert types to `never`.
 */
export type AppSupabaseClient = SupabaseClient<AppDatabase, "public", "public", AppDatabase["public"]>;

const YOUTUBE_ID_PATTERN = /^[a-zA-Z0-9_-]{11}$/;
const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"]);

/** Extracts the 11-char YouTube video ID from watch/shorts/embed/live/youtu.be URLs, or null if not a YouTube video URL. */
export function extractYoutubeId(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  let id: string | null = null;

  if (parsed.hostname === "youtu.be") {
    id = parsed.pathname.split("/").find(Boolean) ?? null;
  } else if (YOUTUBE_HOSTS.has(parsed.hostname)) {
    if (parsed.pathname === "/watch") {
      id = parsed.searchParams.get("v");
    } else {
      const match = /^\/(shorts|embed|live)\/([^/]+)/.exec(parsed.pathname);
      id = match ? match[2] : null;
    }
  } else {
    return null;
  }

  return id && YOUTUBE_ID_PATTERN.test(id) ? id : null;
}

export interface AppendSummaryParams {
  userId: string;
  url: string;
  youtubeId: string;
  character: ChannelCharacter;
  content: string;
  model: string | null;
  resolvedVia: TranscriptResolvedVia | null;
}

export interface AppendSummaryResult {
  videoId: string;
  summaryId: string;
}

/** Gets-or-creates the `videos` row for (user_id, youtube_id), then appends a new `summaries` row. Never replaces an existing summary. */
export async function upsertVideoAndAppendSummary(
  supabase: AppSupabaseClient,
  { userId, url, youtubeId, character, content, model, resolvedVia }: AppendSummaryParams,
): Promise<AppendSummaryResult> {
  const { data: video, error: videoError } = await supabase
    .from("videos")
    .upsert({ user_id: userId, url, youtube_id: youtubeId }, { onConflict: "user_id,youtube_id" })
    .select("id")
    .single();

  // .single() returns a non-null `error` whenever `data` is falsy at runtime, even though its
  // declared type omits that branch (a known postgrest-js typing gap) — this guard is real.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (videoError || !video) {
    throw new Error(`Failed to get-or-create video: ${videoError.message}`);
  }

  const { data: summary, error: summaryError } = await supabase
    .from("summaries")
    .insert({ user_id: userId, video_id: video.id, character, content, model, resolved_via: resolvedVia })
    .select("id")
    .single();

  // Same postgrest-js typing gap as above — real runtime guard, not a redundant check.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (summaryError || !summary) {
    throw new Error(`Failed to insert summary: ${summaryError.message}`);
  }

  return { videoId: video.id, summaryId: summary.id };
}
