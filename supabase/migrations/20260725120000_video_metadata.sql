-- Migration: persist video metadata (S-08 Phase 1)
-- Created: 20260725120000
--
-- Adds the descriptive metadata a saved summary needs to be recognisable — channel, duration,
-- upload date — plus two diagnostic columns recording which language the transcript actually came
-- back in, and widens persist_summary() so the write path can reach all of them. `title` and
-- `thumbnail_url` already existed (20260613145120) but have been permanently null since F-01: the
-- RPC hardcoded `insert into public.videos (user_id, url, youtube_id)`, and since F23 no application
-- code touches `videos` directly, so the columns were unreachable without widening the function.
--
-- NOT expand/contract, deliberately. `create or replace function` with a different parameter list
-- produces a SECOND overload rather than a replacement — PostgREST would then have to disambiguate,
-- and grants are signature-scoped besides — so the eight-argument function is dropped and the
-- fifteen-argument one created in its place. That leaves a window in which the live Worker calls a
-- signature that no longer exists: `npx supabase db push` and `npx wrangler deploy` are ONE
-- operation, run back to back with no gap. The failure mode is survivable (persistSummaryAndSettle
-- throws, the caller refunds the reservation and returns 500, so no user is charged) but the
-- OpenRouter spend for any generation caught in the window is lost.
--
-- Rollback: re-apply 20260723120000_atomic_persist_summary.sql to restore the eight-argument
-- function, AND reverse the rename below — the restored body inserts into `videos` by the old
-- column name. The added columns can be left in place; nothing reads them until S-02.

-- 1. New columns. Additive and idempotent, matching the `model` / `resolved_via` precedent. RLS is
-- untouched: the existing per-user `videos` policies cover new columns, and `user_id`'s
-- `on delete cascade` already covers account erasure.
alter table public.videos add column if not exists channel_name text;
alter table public.videos add column if not exists duration_seconds integer;
alter table public.videos add column if not exists published_at timestamptz;
alter table public.videos add column if not exists transcript_lang text;
alter table public.videos add column if not exists transcript_available_langs text[];

-- 2. Rename `thumbnail_url` to say what it actually holds. A breaking schema change taken
-- deliberately while it is free: the column has been null in every row since F-01 created it, and
-- its only references are two type declarations (src/types.ts, src/lib/services/summaries.ts) —
-- nothing reads it, nothing renders it. This slice is the last moment the rename costs nothing.
--
-- Unlike the additions above this statement is NOT idempotent: `alter table ... rename column` has
-- no `if not exists` form and fails on a second application. Accepted — migrations are applied once.
alter table public.videos rename column thumbnail_url to thumbnail_url_reported;

comment on column public.videos.thumbnail_url_reported is
  'Thumbnail URL exactly as last reported by Supadata — a record of the vendor '
  'response, never curated or repaired. Derivable from youtube_id, but persisted '
  'because it arrives free in a metadata call already made and typically carries '
  'a higher resolution than a fixed guess. NOT guaranteed to resolve: the vendor '
  'returns maxresdefault.jpg, which is absent below 480p. Consumers fall back at '
  'render time to https://i.ytimg.com/vi/<youtube_id>/hqdefault.jpg and must not '
  'write that fallback back into this column.';

-- 3. Swap persist_summary for a signature that can write the metadata. Everything about how the
-- function DECIDES is preserved verbatim from 20260723120000 — the `for update` ledger lock, the
-- replay guard, the status gate, the outcome tags and the settle. Only what it WRITES changes.
drop function if exists public.persist_summary(uuid, uuid, text, text, text, text, text, text);

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
  p_transcript_available_langs text[]
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
  -- function runs under `set search_path = ''`.
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

  insert into public.summaries (user_id, video_id, character, content, model, resolved_via, reservation_id)
  values (target_user, v_id, p_character, p_content, p_model, p_resolved_via, reservation)
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

-- 4. Least privilege, re-granted against the NEW signature — the old signature's grants disappeared
-- with the dropped function. persist_summary takes an explicit user_id and is SECURITY DEFINER, so an
-- authenticated caller reaching it could write summaries against another user's reservation.
-- service_role only, via the admin client the generate endpoint already requires in preflight.
revoke all on function public.persist_summary(
  uuid, uuid, text, text, text, text, text, text, text, text, text, integer, timestamptz, text, text[]
) from public, anon, authenticated;
grant execute on function public.persist_summary(
  uuid, uuid, text, text, text, text, text, text, text, text, text, integer, timestamptz, text, text[]
) to service_role;
