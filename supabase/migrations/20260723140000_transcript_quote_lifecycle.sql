-- Migration: give cached transcript quotes a real lifecycle (impl-review re-review F24)
-- Created: 20260723140000
--
-- Why this exists: 20260722130000 gave transcript_quotes an `expires_at`, but nothing ever acted on it
-- globally. `expires_at` only filtered READS, and the single DELETE in get_transcript_quote() targeted
-- the exact (user, video, character) key being looked up again. A key never requested again — the
-- common case, since a user who sees the long-video 409 and walks away never retries it — kept its row
-- forever. Each such row holds up to HARD_MAX_TRANSCRIPT_CHARS (200,000) characters of third-party
-- transcript content, so retention was unbounded per account, and transcript_quotes_expires_idx had no
-- consumer at all. Account deletion cascaded the rows eventually; nothing else did.
--
-- The retention contract this establishes. A quote lives at most TRANSCRIPT_QUOTE_TTL_SECONDS
-- (10 minutes) past its last write, and is physically removed at the earliest of:
--
--   1. CONSUMED — the generation that used it was durably persisted, so the endpoint discards the key
--      (discard_transcript_quote). This is the normal path and fires seconds after the confirmation.
--   2. SUPERSEDED — any later save/get on the same key drops the expired row, as before.
--   3. PRUNED — any quote write or read also deletes up to `max_rows` globally-expired rows
--      (prune_transcript_quotes), driven off transcript_quotes_expires_idx.
--   4. CASCADED — the account is deleted.
--
-- Rule 3 is what bounds the table without an operational dependency: rows are ONLY created by
-- save_transcript_quote, and every such call drains up to 100 expired rows, so creation cannot outpace
-- removal. The residual is bounded by the last burst before traffic stops — those rows wait for the
-- next quote write, or for the account cascade. If that residual ever needs a hard ceiling,
-- prune_transcript_quotes is granted to service_role so pg_cron (or the operator) can call it directly;
-- no scheduling is required for the invariant above to hold.
--
-- Deliberately NOT consumed at read time. Deleting the quote inside get_transcript_quote() would mean a
-- confirmation retry that then fails downstream (a 502 from OpenRouter, say) re-fetches — and re-pays
-- Supadata for — the transcript that F17 cached precisely to avoid. Consumption belongs after the work
-- is known to have succeeded, which is why rule 1 lives at the endpoint's post-persist point.
--
-- EXPAND-ONLY: one new function plus in-place `create or replace` of two functions whose signatures,
-- return types, and result semantics are unchanged. The currently-deployed Worker calls both replaced
-- functions and keeps working — it simply doesn't call discard_transcript_quote yet, which only means
-- its rows leave via rules 2–4 instead of rule 1.

-- 1. Bounded global prune. LIMIT-ed and `skip locked` so it is a predictable, non-blocking amount of
-- work on a request path: a concurrent caller pruning the same rows is skipped rather than waited on,
-- and a large expired backlog is drained across calls instead of in one long transaction. Ordering by
-- expires_at drains oldest-first straight off transcript_quotes_expires_idx.
create or replace function public.prune_transcript_quotes(max_rows integer default 100)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  limit_rows integer := coalesce(max_rows, 100);
  pruned integer;
begin
  if limit_rows <= 0 then
    return 0;
  end if;

  with victims as (
    select q.user_id, q.youtube_id, q.character
    from public.transcript_quotes q
    where q.expires_at <= now()
    order by q.expires_at
    limit limit_rows
    for update skip locked
  )
  delete from public.transcript_quotes t
  using victims v
  where t.user_id = v.user_id and t.youtube_id = v.youtube_id and t.character = v.character;

  get diagnostics pruned = row_count;
  return pruned;
end;
$$;

revoke all on function public.prune_transcript_quotes(integer) from public, anon, authenticated;
grant execute on function public.prune_transcript_quotes(integer) to service_role;

-- 2. Discard one key unconditionally, expired or not. Called once the summary that used the quote is
-- durably persisted: the round-trip the cache exists to serve is over, so holding the transcript any
-- longer buys nothing. Silent on a missing row — a short video never had a quote, and a retry that
-- discards twice must not fail.
create or replace function public.discard_transcript_quote(
  target_user uuid,
  p_youtube_id text,
  p_character text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if target_user is null then
    raise exception 'discard_transcript_quote requires a user';
  end if;

  delete from public.transcript_quotes
  where user_id = target_user and youtube_id = p_youtube_id and character = p_character;
end;
$$;

revoke all on function public.discard_transcript_quote(uuid, text, text) from public, anon, authenticated;
grant execute on function public.discard_transcript_quote(uuid, text, text) to service_role;

-- 3. get_transcript_quote, unchanged in signature and result semantics — it still drops this key's
-- expired row and returns only a fresh one — plus the bounded global prune. Read paths are rare (one
-- per long-video confirmation), so this is a second, cheap draining opportunity rather than the main one.
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

  -- Bounded; ignores its own return value. A prune failure must never fail a cache lookup.
  perform public.prune_transcript_quotes(100);

  return query
  select q.transcript_content, q.resolved_via
  from public.transcript_quotes q
  where q.user_id = target_user and q.youtube_id = p_youtube_id and q.character = p_character
    and q.expires_at > now();
end;
$$;

revoke all on function public.get_transcript_quote(uuid, text, text) from public, anon, authenticated;
grant execute on function public.get_transcript_quote(uuid, text, text) to service_role;

-- 4. save_transcript_quote, unchanged in signature and upsert semantics, plus the same bounded prune.
-- This is the load-bearing one: it is the ONLY way a row is created, so pruning here is what makes the
-- table self-limiting — every insert pays off up to 100 expired rows.
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

  perform public.prune_transcript_quotes(100);
end;
$$;

revoke all on function public.save_transcript_quote(uuid, text, text, text, text, integer) from public, anon, authenticated;
grant execute on function public.save_transcript_quote(uuid, text, text, text, text, integer) to service_role;
