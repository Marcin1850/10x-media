-- Migration: generation telemetry, shared transcript cache and Supadata call ledger (S-07 Phase 1)
-- Created: 20260728120000
--
-- Every generation currently produces a summary and forgets how it was made. This migration lands the
-- storage for the facts: how long each external call took, what OpenRouter charged, exactly which
-- Supadata calls were made (including on requests that never produced a summary), and how large the
-- input was. It also stops re-paying for a transcript already fetched, via a shared, user-agnostic
-- cache.
--
-- Five parts:
--   1. public.transcript_cache  — shared positive AND negative transcript cache, keyed by youtube_id
--   2. public.supadata_calls    — append-only ledger of real Supadata HTTP calls
--   3. eight telemetry columns on public.summaries
--   4. two widened resolved_via CHECK constraints (summaries AND transcript_quotes)
--   5. persist_summary swapped for a 23-argument signature that can write the new columns
--
-- NOT expand/contract for part 5, deliberately — same reasoning S-08 recorded in
-- 20260725120000_video_metadata.sql:11-22. `create or replace function` with a different parameter
-- list produces a SECOND overload rather than a replacement, and grants are signature-scoped, so the
-- 15-argument function is dropped and the 23-argument one created in its place. That leaves a window
-- in which the live Worker calls a signature that no longer exists: `npx supabase db push` and
-- `npx wrangler deploy` are ONE operation, run back to back with no gap. The failure mode is
-- survivable (persistSummaryAndSettle throws, the caller refunds the reservation, no user is charged)
-- but the OpenRouter spend for any generation caught in the window is lost.
--
-- Rollback: re-apply 20260725120000_video_metadata.sql's function body to restore the 15-argument
-- signature. The added columns and tables can be left in place; nothing reads them without the Worker.

-- ---------------------------------------------------------------------------------------------
-- 1. transcript_cache — user-agnostic, shared across all users.
-- ---------------------------------------------------------------------------------------------
--
-- Deliberately NOT a column on `videos`. That table is per-user (`unique (user_id, youtube_id)`,
-- `on delete cascade` to auth.users), so it cannot host a cross-user cache: one account deletion
-- would erase a transcript other users depend on, and up to 200k characters would be duplicated per
-- account. Keyed by youtube_id alone this deduplicates across users, holds no personal data (the
-- transcript is public third-party content), and still joins to analytics by youtube_id.
--
-- `outcome` is what makes this a NEGATIVE cache as well as a positive one, and the three values are
-- not interchangeable:
--
--   'ok'          the vendor returned usable text        → summarize it; the paid fetch is skipped
--   'empty'       vendor SUCCESS, whitespace-only body   → 422 for free; an instrumental video is
--                                                          permanently wordless, so re-paying buys
--                                                          the same nothing
--   'unavailable' vendor said `transcript-unavailable`   → 422 for free, but on a SHORT window
--
-- `content` stays `not null` and holds the empty string for both negative outcomes; code branches on
-- `outcome`, never on the emptiness of `content`. Recording them separately costs one column and
-- preserves the distinction between "we were told there is nothing" and "we were given nothing".
--
-- Only 'unavailable' carries the short TTL (see get_transcript_cache below). YouTube publishes
-- auto-captions with a lag after upload, so a fresh video can legitimately answer
-- `transcript-unavailable` now and succeed hours later; caching that for 30 days would lock a recent
-- video — a core use case for this app — out for a month. 'empty' is NOT in that category: it is a
-- vendor success reporting that the video has no words, which does not change. 'failed'/'timeout'
-- are never cached at all: transient by construction, and they say nothing about the video.
create table if not exists public.transcript_cache (
  youtube_id text primary key,
  content text not null,
  outcome text not null default 'ok' check (outcome in ('ok', 'empty', 'unavailable')),
  lang text,
  available_langs text[],
  requested_lang text,
  resolved_via text check (resolved_via is null or resolved_via in ('inline', 'job')),
  fetched_at timestamptz not null default now()
);

comment on table public.transcript_cache is
  'Shared, user-agnostic transcript cache. One row per YouTube video, overwritten on refresh — never '
  'per-user, because a per-user row would cascade away on account deletion and take a transcript other '
  'users depend on with it. Holds public third-party content only, no personal data.';
