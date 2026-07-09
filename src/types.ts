export type ChannelCharacter = "informational" | "educational";

/** How Supadata resolved the transcript fetch — observed fetch mechanism only, not a claim about native-caption vs Whisper-generated origin (Supadata's API doesn't expose that). */
export type TranscriptResolvedVia = "inline" | "job";

export interface Video {
  id: string;
  user_id: string;
  url: string;
  youtube_id: string;
  title: string | null;
  thumbnail_url: string | null;
  created_at: string;
}

export interface Summary {
  id: string;
  user_id: string;
  video_id: string;
  character: ChannelCharacter;
  content: string;
  model: string | null;
  resolved_via: TranscriptResolvedVia | null;
  created_at: string;
}
