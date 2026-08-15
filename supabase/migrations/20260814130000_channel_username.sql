-- Migration: persist channel username so the summaries list can link to the channel (S-06 phase 10 finding)
-- Created: 20260814130000
--
-- Phase 10's manual sweep found the summaries list has no way to reach the source video or its
-- channel on YouTube. The video side is free (youtube_id is already on every row), but the channel
-- side needs a real identifier: `videos.channel_name` is the vendor's DISPLAY name, not a handle, and
-- is not a valid link target (display names are not unique and are not URL paths). Supadata's
-- metadata response carries `author.username` alongside `author.displayName` but the app has never
-- captured it. This migration adds the column and widens the read/write RPCs to carry it.
--
-- THIS MIGRATION OPENS A DEPLOY WINDOW, same class as 20260725120000 and 20260731120000: adding an
-- argument to `save_metadata_cache`, `get_metadata_cache` and `persist_summary` changes their
-- signatures, so `create or replace function` would add a second overload rather than replace the
-- existing one (and grants are signature-scoped). Each is therefore dropped and recreated. Between
-- `supabase db push --linked` and `wrangler deploy` the live Worker calls a signature that no longer
-- exists and every generation fails at persist, after the LLM has already been paid for — the two
-- commands must run back to back with no gap.
--
-- Rollback: re-apply 20260731120000's three function bodies to restore the prior signatures. The two
-- new columns can be left in place; nothing reads them until the app code that populates/renders them
-- is also rolled back.

-- ---------------------------------------------------------------------------------------------
-- 1. New columns. Additive and idempotent, matching the channel_name precedent (20260725120000).
-- ---------------------------------------------------------------------------------------------
alter table public.videos add column if not exists channel_username text;
alter table public.metadata_cache add column if not exists channel_username text;

comment on column public.videos.channel_username is
  'The channel''s YouTube handle (Supadata author.username), e.g. "@kurzgesagt" — used to build a '
  'direct link to the channel. Distinct from channel_name (the display name), which is not a valid '
  'link target. Null on rows predating this column and whenever the vendor did not report one.';

-- ---------------------------------------------------------------------------------------------
-- 2. get_metadata_cache — add channel_username to the returned row.
-- ---------------------------------------------------------------------------------------------
-- Changing a function's return type requires a drop first; `create or replace` refuses ("cannot
-- change return type of existing function").
drop function if exists public.get_metadata_cache(text, integer);

