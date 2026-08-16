import type { SupabaseClient } from "@supabase/supabase-js";
import type { ChannelCharacter, MetadataVia, TranscriptResolvedVia, VideoMetadata } from "@/types";

interface VideoRow {
  id: string;
  user_id: string;
  url: string;
  youtube_id: string;
  title: string | null;
  /** What Supadata last reported, never repaired — may 404. Consumers fall back to the derived `hqdefault.jpg`. */
  thumbnail_url_reported: string | null;
  channel_name: string | null;
  channel_id: string | null;
  duration_seconds: number | null;
  published_at: string | null;
  transcript_lang: string | null;
  transcript_available_langs: string[] | null;
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
  /** Generation telemetry (S-07). Nullable throughout — rows predating the columns keep nulls. */
  transcript_chars: number | null;
  generation_ms: number | null;
  transcript_ms: number | null;
  llm_ms: number | null;
  metadata_ms: number | null;
  cost_usd: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  /** How the metadata was obtained (S-09). Null on rows predating the column. */
  metadata_via: MetadataVia | null;
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
      /** Table-returning, so PostgREST sends a one-element array. Which columns are non-null depends on `outcome`. */
      begin_generation: {
        Args: { target_user: string; request: string | null; amount: number | null };
        Returns: {
          outcome: string;
          reservation_id: string | null;
          new_balance: number | null;
          summary_id: string | null;
          video_id: string | null;
          content: string | null;
          model: string | null;
          cost: number | null;
        }[];
      };
      settle_reservation: { Args: { target_user: string; reservation: string }; Returns: boolean };
      refund_reservation: { Args: { target_user: string; reservation: string }; Returns: boolean };
      /** Table-returning, so PostgREST sends a one-element array. Ids are null on the `not_reserved` outcome. */
      persist_summary: {
        Args: {
          target_user: string;
          reservation: string;
          p_url: string;
          p_youtube_id: string;
          p_character: string;
          p_content: string;
          p_model: string | null;
          p_resolved_via: string | null;
          p_title: string | null;
          p_thumbnail_url_reported: string | null;
          p_channel_name: string | null;
          p_channel_id: string | null;
          p_duration_seconds: number | null;
          p_published_at: string | null;
          p_transcript_lang: string | null;
          p_transcript_available_langs: string[] | null;
          p_transcript_chars: number | null;
          p_generation_ms: number | null;
          p_transcript_ms: number | null;
          p_llm_ms: number | null;
          p_metadata_ms: number | null;
          p_cost_usd: number | null;
          p_prompt_tokens: number | null;
          p_completion_tokens: number | null;
          p_metadata_via: string | null;
        };
        Returns: { outcome: string; video_id: string | null; summary_id: string | null }[];
      };
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

export interface PersistSummaryParams {
  userId: string;
  url: string;
  youtubeId: string;
  character: ChannelCharacter;
  content: string;
  model: string | null;
  resolvedVia: TranscriptResolvedVia | null;
  /** The reservation that paid for this summary. Persisted on the row AND closed in the same transaction (F23). */
  reservationId: string;
  /**
   * Descriptive video metadata, best-effort — omitted or null when the Supadata metadata call
   * failed. The RPC coalesces every field on conflict, so a failed fetch here can never erase
   * metadata an earlier generation of the same video captured.
   */
  metadata?: VideoMetadata | null;
  /** Which caption track Supadata actually returned. Diagnostic only — null on the cached-quote path. */
  transcriptLang?: string | null;
  /** The whole caption-track pool the transcript came from. Diagnostic only — null on the cached-quote path. */
  transcriptAvailableLangs?: string[] | null;
  /**
   * Generation telemetry (S-07). All optional and defaulting to null, matching how `metadata` /
   * `transcriptLang` were added in S-08 — a caller that has not measured something persists null
   * rather than a fabricated zero.
   */
  /** `content.length` — the size of the text this summary was actually built from. */
  transcriptChars?: number | null;
  /**
   * Wall clock to immediately BEFORE this call, not to the response. `persist_summary` is the only
   * writer of `summaries`, so a value carried through it must be frozen before the call is made.
   */
  generationMs?: number | null;
  /** Brackets whatever produced the transcript — the fetch, the quote read, or the cache read. */
  transcriptMs?: number | null;
  llmMs?: number | null;
  metadataMs?: number | null;
  /** OpenRouter's own reported figure. Null when usage accounting reported nothing. */
  costUsd?: number | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  /**
   * How the metadata was obtained (S-09 D10). Optional and defaulting to null like the telemetry
   * above, so a caller that has not made the distinction persists null rather than a guess — but the
   * generate endpoint always sets it, because a null here is indistinguishable from a pre-migration
   * row and would silently re-break the cost-per-generation queries the column exists to keep honest.
   */
  metadataVia?: MetadataVia | null;
}

/**
 * Discriminated on `ok` so a successful persist always carries both ids. `ok: false` is not an error:
 * it means the reservation was no longer open (a reconciliation sweep resolved it while the LLM call
 * ran), so nothing was written and the caller must fail closed rather than return an unsaved summary.
 */
export type PersistSummaryResult = { ok: true; videoId: string; summaryId: string } | { ok: false; reason: string };

/**
 * Writes the video + summary and settles the paying reservation in ONE transaction, via the
 * `persist_summary()` RPC.
 *
 * This replaces the previous "insert with the RLS client, then settle best-effort" pair (F23). Those
 * were separate transactions, so between the reserve and the insert the ledger was indistinguishable
 * from failed work — the one-hour reconciliation sweep could refund a request that was still running,
 * and the later insert would still succeed because the FK validates ownership, not status. The linked
 * summary was mutable evidence besides: owners may delete their own summaries under existing RLS.
 * Deciding the charge inside the writing transaction removes both failure modes.
 *
 * Takes the ADMIN client: the RPC closes a ledger row and writes on an explicit user's behalf, so it
 * is service_role only, like settle/refund. Throws on a genuine DB error — the caller refunds, which
 * is correct because a rollback leaves nothing persisted.
 */
export async function persistSummaryAndSettle(
  admin: SupabaseClient,
  {
    userId,
    url,
    youtubeId,
    character,
    content,
    model,
    resolvedVia,
    reservationId,
    metadata = null,
    transcriptLang = null,
    transcriptAvailableLangs = null,
    transcriptChars = null,
    generationMs = null,
    transcriptMs = null,
    llmMs = null,
    metadataMs = null,
    costUsd = null,
    promptTokens = null,
    completionTokens = null,
    metadataVia = null,
  }: PersistSummaryParams,
): Promise<PersistSummaryResult> {
  // The admin client is supabase-js's untyped default (this repo has no generated Database types), so
  // narrow the RPC result at the boundary rather than destructuring `any` — same as transcript-guard.
  const { data, error } = (await admin.rpc("persist_summary", {
    target_user: userId,
    reservation: reservationId,
    p_url: url,
    p_youtube_id: youtubeId,
    p_character: character,
    p_content: content,
    p_model: model,
    p_resolved_via: resolvedVia,
    // The DTO stays vendor-shaped (`thumbnailUrl`); this is the layer that maps it onto the
    // `thumbnail_url_reported` column, whose name records that the value is what Supadata said —
    // never repaired against whether it actually resolves.
    p_title: metadata?.title ?? null,
    p_thumbnail_url_reported: metadata?.thumbnailUrl ?? null,
    p_channel_name: metadata?.channelName ?? null,
    p_channel_id: metadata?.channelId ?? null,
    p_duration_seconds: metadata?.durationSeconds ?? null,
    p_published_at: metadata?.publishedAt ?? null,
    p_transcript_lang: transcriptLang,
    p_transcript_available_langs: transcriptAvailableLangs,
    // Telemetry (S-07). Committed in the SAME transaction as the summary it describes — which is why
    // `generationMs` stops before this call rather than measuring to the response: reaching a
    // response-bound figure would need a second write after persist, with its own failure path,
    // breaking that atomicity for the few milliseconds between the two points.
    p_transcript_chars: transcriptChars,
    p_generation_ms: generationMs,
    p_transcript_ms: transcriptMs,
    p_llm_ms: llmMs,
    p_metadata_ms: metadataMs,
    p_cost_usd: costUsd,
    p_prompt_tokens: promptTokens,
    p_completion_tokens: completionTokens,
    // S-09 D10. Sits with the telemetry because that is what it is — but note it explains one of
    // those columns rather than joining them: `metadata_ms` is only comparable across `'fetched'`
    // rows, since a `'stored'` row brackets a database read instead of an HTTP call.
    p_metadata_via: metadataVia,
  })) as {
    data: { outcome: string; video_id: string | null; summary_id: string | null }[] | null;
    error: { message: string } | null;
  };

  if (error) {
    throw new Error(`Failed to persist summary: ${error.message}`);
  }

  // `returns table(...)` arrives as a one-element array. An empty one would mean the RPC contract
  // changed under us and must not be read as a silent success — same guard as reserveCredits.
  if (!data || data.length === 0) {
    throw new Error("Failed to persist summary: persist_summary returned no row");
  }
  const row = data[0];

  if (row.outcome !== "persisted" && row.outcome !== "already_persisted") {
    return { ok: false, reason: row.outcome };
  }

  if (!row.video_id || !row.summary_id) {
    throw new Error(`Failed to persist summary: outcome '${row.outcome}' returned without ids`);
  }

  return { ok: true, videoId: row.video_id, summaryId: row.summary_id };
}
