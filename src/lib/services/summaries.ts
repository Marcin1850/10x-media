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
  reservation_id: string | null;
  created_at: string;
}

interface SummaryInsert {
  user_id: string;
  video_id: string;
  character: ChannelCharacter;
  content: string;
  model: string | null;
  resolved_via: TranscriptResolvedVia | null;
  reservation_id: string | null;
}

interface UserCreditsRow {
  user_id: string;
  balance: number;
  updated_at: string;
}

interface UserCreditsInsert {
  user_id: string;
  balance?: number;
}

/** Minimal local schema shape for the tables/functions this service touches — this codebase has no generated Database types yet. */
export interface AppDatabase {
  public: {
    Tables: {
      videos: { Row: VideoRow; Insert: VideoInsert; Update: Partial<VideoInsert>; Relationships: [] };
      summaries: { Row: SummaryRow; Insert: SummaryInsert; Update: Partial<SummaryInsert>; Relationships: [] };
      user_credits: {
        Row: UserCreditsRow;
        Insert: UserCreditsInsert;
        Update: Partial<UserCreditsInsert>;
        Relationships: [];
      };
    };
    Views: Record<never, never>;
    Functions: {
      /** Table-returning, so PostgREST sends a one-element array. `reservation_id` is null on the -1 sentinel. */
      reserve_credits: {
        Args: { amount?: number };
        Returns: { reservation_id: string | null; new_balance: number }[];
      };
      settle_reservation: { Args: { target_user: string; reservation: string }; Returns: boolean };
      refund_reservation: { Args: { target_user: string; reservation: string }; Returns: boolean };
      /** Legacy, kept for the expand/contract window only — dropped in the Phase 8 contract migration. */
      spend_credits: { Args: { amount?: number }; Returns: number };
      refund_credits: { Args: { target_user: string; amount: number }; Returns: undefined };
    };
  };
}

/**
 * All four `SupabaseClient` generics must be spelled out explicitly — supabase-js's multi-hop
 * default type parameters (Database -> SchemaNameOrClientOptions -> SchemaName -> Schema) don't
 * resolve when only `Database` is supplied, silently collapsing table Row/Insert types to `never`.
 */
export type AppSupabaseClient = SupabaseClient<AppDatabase, "public", "public", AppDatabase["public"]>;

/**
 * Cost policy (pure). A summary of a long transcript costs 2 credits instead of 1; transcripts
 * above the hard maximum are rejected by the endpoint before the LLM call (Phase 4) to bound
 * worst-case token cost/latency. `summaryCost` only prices — it does not enforce the hard cap.
 */
export const LONG_TRANSCRIPT_CHARS = 40000;
export const HARD_MAX_TRANSCRIPT_CHARS = 200000;

/** Maps transcript length to credit cost: 2 for a long transcript, else 1. */
export function summaryCost(transcriptLength: number): number {
  return transcriptLength > LONG_TRANSCRIPT_CHARS ? 2 : 1;
}

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
  /**
   * The reservation that paid for this summary. Persisted on the row (not a bookkeeping side call) so
   * the ledger has durable proof the work was delivered: reconciliation settles a `reserved` row that
   * produced a linked summary and refunds only the ones with none (F16).
   */
  reservationId: string;
}

export interface AppendSummaryResult {
  videoId: string;
  summaryId: string;
}

/** Gets-or-creates the `videos` row for (user_id, youtube_id), then appends a new `summaries` row. Never replaces an existing summary. */
export async function upsertVideoAndAppendSummary(
  supabase: AppSupabaseClient,
  { userId, url, youtubeId, character, content, model, resolvedVia, reservationId }: AppendSummaryParams,
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
    .insert({
      user_id: userId,
      video_id: video.id,
      character,
      content,
      model,
      resolved_via: resolvedVia,
      reservation_id: reservationId,
    })
    .select("id")
    .single();

  // Same postgrest-js typing gap as above — real runtime guard, not a redundant check.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (summaryError || !summary) {
    throw new Error(`Failed to insert summary: ${summaryError.message}`);
  }

  return { videoId: video.id, summaryId: summary.id };
}
