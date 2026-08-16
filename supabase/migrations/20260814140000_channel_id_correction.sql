-- Migration: channel identifier correction — username was never a real field (S-06 phase 10 finding 2, follow-up)
-- Created: 20260814140000
--
-- 20260814130000 added `channel_username`, sourced from `metadata.author.username`. That field does
-- not exist in Supadata's YouTube response — the SDK's `MetadataAuthor` type declares it a required
-- `string`, but the real response (captured in
-- context/changes/persist-video-metadata/docs/supadata-metadata.md) carries only
-- `author.displayName` and `author.avatarUrl`. Every row written since 20260814130000 therefore has
-- `channel_username = null`, and the channel link never appears.
--
-- The stable identifier YouTube actually returns is `additionalData.channelId` (e.g.
-- "UCuAXFkgsw1L7xaCfnd5JJOw") — a raw channel id, not a handle, so the app now links to
-- `youtube.com/channel/<id>` rather than `youtube.com/@handle`. This migration renames the column
-- and its RPC plumbing to match what it actually holds; no row had a non-null value to preserve.
--
-- Same deploy-window discipline as 20260814130000 and its predecessors: `get_metadata_cache`'s
-- return columns change, which requires a drop regardless, so all three touched functions are
-- dropped and recreated together for consistency. `db push` and `wrangler deploy` run back to back.
--
-- Rollback: re-apply 20260814130000's three function bodies and rename the columns back. Both hold
-- only nulls at this point, so there is nothing to lose either direction.

alter table public.videos rename column channel_username to channel_id;
alter table public.metadata_cache rename column channel_username to channel_id;

comment on column public.videos.channel_id is
  'The channel''s stable YouTube identifier (Supadata additionalData.channelId), e.g. '
  '"UCuAXFkgsw1L7xaCfnd5JJOw" — used to build a direct youtube.com/channel/<id> link. NOT a handle: '
  'YouTube responses carry no author.username, unlike other platforms Supadata supports. Null on rows '
  'predating 20260814130000 and whenever the vendor did not report one.';

-- ---------------------------------------------------------------------------------------------
-- get_metadata_cache — rename the returned column.
-- ---------------------------------------------------------------------------------------------
drop function if exists public.get_metadata_cache(text, integer);

create function public.get_metadata_cache(
  p_youtube_id text,
  p_max_age_seconds integer
)
returns table (
  title text,
  thumbnail_url_reported text,
  channel_name text,
  channel_id text,
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
  select m.title, m.thumbnail_url_reported, m.channel_name, m.channel_id, m.duration_seconds,
         m.published_at, m.fetched_at
  from public.metadata_cache m
  where m.youtube_id = p_youtube_id
    and m.fetched_at > now() - make_interval(secs => p_max_age_seconds);
end;
$$;

revoke all on function public.get_metadata_cache(text, integer) from public, anon, authenticated;
grant execute on function public.get_metadata_cache(text, integer) to service_role;

-- ---------------------------------------------------------------------------------------------
-- save_metadata_cache — rename the argument and the column it writes.
-- ---------------------------------------------------------------------------------------------
drop function if exists public.save_metadata_cache(text, text, text, text, text, integer, timestamptz);

create function public.save_metadata_cache(
  p_youtube_id text,
  p_title text,
  p_thumbnail_url_reported text,
  p_channel_name text,
  p_channel_id text,
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
    youtube_id, title, thumbnail_url_reported, channel_name, channel_id, duration_seconds,
    published_at, fetched_at
  )
  values (
    p_youtube_id, p_title, p_thumbnail_url_reported, p_channel_name, p_channel_id,
    p_duration_seconds, p_published_at, now()
  )
  on conflict (youtube_id) do update set
    title = excluded.title,
    thumbnail_url_reported = excluded.thumbnail_url_reported,
    channel_name = excluded.channel_name,
    channel_id = excluded.channel_id,
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
-- persist_summary — rename the argument and the videos column it writes. Decision logic otherwise
-- unchanged from 20260814130000.
-- ---------------------------------------------------------------------------------------------
drop function if exists public.persist_summary(
  uuid, uuid, text, text, text, text, text, text, text, text, text, text, integer, timestamptz, text,
  text[], integer, integer, integer, integer, integer, numeric, integer, integer, text
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
  p_channel_id text,
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
    channel_name, channel_id, duration_seconds, published_at, transcript_lang,
    transcript_available_langs
  )
  values (
    target_user, p_url, p_youtube_id, p_title, p_thumbnail_url_reported,
    p_channel_name, p_channel_id, p_duration_seconds, p_published_at, p_transcript_lang,
    p_transcript_available_langs
  )
  on conflict (user_id, youtube_id) do update set
    url = excluded.url,
    title = coalesce(excluded.title, videos.title),
    thumbnail_url_reported = coalesce(excluded.thumbnail_url_reported, videos.thumbnail_url_reported),
    channel_name = coalesce(excluded.channel_name, videos.channel_name),
    channel_id = coalesce(excluded.channel_id, videos.channel_id),
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