comment on column public.transcript_cache.outcome is
  'What the vendor did: ''ok'' returned text, ''empty'' returned success with a whitespace-only body, '
  '''unavailable'' said transcript-unavailable. Code branches on THIS, not on content = ''''. Reuse '
  'windows differ per outcome — see get_transcript_cache.';
comment on column public.transcript_cache.requested_lang is
  'Which `lang` the app asked for at fetch time. Diagnostic only — gates nothing.';

-- RLS on with no policies, matching generation_locks / transcript_quotes: definer/service-role-only
-- by construction. A client that could write here could forge a transcript into another user's
-- summary.
alter table public.transcript_cache enable row level security;
revoke all on table public.transcript_cache from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- 2. supadata_calls — append-only ledger of real Supadata HTTP calls.
-- ---------------------------------------------------------------------------------------------
--
-- Rows exist for calls that produced no summary — the 422, 413, 409 and 502 exits — which is exactly
-- the spend that telemetry columns on `summaries` structurally cannot record.
--
-- Both FKs are `set null`, not `cascade`: the operator's bill does not shrink when a user deletes
-- their account or a summary, and nulling the link is what erases the personal data.
create table if not exists public.supadata_calls (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users (id) on delete set null,
  summary_id uuid references public.summaries (id) on delete set null,
  youtube_id text,
  operation text not null check (operation in ('transcript', 'transcript_poll', 'metadata')),
  outcome text not null check (outcome in ('ok', 'unavailable', 'error')),
  resolved_via text,
  billable_credits integer,
  created_at timestamptz not null default now()
);

comment on table public.supadata_calls is
  'Append-only ledger: one row per real Supadata HTTP call, including calls on requests that returned '
  '422/413/409/502 and produced no summary. summary_id is null on those by design.';
comment on column public.supadata_calls.billable_credits is
  'Stored VERBATIM from the response''s `x-billable-requests` header. NULL means the vendor reported '
  'nothing (or the response never arrived); 0 means it reported free. Keeping those two distinct is '
  'what makes a reconciliation gap against GET /v1/me diagnosable rather than merely visible. The '
  'header''s unit (credits vs request count) is settled by Phase 5 run 3 — see '
  'context/changes/persist-time-and-cost/docs/supadata-billable-requests.md.';
comment on column public.supadata_calls.resolved_via is
  'Observed fetch mechanism when known. NOT a billing signal and deliberately unconstrained — nothing '
  'is priced from it (see the plan''s "No inferred credit figure, anywhere").';

alter table public.supadata_calls enable row level security;
revoke all on table public.supadata_calls from public, anon, authenticated;

create index if not exists supadata_calls_created_idx on public.supadata_calls (created_at);
create index if not exists supadata_calls_user_time_idx on public.supadata_calls (user_id, created_at);

-- ---------------------------------------------------------------------------------------------
-- 3. Telemetry columns on summaries. Additive and idempotent, matching the `model` / `resolved_via`
--    precedent (20260708162201 / 20260709120000). RLS untouched: the existing per-user policies
--    cover new columns.
-- ---------------------------------------------------------------------------------------------
alter table public.summaries add column if not exists transcript_chars integer;
alter table public.summaries add column if not exists generation_ms integer;
alter table public.summaries add column if not exists transcript_ms integer;
alter table public.summaries add column if not exists llm_ms integer;
alter table public.summaries add column if not exists metadata_ms integer;
alter table public.summaries add column if not exists cost_usd numeric;
alter table public.summaries add column if not exists prompt_tokens integer;
alter table public.summaries add column if not exists completion_tokens integer;

comment on column public.summaries.transcript_chars is
  'Character count of the transcript this summary was actually built from. Lives here rather than '
  'being read back from transcript_cache because that row is OVERWRITTEN on refresh and would lose '
  'the size of the text an older summary used.';
comment on column public.summaries.generation_ms is
  'Wall clock from the start of the generation pipeline to immediately BEFORE the persist call — not '
  'to the response. persist_summary is the only writer of this table, so the value must be frozen '
  'before the call is made. Excludes the persist round trip, the quote-cache cleanup and response '
  'construction.';
comment on column public.summaries.cost_usd is
  'OpenRouter''s own reported cost for this generation (providerMetadata.openrouter.usage.cost), never '
  'a figure computed from token counts and a price table.';

