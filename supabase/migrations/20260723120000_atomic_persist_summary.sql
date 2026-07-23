-- Migration: atomic persist + settle for a delivered summary (impl-review re-review F23)
-- Created: 20260723120000
--
-- Why this exists: 20260722120000 gave reconciliation durable evidence of delivery — a `reserved` row
-- with a linked summary was delivered work, one with none was failed work. That evidence is neither
-- atomic nor immutable, so reconcile_reservation() could still classify two cases wrongly:
--
--   1. STILL IN FLIGHT. The summary insert and the settle are separate calls made LATER than the
--      reserve, so for the whole duration of the LLM call the ledger looks exactly like failed work.
--      The one-hour sweep can refund a request that is still running — and the later insert still
--      succeeds, because the composite FK validates identity and ownership, not status. The user ends
--      up keeping a summary they were refunded for.
--   2. DELIVERED, THEN UNLINKED. `summaries_delete_authenticated` (20260613145120) lets an owner
--      delete their own summary. Delivered-but-unsettled work can therefore disappear before the
--      sweep runs and be misclassified as failed.
--
-- The fix is to stop resting the billing outcome on a later, mutable row and make the outcome atomic:
-- ONE transaction upserts the video, inserts the linked summary, and moves the reservation to
-- `settled`. SQL rollback then guarantees only two states can survive a failure — "nothing persisted,
-- still `reserved`" (genuinely unresolved, safe to refund) and "persisted and `settled`" (closed, and
-- invisible to the sweep, which only looks at `reserved` rows). Summary deletion can no longer rewrite
-- a billing outcome, because the outcome was decided in the same transaction that wrote the summary.
--
-- reconcile_reservation() is deliberately left UNCHANGED. With this function in the write path it only
-- ever sees genuinely unresolved rows; its summary-link check stays as the belt-and-braces classifier
-- for rows written by the pre-F23 Worker, which is exactly what the rollout window needs (see below).
--
-- EXPAND-ONLY, same reasoning as 20260719120000 / 20260720160000 / 20260720170000: nothing is dropped
-- and no existing function is altered. The currently-deployed Worker keeps persisting via the anon
-- client and settling separately until the one calling persist_summary() is live. Both write shapes
-- stay valid, and the existing reconciliation runbook resolves anything the old path leaves behind —
-- so existing `reserved` rows need no one-time classification pass, only the usual sweep.

-- 1. Persist + settle, atomically. SECURITY DEFINER because it both writes user-owned rows on the
-- caller's behalf (target_user is explicit, not auth.uid()) and closes a ledger row — the same shape
-- as settle_reservation/refund_reservation, and service_role only for the same reason.
--
-- Returns an outcome tag rather than raising, so the endpoint can distinguish "saved" from "the
-- reservation was already resolved under me" without parsing an error message:
--
--   'persisted'         — video + summary written, reservation settled (the normal path)
--   'already_persisted' — this reservation already produced a summary; ids replayed, nothing written
--   'not_reserved'      — the reservation is missing or no longer open; nothing written, caller fails
--                         closed (the user is not charged, because the row was already resolved)
create or replace function public.persist_summary(
  target_user uuid,
  reservation uuid,
  p_url text,
  p_youtube_id text,
  p_character text,
  p_content text,
  p_model text,
  p_resolved_via text
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
  insert into public.videos (user_id, url, youtube_id)
  values (target_user, p_url, p_youtube_id)
  on conflict (user_id, youtube_id) do update set url = excluded.url
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

-- 2. Least privilege. persist_summary takes an explicit user_id and is SECURITY DEFINER, so an
-- authenticated caller reaching it could write summaries against another user's reservation.
-- service_role only, via the admin client the generate endpoint already requires in preflight.
revoke all on function public.persist_summary(uuid, uuid, text, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.persist_summary(uuid, uuid, text, text, text, text, text, text)
  to service_role;