create function public.get_metadata_cache(
  p_youtube_id text,
  p_max_age_seconds integer
)
returns table (
  title text,
  thumbnail_url_reported text,
  channel_name text,
  channel_username text,
  duration_seconds integer,
  published_at timestamptz,
  fetched_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  select m.title, m.thumbnail_url_reported, m.channel_name, m.channel_username, m.duration_seconds,
         m.published_at, m.fetched_at
  from public.metadata_cache m
  where m.youtube_id = p_youtube_id
    and m.fetched_at > now() - make_interval(secs => p_max_age_seconds);
end;
$$;

revoke all on function public.get_metadata_cache(text, integer) from public, anon, authenticated;
grant execute on function public.get_metadata_cache(text, integer) to service_role;

-- ---------------------------------------------------------------------------------------------
-- 3. save_metadata_cache — one more argument, one more column in the upsert.
-- ---------------------------------------------------------------------------------------------
drop function if exists public.save_metadata_cache(text, text, text, text, integer, timestamptz);

create function public.save_metadata_cache(
  p_youtube_id text,
  p_title text,
  p_thumbnail_url_reported text,
  p_channel_name text,
  p_channel_username text,
  p_duration_seconds integer,
  p_published_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.metadata_cache (
    youtube_id, title, thumbnail_url_reported, channel_name, channel_username, duration_seconds,
    published_at, fetched_at
  )
  values (
    p_youtube_id, p_title, p_thumbnail_url_reported, p_channel_name, p_channel_username,
    p_duration_seconds, p_published_at, now()
  )
  on conflict (youtube_id) do update set
    title = excluded.title,
    thumbnail_url_reported = excluded.thumbnail_url_reported,
    channel_name = excluded.channel_name,
    channel_username = excluded.channel_username,
    duration_seconds = excluded.duration_seconds,
    published_at = excluded.published_at,
    fetched_at = excluded.fetched_at;
end;
$$;

revoke all on function public.save_metadata_cache(text, text, text, text, text, integer, timestamptz)
  from public, anon, authenticated;
grant execute on function public.save_metadata_cache(text, text, text, text, text, integer, timestamptz)
  to service_role;

-- ---------------------------------------------------------------------------------------------
-- 4. persist_summary swap — 24 arguments to 25. Decision logic unchanged from 20260731120000; only
--    the videos upsert grows one coalesced column.
-- ---------------------------------------------------------------------------------------------
drop function if exists public.persist_summary(
  uuid, uuid, text, text, text, text, text, text, text, text, text, integer, timestamptz, text, text[],
  integer, integer, integer, integer, integer, numeric, integer, integer, text
);

create function public.persist_summary(
  target_user uuid,
  reservation uuid,
  p_url text,
  p_youtube_id text,
  p_character text,
  p_content text,
  p_model text,
  p_resolved_via text,
  p_title text,
  p_thumbnail_url_reported text,
  p_channel_name text,
  p_channel_username text,
  p_duration_seconds integer,
  p_published_at timestamptz,
  p_transcript_lang text,
  p_transcript_available_langs text[],
  p_transcript_chars integer,
  p_generation_ms integer,
  p_transcript_ms integer,
  p_llm_ms integer,
  p_metadata_ms integer,
  p_cost_usd numeric,
  p_prompt_tokens integer,
  p_completion_tokens integer,
  p_metadata_via text
)
returns table (outcome text, video_id uuid, summary_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  res_status text;
  v_id uuid;
  s_id uuid;
begin
  if target_user is null or reservation is null then
    raise exception 'persist_summary requires a user and a reservation';
  end if;

  select cr.status into res_status
  from public.credit_reservations cr
  where cr.id = reservation and cr.user_id = target_user
  for update;

  if res_status is null then
    outcome := 'not_reserved';
    video_id := null;
    summary_id := null;
    return next;
    return;
  end if;

  select s.id, s.video_id into s_id, v_id
  from public.summaries s
  where s.reservation_id = reservation and s.user_id = target_user;

  if s_id is not null then
    outcome := 'already_persisted';
    video_id := v_id;
    summary_id := s_id;
    return next;
    return;
  end if;

  if res_status <> 'reserved' then
    outcome := 'not_reserved';
    video_id := null;
    summary_id := null;
    return next;
    return;
  end if;

  insert into public.videos (
    user_id, url, youtube_id, title, thumbnail_url_reported,
    channel_name, channel_username, duration_seconds, published_at, transcript_lang,
    transcript_available_langs
  )
  values (
    target_user, p_url, p_youtube_id, p_title, p_thumbnail_url_reported,
    p_channel_name, p_channel_username, p_duration_seconds, p_published_at, p_transcript_lang,
    p_transcript_available_langs
  )
  on conflict (user_id, youtube_id) do update set
    url = excluded.url,
    title = coalesce(excluded.title, videos.title),
    thumbnail_url_reported = coalesce(excluded.thumbnail_url_reported, videos.thumbnail_url_reported),
    channel_name = coalesce(excluded.channel_name, videos.channel_name),
    channel_username = coalesce(excluded.channel_username, videos.channel_username),
    duration_seconds = coalesce(excluded.duration_seconds, videos.duration_seconds),
    published_at = coalesce(excluded.published_at, videos.published_at),
    transcript_lang = coalesce(excluded.transcript_lang, videos.transcript_lang),
    transcript_available_langs =
      coalesce(excluded.transcript_available_langs, videos.transcript_available_langs)
  returning id into v_id;

  insert into public.summaries (
    user_id, video_id, character, content, model, resolved_via, reservation_id,
    transcript_chars, generation_ms, transcript_ms, llm_ms, metadata_ms,
    cost_usd, prompt_tokens, completion_tokens, metadata_via
  )
  values (
    target_user, v_id, p_character, p_content, p_model, p_resolved_via, reservation,
    p_transcript_chars, p_generation_ms, p_transcript_ms, p_llm_ms, p_metadata_ms,
    p_cost_usd, p_prompt_tokens, p_completion_tokens, p_metadata_via
  )
  returning id into s_id;

  update public.credit_reservations
  set status = 'settled', resolved_at = now()
  where id = reservation;

  outcome := 'persisted';
  video_id := v_id;
  summary_id := s_id;
  return next;
end;
$$;

revoke all on function public.persist_summary(
  uuid, uuid, text, text, text, text, text, text, text, text, text, text, integer, timestamptz, text,
  text[], integer, integer, integer, integer, integer, numeric, integer, integer, text
) from public, anon, authenticated;
grant execute on function public.persist_summary(
  uuid, uuid, text, text, text, text, text, text, text, text, text, text, integer, timestamptz, text,
  text[], integer, integer, integer, integer, integer, numeric, integer, integer, text
) to service_role;
