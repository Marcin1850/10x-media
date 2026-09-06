-- Migration: correct begin_generation's settled-with-no-summary comment (no behaviour change)
-- Created: 20260906170000
--
-- Why this exists: the comment inside begin_generation() claimed the settled-with-no-summary state is
-- one "which only an operator-side settle_reservation() produces". That was already wrong when
-- 20260731110000 shipped charge_failed_transcript(), which writes precisely that shape for a charged
-- refusal, and S-03 (delete a summary) adds a third producer that will be the commonest of all.
--
-- The claim is diagnostic guidance, and a wrong one costs real time: an operator debugging the 409
-- that this branch produces would go hunting for a manual settle that never happened, instead of
-- checking refusal_reason or a deleted summary. Comments inside the `as $$ ... $$` body are stored in
-- the catalog (pg_proc.prosrc), so correcting one requires CREATE OR REPLACE -- there is no cheaper
-- edit, and editing the original migration file would desync it from the deployed function.
--
-- ZERO BEHAVIOUR CHANGE. The body below is byte-identical to 20260723130000:78-205 except for that
-- one comment block: same signature, same returns table, same language/security/search_path, same
-- statements in the same order. Verify with a diff against that range before applying.
--
-- CREATE OR REPLACE preserves the function's owner and ACL, so the least-privilege grant from
-- 20260723130000:210-211 survives untouched. It is re-asserted at the bottom anyway, following the
-- revoke-then-grant discipline of 20260714101500 / 20260731130000:22-24: assert the intended end
-- state rather than assume the starting one. The authorization-invariants roster needs no edit --
-- no relation is added, and invariant 5 already covers this function's EXECUTE privileges.

create or replace function public.begin_generation(
  target_user uuid,
  request uuid,
  amount integer
)
returns table (
  outcome text,
  reservation_id uuid,
  new_balance integer,
  summary_id uuid,
  video_id uuid,
  content text,
  model text,
  cost integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing record;
  balance_after integer;
  inserted_id uuid;
begin
  if target_user is null then
    raise exception 'begin_generation requires a user';
  end if;

  if amount is not null and amount < 1 then
    raise exception 'amount must be a positive integer or null (probe), got: %', amount;
  end if;

  -- A probe with no key has nothing to answer and would silently return 'fresh' forever. That is a
  -- caller bug, not a valid state.
  if amount is null and request is null then
    raise exception 'begin_generation probe requires a request key';
  end if;

  -- Only a keyed call can be a repeat of anything. A null key skips straight to the debit, which is
  -- what keeps this function a drop-in for reserve_credits during the rollout window.
  if request is not null then
    -- Lock the prior attempt for this key, if any. `for update` is the serialization point against a
    -- concurrent duplicate: the loser blocks here and then reads the status the winner committed,
    -- instead of deciding "new operation" from a stale read and charging a second time.
    --
    -- Matches the partial unique index above, so at most one row can qualify: refunded attempts are
    -- excluded and have already released the key.
    select cr.id, cr.status, cr.amount into existing
    from public.credit_reservations cr
    where cr.user_id = target_user
      and cr.request_id = request
      and cr.status <> 'refunded'
    for update;

    if existing.id is not null then
      if existing.status = 'reserved' then
        outcome := 'in_progress';
        return next;
        return;
      end if;

      -- Settled. Normally that means persist_summary() closed it in the same transaction that wrote
      -- the summary, so the summary is there to replay.
      select s.id, s.video_id, s.content, s.model
      into summary_id, video_id, content, model
      from public.summaries s
      where s.reservation_id = existing.id and s.user_id = target_user;

      if summary_id is null then
        -- Settled with no summary: the debit is closed but nothing was delivered. THREE producers,
        -- not one -- the original text here named only the first, and was already incomplete before
        -- this migration was written:
        --   1. an operator-side settle_reservation(), closing a key by hand;
        --   2. charge_failed_transcript() (20260731110000), which charges a refusal and writes
        --      exactly this shape -- `credit_reservations.refusal_reason` is non-null ONLY on these,
        --      which is what lets the endpoint replay the caption-specific 422 copy instead of the
        --      409 below (see that migration's header, and lookupRefusalReplay in the endpoint);
        --   3. an owner deleting their own summary (S-03) -- the row goes, the settled reservation
        --      stays, because summaries.reservation_id cascades reservation -> summary and never the
        --      reverse (20260722120000:25-35). In production this is the COMMONEST cause by far.
        -- The classification is unchanged and correct for all three: there is nothing to replay, and
        -- re-running would hand out work against a charge this key can no longer account for.
        -- Diagnostic note, which is the whole point of correcting this: a 409 here is not evidence of
        -- an operator action. Check refusal_reason first, then whether the summary was deleted.
        outcome := 'unavailable';
        return next;
        return;
      end if;

      outcome := 'replay';
      reservation_id := existing.id;
      cost := existing.amount;
      -- The balance now, not at the time of the original attempt: the caller shows it as the live
      -- remaining balance, and credits may have been spent or granted since.
      select uc.balance into new_balance
      from public.user_credits uc
      where uc.user_id = target_user;
      return next;
      return;
    end if;
  end if;

  -- Nothing on this key. A probe stops here — the caller may go and do the expensive work.
  if amount is null then
    outcome := 'fresh';
    return next;
    return;
  end if;

  -- New operation. Same conditional-decrement serialization point as reserve_credits
  -- (`where balance >= amount`), so concurrent requests on a stale read still cannot overspend.
  update public.user_credits
  set balance = balance - amount, updated_at = now()
  where user_id = target_user and balance >= amount
  returning balance into balance_after;

  if balance_after is null then
    outcome := 'insufficient';
    -- The caller's ACTUAL balance, so a 2-credit spend at balance 1 reports 1 and not 0. Stays null
    -- when the user has no credits row at all, which the caller reads as zero.
    select uc.balance into new_balance
    from public.user_credits uc
    where uc.user_id = target_user;
    return next;
    return;
  end if;

  -- Claiming the key and opening the debit are the same statement, so there is no window in which a
  -- charge exists without the identity that would let a retry find it.
  insert into public.credit_reservations (user_id, amount, request_id)
  values (target_user, amount, request)
  returning id into inserted_id;

  outcome := 'reserved';
  reservation_id := inserted_id;
  new_balance := balance_after;
  cost := amount;
  return next;
end;
$$;

-- Least privilege, re-asserted rather than assumed (see the header). Identical to
-- 20260723130000:210-211; CREATE OR REPLACE would have preserved it regardless.
revoke all on function public.begin_generation(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.begin_generation(uuid, uuid, integer) to service_role;