-- ---------------------------------------------------------------------------------------------
-- 4. Widen the resolved_via CHECK in BOTH places it is constrained, to admit 'stored' — the value a
--    transcript served from the shared cache carries.
-- ---------------------------------------------------------------------------------------------

-- (a) summaries. The constraint was created inline by 20260709120000 and is therefore auto-named;
-- `drop constraint if exists` targets the generated name.
alter table public.summaries drop constraint if exists summaries_resolved_via_check;
alter table public.summaries
  add constraint summaries_resolved_via_check
  check (resolved_via is null or resolved_via in ('inline', 'job', 'stored'));

-- (b) transcript_quotes (20260722130000:82). EASY TO MISS AND FAILS SILENTLY. A long video served
-- from the shared cache arrives at the 409 gate with resolved_via = 'stored' and calls
-- saveTranscriptQuote; the widened TypeScript union compiles fine, the RPC would reject the row, and
-- transcript-guard.ts swallows the error by design. The visible symptom is not an error — it is the
-- confirmation retry paying Supadata again, i.e. exactly the cost this slice exists to remove.
alter table public.transcript_quotes drop constraint if exists transcript_quotes_resolved_via_check;
alter table public.transcript_quotes
  add constraint transcript_quotes_resolved_via_check
  check (resolved_via is null or resolved_via in ('inline', 'job', 'stored'));

