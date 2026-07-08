export type ChannelCharacter = "informational" | "educational";

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
  created_at: string;
}
