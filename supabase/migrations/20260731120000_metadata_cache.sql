-- Migration: shared metadata cache + the metadata_via hit marker (S-09 Phase 4)
-- Created: 20260731120000
--
-- With S-07's transcript_cache live, the metadata call is 100% of a repeat generation's Supadata
-- spend: `fetchVideoMetadata` runs unconditionally on every successful generation with no lookup in
-- front of it, even though the transcript costs 0 the second time. This migration adds the lookup's
-- storage (D6) and the column that makes its hits countable (D10).
--
-- Four parts:
--   1. public.metadata_cache      — shared, user-agnostic metadata cache keyed by youtube_id
--   2. get_metadata_cache         — read inside a caller-supplied window
--   3. save_metadata_cache        — non-coalescing upsert
--   4. summaries.metadata_via     — 'fetched' | 'stored' | 'skipped_budget'
--   5. persist_summary swapped 23 -> 24 arguments so it can write that column
--
-- THIS IS THE ONLY MIGRATION IN S-09 THAT OPENS A DEPLOY WINDOW, and part 5 is why. As in
-- 20260725120000 and 20260728120000: `create or replace function` with a different parameter list
-- produces a SECOND overload rather than a replacement, and grants are signature-scoped — so the
-- 23-argument function is dropped and the 24-argument one created in its place. Between
-- `supabase db push --linked` and `wrangler deploy` the live Worker calls a signature that no longer
-- exists and EVERY generation fails at persist, after the LLM has already been paid for. The two
-- commands are ONE operation, run back to back with no gap (S-09 Phase 7).
--
-- Rollback: re-apply 20260728120000's function body to restore the 23-argument signature. The cache
-- table and `metadata_via` can be left in place — a row carrying a non-null `metadata_via` is
-- harmless to the old function, which simply never writes it.

-- ---------------------------------------------------------------------------------------------
-- 1. metadata_cache — user-agnostic, shared across all users.
-- ---------------------------------------------------------------------------------------------
--
-- Keyed by youtube_id and deliberately NOT placed on `videos`, for exactly the reason S-07 kept
-- transcripts off it (D6): `videos` is per-user with `on delete cascade` to auth.users, so one
-- account deletion would evict metadata every other user shares. Video metadata is public
-- third-party content and holds no personal data, so a shared row is the honest shape.
--
-- Column names and types MIRROR `videos` exactly — `thumbnail_url_reported` included, whose name
-- records that the value is what Supadata said and is never repaired. That is not cosmetic: a cached
-- row is fed straight into persist_summary's existing `videos` upsert (D12), and a mapping layer
-- between two spellings of the same five fields is exactly where a silent field mix-up would live.
--
-- NO negative-outcome column, unlike transcript_cache. D9 declines to cache failures at all: a failed
-- metadata call is billed 0, so caching the failure saves nothing while persisting nulls for a video
-- whose next attempt would likely succeed. There is one outcome here and one window.
create table if not exists public.metadata_cache (
  youtube_id text primary key,
  title text,
  thumbnail_url_reported text,
  channel_name text,
  duration_seconds integer,
  published_at timestamptz,
  fetched_at timestamptz not null default now()
);

comment on table public.metadata_cache is
  'Shared, user-agnostic video metadata cache (S-09 D6). One row per YouTube video, overwritten on '
  'refresh. Not a column set on `videos` because that table is per-user and cascades on account '
  'deletion, which would evict data every other user shares. Public third-party content only. Holds '
  'successful fetches ONLY — D9 declines to cache failures, which are billed 0 and so save nothing.';
comment on column public.metadata_cache.thumbnail_url_reported is
  'Exactly what Supadata reported, never repaired — same contract as videos.thumbnail_url_reported. '
  'Supadata returns maxresdefault.jpg, which does not exist for videos never uploaded above 480p, so '
  'a renderer must fall back on both null and a 404 and must never write the fallback back.';
comment on column public.metadata_cache.fetched_at is
  'When the vendor was last asked. The reuse window is applied at READ time by get_metadata_cache '
  'against a caller-supplied age, so the window can be changed without touching stored rows.';

