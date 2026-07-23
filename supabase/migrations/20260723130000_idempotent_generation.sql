-- Migration: idempotent generation via a client-supplied request key (impl-review re-review F22)
-- Created: 20260723130000
--
-- Why this exists: 20260723120000 made ONE attempt atomic — the charge and the summary now commit
-- together. It says nothing about TWO attempts. The request carried no operation identity, so every
-- accepted POST opened its own reservation, called the LLM, and appended its own summary. The failure
-- mode that leaves is the classic ambiguous retry:
--
--   1. The endpoint persists the summary and settles the reservation.
--   2. The 200 is lost in transit. The browser reports a network error and invites a retry.
--   3. The generation lease is released by the `finally`, so the retry is accepted.
--   4. Nothing in the request or the database says these two POSTs are the same user operation, so
--      the retry reserves again, pays OpenRouter again, and appends a second identical summary.
--
-- The user is charged twice for one intent, and the reservation ledger is right about both charges —
-- there is no bug to reconcile, because at the database's level of description two generations really
-- did happen. Idempotency has to be introduced ABOVE the ledger, as an operation identity the client
-- owns and repeats.
--
-- The key rides on `credit_reservations` rather than a new operations table, because the reservation
-- is already the durable record of one paid attempt and 20260722120000 already links it to the summary
-- it produced. That link is what makes replay possible without storing a second copy of the summary:
-- request_id -> reservation -> summary. Retention needs no new policy for the same reason — the key is
-- a column on a row that already exists for the life of the account.
--
-- EXPAND-ONLY, same reasoning as 20260719120000 / 20260720160000 / 20260720170000 / 20260723120000:
-- the column is nullable, the unique index is partial on `request_id is not null`, and reserve_credits()
-- is left untouched. The currently-deployed Worker keeps reserving without a key and is unaffected;
-- begin_generation() with a null `request` behaves exactly like reserve_credits(). Both write shapes
-- stay valid throughout rollout. The legacy functions are dropped together in the Phase 8 contract
-- migration.

-- 1. The operation identity. Nullable (expand-only): rows written by the pre-F22 Worker, and any call
-- that passes no key, simply carry null and are excluded from the uniqueness rule below.
alter table public.credit_reservations
  add column request_id uuid;

-- 2. What makes a repeat POST detectable. Partial in TWO ways, and both are load-bearing:
--
--   `request_id is not null` — keeps pre-F22 and keyless rows out of the constraint entirely, which is
--   what makes this migration safe to apply ahead of the Worker that writes keys.
--
--   `status <> 'refunded'` — a refund is the ledger's statement that this attempt did not happen and
--   the user was not charged. Releasing the key on refund is therefore not a loophole but the point:
--   a retry after genuinely failed work must be allowed to actually re-run, and it can only do that if
--   the key it repeats is free again. `reserved` and `settled` rows keep the key, so an in-flight or a
--   delivered attempt is the thing a repeat POST collides with.
create unique index if not exists credit_reservations_request_key
  on public.credit_reservations (user_id, request_id)
  where request_id is not null and status <> 'refunded';

-- 3. The idempotent debit. This supersedes reserve_credits() on the generate path in the same way
-- persist_summary() superseded the insert/settle pair: the decision "is this a new operation or a
-- repeat of one I already did?" and the debit that follows from it must be ONE transaction, or two
-- concurrent duplicates both read "new" and both charge.
--
-- SECURITY DEFINER on an explicit target_user (not auth.uid()), because it must read another attempt's
-- summary to replay it — so service_role only, like settle/refund/reconcile/persist_summary. The
-- generate endpoint already requires the admin client in preflight.
--
-- A NULL `amount` means PROBE: answer the identity question without debiting. The endpoint needs this
-- because it cannot know the real cost until it has the transcript, and paying Supadata for a
-- transcript it is about to throw away is exactly the duplicate provider spend F22 is about. The probe
-- runs before the fetch and the real debit runs after it, both through this one function so there is
-- only ever one definition of what a repeat request is.
--
-- Returns an outcome tag rather than raising, so the endpoint can branch without parsing errors:
--
--   'reserved'    — new operation: balance debited, reservation opened, key claimed (the normal path)
--   'fresh'       — probe only: no prior attempt on this key, so the caller may proceed to the fetch
--   'replay'      — this key already produced a summary: nothing written, nothing charged, the original
--                   result is returned so an ambiguous retry ends where the first attempt did
--   'in_progress' — this key's reservation is still open: another attempt is running right now. Backstops
--                   the per-user generation lease across Worker isolates and lease-sweep windows
--   'unavailable' — this key's reservation was resolved WITHOUT producing a summary (an operator settle,
--                   say). The key cannot be replayed and must not be re-run against a closed debit
--   'insufficient'— not enough credits; new_balance carries the caller's actual (unchanged) balance
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
        -- Settled with no summary: the debit is closed but nothing was delivered, which only an
        -- operator-side settle_reservation() produces. There is nothing to replay and re-running would
        -- hand out work against a charge this key can no longer account for. Say so instead.
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

-- 4. Least privilege. begin_generation takes an explicit user_id, is SECURITY DEFINER, and returns
-- another row's summary content on replay — an authenticated caller reaching it could debit and read
-- against any account. service_role only, matching persist_summary / settle / refund / reconcile.
revoke all on function public.begin_generation(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.begin_generation(uuid, uuid, integer) to service_role;

-- NOTE: reserve_credits() is deliberately left in place and unaltered — expand-only, see the header.
-- It is dropped alongside spend_credit/spend_credits/refund_credits in the Phase 8 contract migration,
-- once the Worker calling begin_generation is confirmed live on cloud.