-- ---------------------------------------------------------------------------------------------
-- 5. get_transcript_cache — read with the reuse window that applies to the row's OWN outcome.
-- ---------------------------------------------------------------------------------------------
--
-- p_max_age_seconds governs 'ok' AND 'empty'; p_unavailable_max_age_seconds governs 'unavailable'
-- alone. 'empty' is a vendor SUCCESS about a permanently wordless video, so it earns the same window
-- as 'ok' — expiring it after a day would re-pay for the same nothing, which is the spend caching an
-- empty exists to stop. Only 'unavailable' is a claim that can stop being true.
--
-- Two arguments rather than one baked-in policy: the windows stay in the caller's named constants,
-- where the reason for each is documented next to it.
create or replace function public.get_transcript_cache(
  p_youtube_id text,
  p_max_age_seconds integer,
  p_unavailable_max_age_seconds integer
)
returns table (
  content text,
  outcome text,
  lang text,
  available_langs text[],
  resolved_via text,
  fetched_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  select c.content, c.outcome, c.lang, c.available_langs, c.resolved_via, c.fetched_at
  from public.transcript_cache c
  where c.youtube_id = p_youtube_id
    and c.fetched_at > now() - make_interval(
      secs => case when c.outcome = 'unavailable' then p_unavailable_max_age_seconds
                   else p_max_age_seconds end
    );
end;
$$;

revoke all on function public.get_transcript_cache(text, integer, integer) from public, anon, authenticated;
grant execute on function public.get_transcript_cache(text, integer, integer) to service_role;

-- ---------------------------------------------------------------------------------------------
-- 6. save_transcript_cache — upsert, overwriting EVERY field including fetched_at.
-- ---------------------------------------------------------------------------------------------
--
-- Unlike persist_summary's video upsert this deliberately does NOT coalesce: a refresh past the
-- window is exactly the case where the new value must win. A later successful fetch therefore
-- replaces a negative row outright, which is how a video that gains captions heals.
--
-- The returned boolean is a DUPLICATE-FETCH SIGNAL. Concurrent cold misses for the same video are
-- accepted, not prevented (the generation lease is per-user by construction and never sees two users
-- on one video), but they are measured rather than assumed rare: the function returns true when the
-- row it overwrote was written AFTER this request started fetching, which is only possible if
-- another request fetched the same video concurrently. N concurrent cold misses produce N-1 trues —
-- exactly the number of WASTED fetches, since the first writer's spend was the useful one.
--
-- The comparison is built from ONE clock plus a duration, never two clocks: now() and fetched_at are
-- both Postgres, and p_fetch_duration_ms is elapsed time measured in the Worker. Passing a Worker
-- TIMESTAMP instead would make the check hostage to skew between the Worker and the database.
create or replace function public.save_transcript_cache(
  p_youtube_id text,
  p_content text,
  p_outcome text,
  p_lang text,
  p_available_langs text[],
  p_requested_lang text,
  p_resolved_via text,
  p_fetch_duration_ms integer
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
  select c.fetched_at into previous_fetched_at
  from public.transcript_cache c
  where c.youtube_id = p_youtube_id;

  if previous_fetched_at is not null and p_fetch_duration_ms is not null then
    duplicate := now() - previous_fetched_at < make_interval(secs => p_fetch_duration_ms / 1000.0);
  end if;

  insert into public.transcript_cache (
    youtube_id, content, outcome, lang, available_langs, requested_lang, resolved_via, fetched_at
  )
  values (
    p_youtube_id, p_content, p_outcome, p_lang, p_available_langs, p_requested_lang, p_resolved_via, now()
  )
  on conflict (youtube_id) do update set
    content = excluded.content,
    outcome = excluded.outcome,
    lang = excluded.lang,
    available_langs = excluded.available_langs,
    requested_lang = excluded.requested_lang,
    resolved_via = excluded.resolved_via,
    fetched_at = excluded.fetched_at;

  return duplicate;
end;
$$;

revoke all on function public.save_transcript_cache(text, text, text, text, text[], text, text, integer)
  from public, anon, authenticated;
grant execute on function public.save_transcript_cache(text, text, text, text, text[], text, text, integer)
  to service_role;

-- ---------------------------------------------------------------------------------------------
-- 7. record_supadata_calls — insert a whole generation's ledger rows in one statement.
-- ---------------------------------------------------------------------------------------------
--
-- One round trip per request regardless of how many calls were made. Takes jsonb so the Worker can
-- hand over the meter's drained array unchanged.
create or replace function public.record_supadata_calls(p_calls jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  inserted integer;
begin
  if p_calls is null or jsonb_typeof(p_calls) <> 'array' or jsonb_array_length(p_calls) = 0 then
    return 0;
  end if;

  insert into public.supadata_calls (
    user_id, summary_id, youtube_id, operation, outcome, resolved_via, billable_credits
  )
  select
    nullif(call ->> 'user_id', '')::uuid,
    nullif(call ->> 'summary_id', '')::uuid,
    nullif(call ->> 'youtube_id', ''),
    call ->> 'operation',
    call ->> 'outcome',
    nullif(call ->> 'resolved_via', ''),
    nullif(call ->> 'billable_credits', '')::integer
  from jsonb_array_elements(p_calls) as call;

  get diagnostics inserted = row_count;
  return inserted;
end;
$$;

revoke all on function public.record_supadata_calls(jsonb) from public, anon, authenticated;
grant execute on function public.record_supadata_calls(jsonb) to service_role;

-- ---------------------------------------------------------------------------------------------
-- 8. persist_summary swap — 15 arguments to 23.
-- ---------------------------------------------------------------------------------------------
--
-- EVERYTHING about how the function DECIDES is preserved verbatim from 20260725120000: the
-- `for update` ledger lock, the replay guard, the status gate, the outcome tags, the settle, and the
-- coalescing `on conflict` for the videos metadata columns. Only the summaries insert column list
-- grows.
drop function if exists public.persist_summary(
  uuid, uuid, text, text, text, text, text, text, text, text, text, integer, timestamptz, text, text[]
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
  p_completion_tokens integer
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

  -- The only part of this function that changed in S-07: eight telemetry columns appended to the
  -- insert. Telemetry commits in the SAME transaction as the summary it describes — that atomicity is
  -- why generation_ms is frozen before this call rather than measured to the response.
  insert into public.summaries (
    user_id, video_id, character, content, model, resolved_via, reservation_id,
    transcript_chars, generation_ms, transcript_ms, llm_ms, metadata_ms,
    cost_usd, prompt_tokens, completion_tokens
  )
  values (
    target_user, v_id, p_character, p_content, p_model, p_resolved_via, reservation,
    p_transcript_chars, p_generation_ms, p_transcript_ms, p_llm_ms, p_metadata_ms,
    p_cost_usd, p_prompt_tokens, p_completion_tokens
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
  integer, integer, integer, integer, integer, numeric, integer, integer
) from public, anon, authenticated;
grant execute on function public.persist_summary(
  uuid, uuid, text, text, text, text, text, text, text, text, text, integer, timestamptz, text, text[],
  integer, integer, integer, integer, integer, numeric, integer, integer
) to service_role;
