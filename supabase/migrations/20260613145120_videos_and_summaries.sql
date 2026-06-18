-- Migration: videos and summaries tables with per-user RLS
-- Created: 20260613145120

create table if not exists public.videos (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  url text not null,
  youtube_id text not null,
  title text,
  thumbnail_url text,
  created_at timestamptz not null default now(),
  unique (user_id, youtube_id),
  unique (id, user_id)
);

alter table public.videos enable row level security;

create policy "videos_select_authenticated" on public.videos
  for select to authenticated using (auth.uid() = user_id);

create policy "videos_insert_authenticated" on public.videos
  for insert to authenticated with check (auth.uid() = user_id);

create policy "videos_update_authenticated" on public.videos
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "videos_delete_authenticated" on public.videos
  for delete to authenticated using (auth.uid() = user_id);

create table if not exists public.summaries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  video_id uuid not null,
  character text not null check (character in ('informational', 'educational')),
  content text not null,
  created_at timestamptz not null default now(),
  foreign key (video_id, user_id) references public.videos (id, user_id) on delete cascade
);

create index summaries_user_id_idx on public.summaries (user_id);
create index summaries_video_id_idx on public.summaries (video_id);

alter table public.summaries enable row level security;

create policy "summaries_select_authenticated" on public.summaries
  for select to authenticated using (auth.uid() = user_id);

create policy "summaries_insert_authenticated" on public.summaries
  for insert to authenticated with check (auth.uid() = user_id);

create policy "summaries_update_authenticated" on public.summaries
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "summaries_delete_authenticated" on public.summaries
  for delete to authenticated using (auth.uid() = user_id);
