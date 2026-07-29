-- ---------------------------------------------------------------------------------------------
-- transcript_cache: a fourth outcome, 'too_long', for transcripts the app will never summarize.
-- ---------------------------------------------------------------------------------------------
--
-- Closes S-07 impl-review finding F6. 20260728120000 caches every successful fetch BEFORE the
-- HARD_MAX_TRANSCRIPT_CHARS gate rejects it, so the table can retain bodies arbitrarily larger than
-- the 200k characters its own comment promises — text that is stored, re-read, and then thrown away
-- for a 413 on every subsequent hit. A user with credit can add such rows as fast as the transcript
-- rate limit allows.
--
-- The obvious alternative — simply not caching an over-cap fetch — was rejected: it would re-pay
-- Supadata for the same over-long video on every attempt, which is precisely the spend this cache
-- exists to stop. 'too_long' keeps the deduplication and drops only the unusable payload:
--
--   'ok'          usable text                             → summarize it
--   'empty'       vendor success, whitespace-only body    → 422 for free
--   'unavailable' vendor said transcript-unavailable      → 422 for free, SHORT window
--   'too_long'    usable text, past the hard cap          → 413 for free; body NOT stored
--
-- Window: the 30-day one, by falling through get_transcript_cache's `case` unchanged. A transcript
-- does not get shorter, so unlike 'unavailable' this claim cannot stop being true. (A re-uploaded or
-- re-captioned video heals on expiry like any other row.)
--
-- `content` stays '' — the row asserts a fact about size, and storing the body would defeat its
-- purpose. `content_chars` records what that size WAS, because otherwise the row says "too long"
-- while destroying the only evidence of by how much, and S-09's cost work needs the distribution.
--
-- Rollback: rows with outcome = 'too_long' must be deleted before the old CHECK can be restored.
-- Deleting them is safe — the cache is a spend optimisation, not a source of truth.

-- ---------------------------------------------------------------------------------------------
-- 1. Widen the CHECK and record the observed size.
-- ---------------------------------------------------------------------------------------------
alter table public.transcript_cache drop constraint if exists transcript_cache_outcome_check;
alter table public.transcript_cache
  add constraint transcript_cache_outcome_check
  check (outcome in ('ok', 'empty', 'unavailable', 'too_long'));

alter table public.transcript_cache add column if not exists content_chars integer;

comment on column public.transcript_cache.outcome is
  'What the vendor did, and what this app can do with it: ''ok'' returned usable text, ''empty'' '
  'returned success with a whitespace-only body, ''unavailable'' said transcript-unavailable, '
  '''too_long'' returned text past HARD_MAX_TRANSCRIPT_CHARS (body deliberately NOT stored — see '
  'content_chars). Code branches on THIS, not on content = ''''. Reuse windows differ per outcome — '
  'see get_transcript_cache.';
comment on column public.transcript_cache.content_chars is
  'Observed transcript length in characters. Populated for ''too_long'', where the body is not '
  'stored and this is the only surviving record of the size; null elsewhere, where length(content) '
  'already answers it. Diagnostic — gates nothing.';

-- ---------------------------------------------------------------------------------------------
-- 2. save_transcript_cache — one new argument, so the old signature is dropped, not overloaded.
-- ---------------------------------------------------------------------------------------------
--
-- `create or replace` with a different argument list would create a second overload rather than
-- replace the function, leaving a stale 8-argument version callable. Dropped explicitly for the same
-- reason 20260728120000 gave for persist_summary. The body is otherwise unchanged, including the
-- advisory-lock serialization point and the duplicate-fetch signal.
drop function if exists public.save_transcript_cache(text, text, text, text, text[], text, text, integer);

create or replace function public.save_transcript_cache(
  p_youtube_id text,
  p_content text,
  p_outcome text,
  p_lang text,
  p_available_langs text[],
  p_requested_lang text,
  p_resolved_via text,
  p_fetch_duration_ms integer,
  p_content_chars integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  previous_fetched_at timestamptz;
  duplicate boolean := false;
begin
  -- Serialization point for the duplicate-fetch signal. On a cold miss the row does not exist yet,
  -- so `for update` has nothing to lock; a transaction-scoped advisory lock keyed by the video is
  -- what orders the read/compare/upsert across concurrent cold writers. Without it two cold
  -- transactions both read a null fetched_at and both return false, so the wasted fetch goes
  -- unmeasured and the promised N-1 signal silently under-reports. This serializes only the cheap
  -- cache-write decision — the paid fetch already happened before this call.
  perform pg_advisory_xact_lock(hashtext(p_youtube_id));

  select c.fetched_at into previous_fetched_at
  from public.transcript_cache c
  where c.youtube_id = p_youtube_id;

  if previous_fetched_at is not null and p_fetch_duration_ms is not null then
    duplicate := now() - previous_fetched_at < make_interval(secs => p_fetch_duration_ms / 1000.0);
  end if;

  insert into public.transcript_cache (
    youtube_id, content, outcome, lang, available_langs, requested_lang, resolved_via,
    content_chars, fetched_at
  )
  values (
    p_youtube_id, p_content, p_outcome, p_lang, p_available_langs, p_requested_lang, p_resolved_via,
    p_content_chars, now()
  )
  on conflict (youtube_id) do update set
    content = excluded.content,
    outcome = excluded.outcome,
    lang = excluded.lang,
    available_langs = excluded.available_langs,
    requested_lang = excluded.requested_lang,
    resolved_via = excluded.resolved_via,
    content_chars = excluded.content_chars,
    fetched_at = excluded.fetched_at;

  return duplicate;
end;
$$;

revoke all on function public.save_transcript_cache(text, text, text, text, text[], text, text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.save_transcript_cache(text, text, text, text, text[], text, text, integer, integer)
  to service_role;
