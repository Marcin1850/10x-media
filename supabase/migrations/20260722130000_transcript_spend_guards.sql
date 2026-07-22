-- Migration: bound Supadata provider spend on the generate path (impl-review re-review F17)
-- Created: 20260722130000
--
-- Why this exists: the generate endpoint's pre-transcript gate is a minimum-1 balance READ, and a long
-- video returns its 409 confirmation BEFORE any debit. So a one-credit user could fetch transcript
-- after transcript — each a paid Supadata call — sequentially, on the same or different videos, without
-- ever reaching a charge. The generation lease bounds concurrency but not repeated sequential calls,
-- and the confirmation retry re-fetches the transcript by design. Provider spend was unbounded by the
-- credit budget. Two guards close that, both service-role-only (definer tables with no policies, like
-- generation_locks): a per-user rate limit on paid fetches, and a short-lived quote cache so the
-- long-video confirmation round-trip reuses the transcript it already paid for.
--
-- EXPAND-ONLY: both objects are additive; no existing table or function is touched. The currently
-- deployed Worker (which calls neither RPC) keeps working until the one that does is live.

-- 1. Rate-limit ledger: one row per paid transcript-fetch attempt.
create table if not exists public.transcript_fetch_attempts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

-- RLS on with no policies, matching generation_locks/credit_reservations: definer/service-role-only by
-- construction. A client that could write here could forge itself extra fetch headroom.
alter table public.transcript_fetch_attempts enable row level security;
revoke all on table public.transcript_fetch_attempts from public, anon, authenticated;

-- Supports both the per-user window prune and the per-user count in record_transcript_attempt.
create index if not exists transcript_fetch_attempts_user_time_idx
  on public.transcript_fetch_attempts (user_id, created_at);

-- 2. record_transcript_attempt: prune the caller's rows outside the window, count what's left, reject
-- at/over the cap, else insert one and allow — all in one transaction. The generation lease already
-- serializes fetches per user, so the count+insert cannot race itself; even if it could, an off-by-one
-- on a rate limit is harmless. Takes an explicit user_id and is service_role only.
create or replace function public.record_transcript_attempt(
  target_user uuid,
  window_seconds integer,
  max_attempts integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  cutoff timestamptz := now() - make_interval(secs => window_seconds);
  attempts integer;
begin
  if target_user is null then
    raise exception 'record_transcript_attempt requires a user';
  end if;

  delete from public.transcript_fetch_attempts
  where user_id = target_user and created_at < cutoff;

  select count(*) into attempts
  from public.transcript_fetch_attempts
  where user_id = target_user;

  if attempts >= max_attempts then
    return false;
  end if;

  insert into public.transcript_fetch_attempts (user_id) values (target_user);
  return true;
end;
$$;

revoke all on function public.record_transcript_attempt(uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.record_transcript_attempt(uuid, integer, integer) to service_role;

-- 3. Transcript quote cache: the long-video confirmation round-trip re-submits the SAME request with
-- allowLong=true; without this the endpoint would fetch — and pay Supadata for — the transcript a
-- second time. Cache the first fetch briefly, keyed to (user, video, character), so the confirmation
-- reuses it. One row per key; the confirmation overwrites or lets it expire.
create table if not exists public.transcript_quotes (
  user_id uuid not null references auth.users (id) on delete cascade,
  youtube_id text not null,
  character text not null check (character in ('informational', 'educational')),
  transcript_content text not null,
  resolved_via text check (resolved_via is null or resolved_via in ('inline', 'job')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  primary key (user_id, youtube_id, character)
);

alter table public.transcript_quotes enable row level security;
revoke all on table public.transcript_quotes from public, anon, authenticated;

-- Supports the opportunistic expired-row prune below.
create index if not exists transcript_quotes_expires_idx on public.transcript_quotes (expires_at);

-- 4. get_transcript_quote: returns the caller's fresh (unexpired) transcript for (video, character), or
-- no rows. Opportunistically drops this key's expired row so the cache doesn't linger. service_role only.
create or replace function public.get_transcript_quote(
  target_user uuid,
  p_youtube_id text,
  p_character text
)
returns table (transcript_content text, resolved_via text)
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.transcript_quotes
  where user_id = target_user and youtube_id = p_youtube_id and character = p_character
    and expires_at <= now();

  return query
  select q.transcript_content, q.resolved_via
  from public.transcript_quotes q
  where q.user_id = target_user and q.youtube_id = p_youtube_id and q.character = p_character
    and q.expires_at > now();
end;
$$;

revoke all on function public.get_transcript_quote(uuid, text, text) from public, anon, authenticated;
grant execute on function public.get_transcript_quote(uuid, text, text) to service_role;

-- 5. save_transcript_quote: upserts the cached transcript with a fresh TTL. service_role only.
create or replace function public.save_transcript_quote(
  target_user uuid,
  p_youtube_id text,
  p_character text,
  p_content text,
  p_resolved_via text,
  ttl_seconds integer
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.transcript_quotes (user_id, youtube_id, character, transcript_content, resolved_via, expires_at)
  values (
    target_user, p_youtube_id, p_character, p_content, p_resolved_via,
    now() + make_interval(secs => ttl_seconds)
  )
  on conflict (user_id, youtube_id, character)
  do update set
    transcript_content = excluded.transcript_content,
    resolved_via = excluded.resolved_via,
    created_at = now(),
    expires_at = excluded.expires_at;
end;
$$;

revoke all on function public.save_transcript_quote(uuid, text, text, text, text, integer) from public, anon, authenticated;
grant execute on function public.save_transcript_quote(uuid, text, text, text, text, integer) to service_role;
