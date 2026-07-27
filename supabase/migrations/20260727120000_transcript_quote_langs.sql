-- Migration: carry transcript language fields through the quote cache (impl-review F10)
-- Created: 20260727120000
--
-- Why this exists: S-08 added `transcript_lang` / `transcript_available_langs` to `videos`, but the
-- one path that reads a transcript from cache — the `allowLong` confirmation resubmit — had no
-- language data to persist, because `transcript_quotes` stored only the body and `resolved_via`.
-- It wrote null to both columns.
--
-- The manual verification run showed why that matters more than "one path is incomplete". Only
-- transcripts over 40,000 characters trigger the 409/confirm/cache path, so the nulls are not
-- randomly distributed: they fall exclusively on LONG videos, and only when the confirmation lands
-- inside the 600-second TTL. The diagnostic columns were therefore systematically blind to the
-- longest content — and after F9 (the transcript fetch now requests `lang: "en"`), those columns are
-- the instrument for measuring how often a non-original track is still selected. A blind spot
-- correlated with content length would bias exactly the measurement they exist to serve.
--
-- Both values are already in hand at `save_transcript_quote` call time, so nothing extra is fetched
-- and no Supadata credit is spent to close this.
--
-- EXPAND-ONLY, deliberately: the two new `save_transcript_quote` parameters are appended and carry
-- DEFAULT null, so a Worker still calling the 6-argument form resolves to this function unchanged.
-- `get_transcript_quote` gains two result columns, which an older caller simply ignores. The
-- currently-deployed Worker keeps working until the one that populates these fields is live.

-- 1. The two columns, mirroring `videos.transcript_lang` / `videos.transcript_available_langs`.
alter table public.transcript_quotes
  add column if not exists lang text,
  add column if not exists available_langs text[];

comment on column public.transcript_quotes.lang is
  'ISO 639-1 code Supadata actually returned for the cached transcript. Diagnostic; carried so the allowLong confirmation resubmit can persist it to videos.transcript_lang instead of writing null.';
comment on column public.transcript_quotes.available_langs is
  'Caption-track pool Supadata reported alongside the cached transcript. Diagnostic; carried for the same reason as lang.';

-- 2. get_transcript_quote: same signature, two extra result columns. Return type changed, so the old
-- function must be dropped rather than replaced. Atomic — Supabase runs each migration in one
-- transaction, so no window exists where the function is missing.
drop function if exists public.get_transcript_quote(uuid, text, text);

create function public.get_transcript_quote(
  target_user uuid,
  p_youtube_id text,
  p_character text
)
returns table (transcript_content text, resolved_via text, lang text, available_langs text[])
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.transcript_quotes
  where user_id = target_user and youtube_id = p_youtube_id and character = p_character
    and expires_at <= now();

  return query
  select q.transcript_content, q.resolved_via, q.lang, q.available_langs
  from public.transcript_quotes q
  where q.user_id = target_user and q.youtube_id = p_youtube_id and q.character = p_character
    and q.expires_at > now();
end;
$$;

revoke all on function public.get_transcript_quote(uuid, text, text) from public, anon, authenticated;
grant execute on function public.get_transcript_quote(uuid, text, text) to service_role;

-- 3. save_transcript_quote: two appended parameters, both defaulted so the previous 6-argument call
-- still resolves. Adding parameters changes the identity of the function, so the old one is dropped
-- explicitly — otherwise PostgreSQL would keep it as a second overload and a 6-argument call would
-- become ambiguous.
drop function if exists public.save_transcript_quote(uuid, text, text, text, text, integer);

create function public.save_transcript_quote(
  target_user uuid,
  p_youtube_id text,
  p_character text,
  p_content text,
  p_resolved_via text,
  ttl_seconds integer,
  p_lang text default null,
  p_available_langs text[] default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.transcript_quotes (
    user_id, youtube_id, character, transcript_content, resolved_via, lang, available_langs, expires_at
  )
  values (
    target_user, p_youtube_id, p_character, p_content, p_resolved_via, p_lang, p_available_langs,
    now() + make_interval(secs => ttl_seconds)
  )
  on conflict (user_id, youtube_id, character)
  do update set
    transcript_content = excluded.transcript_content,
    resolved_via = excluded.resolved_via,
    lang = excluded.lang,
    available_langs = excluded.available_langs,
    created_at = now(),
    expires_at = excluded.expires_at;
end;
$$;

revoke all on function public.save_transcript_quote(uuid, text, text, text, text, integer, text, text[])
  from public, anon, authenticated;
grant execute on function public.save_transcript_quote(uuid, text, text, text, text, integer, text, text[])
  to service_role;