-- RLS on with no policies, plus an explicit revoke — definer-only by construction, matching
-- transcript_cache / supadata_calls / generation_locks. Reachable only through the two RPCs below.
alter table public.metadata_cache enable row level security;
revoke all on table public.metadata_cache from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- 2. get_metadata_cache — read inside the caller's window.
-- ---------------------------------------------------------------------------------------------
--
-- Simpler than get_transcript_cache, which needs TWO windows because its outcomes expire
-- differently. Metadata has one outcome, so it has one window.
--
-- The window is a caller-supplied ARGUMENT rather than baked in, following the same convention: the
-- constant and the reasoning for its value live together in the service (see
-- METADATA_CACHE_MAX_AGE_SECONDS in src/lib/services/metadata-cache.ts), not split between a comment
-- here and a number there.
create or replace function public.get_metadata_cache(
  p_youtube_id text,
  p_max_age_seconds integer
)
returns table (
  title text,
  thumbnail_url_reported text,
  channel_name text,
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
  select m.title, m.thumbnail_url_reported, m.channel_name, m.duration_seconds, m.published_at,
         m.fetched_at
  from public.metadata_cache m
  where m.youtube_id = p_youtube_id
    and m.fetched_at > now() - make_interval(secs => p_max_age_seconds);
end;
$$;

revoke all on function public.get_metadata_cache(text, integer) from public, anon, authenticated;
grant execute on function public.get_metadata_cache(text, integer) to service_role;

-- ---------------------------------------------------------------------------------------------
-- 3. save_metadata_cache — upsert, overwriting EVERY field including fetched_at.
-- ---------------------------------------------------------------------------------------------
--
-- Deliberately does NOT coalesce, matching save_transcript_cache's rationale and deliberately
-- differing from persist_summary's `videos` upsert: this row is written only after a SUCCESSFUL
-- fetch past the window, which is exactly the case where the new value must win. Titles and
-- thumbnails do change, and a refresh that preserved the old ones would defeat the point of having a
-- window at all.
--
-- Returns void, NOT a duplicate-fetch signal. save_transcript_cache returns one because a duplicate
-- transcript fetch is expensive and was worth measuring; a duplicate metadata fetch costs 1 credit
-- and is already visible as a second row in supadata_calls. No advisory lock either, for the same
-- reason — there is nothing to serialize when nothing is being measured.
create or replace function public.save_metadata_cache(
  p_youtube_id text,
  p_title text,
  p_thumbnail_url_reported text,
  p_channel_name text,
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
    youtube_id, title, thumbnail_url_reported, channel_name, duration_seconds, published_at, fetched_at
  )
  values (
    p_youtube_id, p_title, p_thumbnail_url_reported, p_channel_name, p_duration_seconds,
    p_published_at, now()
  )
  on conflict (youtube_id) do update set
    title = excluded.title,
    thumbnail_url_reported = excluded.thumbnail_url_reported,
    channel_name = excluded.channel_name,
    duration_seconds = excluded.duration_seconds,
    published_at = excluded.published_at,
    fetched_at = excluded.fetched_at;
end;
$$;

revoke all on function public.save_metadata_cache(text, text, text, text, integer, timestamptz)
  from public, anon, authenticated;
grant execute on function public.save_metadata_cache(text, text, text, text, integer, timestamptz)
  to service_role;

-- ---------------------------------------------------------------------------------------------
-- 4. summaries.metadata_via — how this generation got its metadata.
-- ---------------------------------------------------------------------------------------------
--
-- Without this, cost-per-generation queries start lying within a week of shipping (D10): a 'stored'
-- row made no paid call, and nothing else on the row says so. Nullable, with null on every row
-- predating this migration — an unobserved value is not reconstructed from an inference, the same
-- rule D11 and D13 follow.
--
-- 'skipped_budget' is declared HERE although nothing writes it until Phase 6, so the constraint is
-- written once rather than altered twice.
alter table public.summaries add column if not exists metadata_via text;

alter table public.summaries drop constraint if exists summaries_metadata_via_check;
alter table public.summaries
  add constraint summaries_metadata_via_check
  check (metadata_via is null or metadata_via in ('fetched', 'stored', 'skipped_budget'));

comment on column public.summaries.metadata_via is
  'How this generation obtained video metadata: ''fetched'' = a real, billed Supadata call; '
  '''stored'' = served from metadata_cache with NO paid call; ''skipped_budget'' = the budget breaker '
  'refused the call and nulls were persisted (S-09 Phase 6). Null on rows predating S-09 Phase 4. '
  'METADATA_MS IS ONLY COMPARABLE ACROSS ''fetched'' ROWS: on a hit that column brackets a database '
  'read and reads near zero, on a fetch it brackets an HTTP call including its ~1.2 s rate-limit '
  'retry sleep. Any query comparing metadata_ms must filter on metadata_via = ''fetched''.';

-- ---------------------------------------------------------------------------------------------
-- 5. persist_summary swap — 23 arguments to 24.
-- ---------------------------------------------------------------------------------------------
--
-- EVERYTHING about how the function DECIDES is preserved verbatim from 20260728120000: the
-- `for update` ledger lock, the replay guard, the status gate, the outcome tags, the settle, and the
-- COALESCING `on conflict` for the videos metadata columns. Only the summaries insert column list
-- grows by one.
--
-- That coalescing upsert is why D12 needs no new write path. A cache hit feeds the same `metadata`
-- argument a fetch would have: the per-user `videos` row is populated on a hit exactly as on a fetch,
-- which S-02's list depends on. The cache FEEDS this upsert; it does not replace it.
drop function if exists public.persist_summary(
  uuid, uuid, text, text, text, text, text, text, text, text, text, integer, timestamptz, text, text[],
  integer, integer, integer, integer, integer, numeric, integer, integer
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

  -- Lock the ledger row FIRST, before writing anything. This is the serialization point against a
  -- concurrent reconcile_reservation() on the same row: whichever takes the lock decides the outcome,
  -- and the loser sees the status the winner committed instead of acting on a stale read.
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

  -- Replay guard, checked before the status gate so a duplicate call returns the original ids rather
  -- than tripping the unique constraint on summaries.reservation_id. Only ever reachable when a
  -- retry re-uses a reservation this function already closed.
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

  -- Settled without a summary, or already refunded: the debit is closed and this work was not the
  -- thing that closed it. Persisting now would hand out work against a reversed charge.
  --
  -- S-09 Phase 3 note: a settled row carrying a `refusal_reason` is exactly this case — the refusal
  -- charge settles in one statement and writes no summary — and it lands here correctly. That path
  -- never reaches persist_summary anyway, because the 422 returns ~200 lines upstream.
  if res_status <> 'reserved' then
    outcome := 'not_reserved';
    video_id := null;
    summary_id := null;
    return next;
    return;
  end if;

  -- Get-or-create the video, then append the summary. Never replaces an existing summary — a repeat
  -- generation of the same video appends a new row, matching the pre-F23 persist path.
  --
  -- Every metadata column is COALESCEd on conflict. A second generation of the same video (the other
  -- `character`) re-runs this upsert, and its metadata fetch may have failed where the first one
  -- succeeded; a plain `set title = excluded.title` would then erase metadata already captured. `url`
  -- stays the one unconditional overwrite, as it was before. Note the unqualified `videos.` prefix:
  -- inside ON CONFLICT DO UPDATE the insert target is aliased by its bare table name even though this
  -- function runs under `set search_path = '`.
  --
  -- S-09 D12: on a metadata_cache HIT the caller passes the cached values through these same
  -- arguments, so this upsert runs identically and the per-user row is populated whether the data
  -- came from the vendor or from the cache. "Hit -> skip the write" is the natural regression and it
  -- would leave the second user's list rendering nulls.
  insert into public.videos (
    user_id, url, youtube_id, title, thumbnail_url_reported,
    channel_name, duration_seconds, published_at, transcript_lang, transcript_available_langs
  )
  values (
    target_user, p_url, p_youtube_id, p_title, p_thumbnail_url_reported,
    p_channel_name, p_duration_seconds, p_published_at, p_transcript_lang, p_transcript_available_langs
  )
  on conflict (user_id, youtube_id) do update set
    url = excluded.url,
    title = coalesce(excluded.title, videos.title),
    thumbnail_url_reported = coalesce(excluded.thumbnail_url_reported, videos.thumbnail_url_reported),
    channel_name = coalesce(excluded.channel_name, videos.channel_name),
    duration_seconds = coalesce(excluded.duration_seconds, videos.duration_seconds),
    published_at = coalesce(excluded.published_at, videos.published_at),
    transcript_lang = coalesce(excluded.transcript_lang, videos.transcript_lang),
    transcript_available_langs =
      coalesce(excluded.transcript_available_langs, videos.transcript_available_langs)
  returning id into v_id;

  -- The only part of this function that changed in S-09 Phase 4: `metadata_via` appended to the
  -- insert. Telemetry commits in the SAME transaction as the summary it describes — that atomicity is
  -- why generation_ms is frozen before this call rather than measured to the response.
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

  -- Same transaction as the writes above: the charge and the delivery commit together or not at all.
  update public.credit_reservations
  set status = 'settled', resolved_at = now()
  where id = reservation;

  outcome := 'persisted';
  video_id := v_id;
  summary_id := s_id;
  return next;
end;
$$;

-- Least privilege, re-granted against the NEW signature — the old signature's grants disappeared with
-- the dropped function. persist_summary takes an explicit user_id and is SECURITY DEFINER, so an
-- authenticated caller reaching it could write summaries against another user's reservation.
-- service_role only, via the admin client the generate endpoint already requires in preflight.
revoke all on function public.persist_summary(
  uuid, uuid, text, text, text, text, text, text, text, text, text, integer, timestamptz, text, text[],
  integer, integer, integer, integer, integer, numeric, integer, integer, text
) from public, anon, authenticated;
grant execute on function public.persist_summary(
  uuid, uuid, text, text, text, text, text, text, text, text, text, integer, timestamptz, text, text[],
  integer, integer, integer, integer, integer, numeric, integer, integer, text
) to service_role;
