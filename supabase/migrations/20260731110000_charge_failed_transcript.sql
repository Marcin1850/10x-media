-- ---------------------------------------------------------------------------------------------
-- Charge one app credit for a refusal in the billable class.
-- ---------------------------------------------------------------------------------------------
--
-- S-09 D14. A caption-less submit costs the OPERATOR a Supadata credit (a `206
-- transcript-unavailable` is billed 1 and reports no `x-billable-requests` header) and the USER
-- nothing: every 422 exit in the generate endpoint returns ~200 lines upstream of `begin_generation`,
-- the only place a credit is currently taken. D4's 2 h negative-cache window deliberately multiplies
-- exactly that traffic, so the asymmetry gets worse rather than better. This migration is the
-- mechanism that closes it.
--
-- No new table: `credit_reservations` is already the durable record of one paid attempt, already
-- carries `request_id`, and already enforces one non-refunded row per `(user_id, request_id)`. A
-- charge with no summary is a legal row rather than an orphan — the FK points the other way, from
-- `summaries.reservation_id` (20260722120000).
--
-- The charge is INSERTED ALREADY SETTLED, never 'reserved'. A 'reserved' row is what the hourly
-- reconciliation sweep refunds, and there is no work between reserve and settle here to fail — so a
-- reserve/settle pair would be racing that sweep for no benefit whatsoever.
--
-- Purely additive: one nullable column and two new functions. `begin_generation` is deliberately NOT
-- touched — adding an outcome would change its return type, which `create or replace` cannot do, and
-- the drop/recreate that follows would hand this phase the deploy-ordering risk that currently
-- belongs to the `persist_summary` swap alone. One extra read on a rare path is the right trade.
--
-- Rollback has a user-visible consequence, unlike the other migrations in this slice: dropping the
-- call site stops future charges but does not return credits already taken. The rows are trivially
-- identifiable (`refusal_reason is not null`), which is a reason to keep them queryable rather than
-- to delete them.

-- ---------------------------------------------------------------------------------------------
-- 1. The classification column.
-- ---------------------------------------------------------------------------------------------
--
-- Null on every existing row and on every row a normal generation writes; non-null ONLY on a row
-- written by `charge_failed_transcript` below. That is what makes this column load-bearing rather
-- than decorative: it is the sole thing distinguishing "we refused this video and charged for it"
-- from "an operator closed this key with settle_reservation()". Both are settled rows with no
-- summary, and `begin_generation` classifies both as 'unavailable' — which the endpoint answers with
-- a 409 "start a new generation". Without this column a retried caption-less submit would silently
-- lose the caption-specific 422 copy D3 exists to deliver.
--
-- CHECKed (unlike `supadata_calls.resolved_via`) precisely because code branches on it: the endpoint
-- reconstructs the 422 body FROM the stored reason on a replay, so an unexpected value would have no
-- copy to map to.
alter table public.credit_reservations
  add column if not exists refusal_reason text
  check (refusal_reason is null or refusal_reason in ('unavailable', 'empty', 'whitespace'));

comment on column public.credit_reservations.refusal_reason is
  'Why this row is a REFUSAL charge rather than a generation debit (S-09 D14). NULL means "not a '
  'refusal" — every pre-migration row, and every row begin_generation() writes. Non-null only from '
  'charge_failed_transcript(): ''unavailable'' (the vendor says the video has no caption track, '
  'fresh or from a negative cache row), ''empty'' (a vendor SUCCESS on a wordless video, cached), '
  '''whitespace'' (a transcript that arrived holding no words). The transient failed/timeout outcome '
  'is deliberately absent: an ''error'' with a null billable header means the cost is UNKNOWN, and '
  'charging would resolve our own ambiguity against the user. Two consumers: get_refusal_replay() '
  'reconstructs the original 422 from it so a repeated request_id replays the refusal instead of '
  'collapsing to a 409, and it makes the charge a one-column filter rather than an anti-join against '
  'summaries when auditing how often the friction fires.';

-- ---------------------------------------------------------------------------------------------
-- 2. The charge itself.
-- ---------------------------------------------------------------------------------------------
--
-- Debit and ledger row in one transaction, keyed for idempotency by the caller's `request_id` — the
-- SAME key the generation debit uses, never a freshly generated one. A charge with its own key would
-- bypass both `respondToRepeatedRequest` and the partial unique index, so a client retrying an
-- ambiguous failure (the exact scenario `request_id` exists for) would be billed once per attempt.
-- The endpoint therefore SKIPS the charge entirely when the client sent no key, rather than making
-- the fee non-idempotent: failing toward not charging is the correct direction for a fee the user
-- cannot see.
--
-- Outcomes mirror begin_generation()'s vocabulary rather than inventing a second one for the same
-- ledger:
--
--   'charged'      — balance debited by p_amount, one settled row written; new_balance is the result
--   'replay'       — this key already carries a non-refunded row. NOTHING written, nothing charged
--   'insufficient' — the balance will not cover p_amount. NOTHING written, nothing charged
--
-- 'insufficient' is NOT an error. The 402 gate upstream blocks a zero balance before any paid call,
-- so reaching this function short of credit means the balance moved mid-request. The charge is simply
-- skipped and the user still gets their 422 — refusing to answer because we could not bill would be
-- strictly worse for someone we have already declined to serve.
create or replace function public.charge_failed_transcript(
  p_user_id uuid,
  p_request_id uuid,
  p_amount integer,
  p_refusal_reason text
)
returns table (outcome text, new_balance integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing_id uuid;
  balance_after integer;
begin
  if p_user_id is null then
    raise exception 'charge_failed_transcript requires a user';
  end if;

  -- Unkeyed is a CALLER bug here, not a supported mode. begin_generation() tolerates a null key
  -- because a bare debit is still correct without one; this fee is not — with no key there is
  -- nothing to make it idempotent, and a retried refusal would bill again. The endpoint decides not
  -- to charge; this function refuses to be the place that decision gets skipped by accident.
  if p_request_id is null then
    raise exception 'charge_failed_transcript requires a request key';
  end if;

  if p_amount is null or p_amount < 1 then
    raise exception 'amount must be a positive integer, got: %', p_amount;
  end if;

  -- A null reason would write a row indistinguishable from an operator-side settle, which is exactly
  -- the distinction the column exists to draw.
  if p_refusal_reason is null then
    raise exception 'charge_failed_transcript requires a refusal reason';
  end if;

  -- Matches the partial unique index `credit_reservations_request_key` (user_id, request_id) where
  -- request_id is not null and status <> 'refunded' — so at most one row can qualify, and 'replay' is
  -- reached through the EXISTING index rather than a second one. `for update` is the serialization
  -- point against a concurrent duplicate, same as begin_generation().
  select cr.id into existing_id
  from public.credit_reservations cr
  where cr.user_id = p_user_id
    and cr.request_id = p_request_id
    and cr.status <> 'refunded'
  for update;

  if existing_id is not null then
    outcome := 'replay';
    select uc.balance into new_balance
    from public.user_credits uc
    where uc.user_id = p_user_id;
    return next;
    return;
  end if;

  -- Same conditional-decrement serialization point as begin_generation (`where balance >= amount`),
  -- so concurrent requests reading one stale balance still cannot overdraw.
  update public.user_credits
  set balance = balance - p_amount, updated_at = now()
  where user_id = p_user_id and balance >= p_amount
  returning balance into balance_after;

  if balance_after is null then
    outcome := 'insufficient';
    -- The caller's ACTUAL, unchanged balance. Null when the user has no credits row at all, which
    -- the service reads as zero.
    select uc.balance into new_balance
    from public.user_credits uc
    where uc.user_id = p_user_id;
    return next;
    return;
  end if;

  -- Settled at birth, with resolved_at stamped. See the header: there is no work between reserve and
  -- settle, and a 'reserved' row is what the hourly sweep refunds.
  insert into public.credit_reservations (user_id, amount, request_id, status, resolved_at, refusal_reason)
  values (p_user_id, p_amount, p_request_id, 'settled', now(), p_refusal_reason);

  outcome := 'charged';
  new_balance := balance_after;
  return next;

-- Two callers can both find no row to lock above (there is nothing to lock until one of them inserts)
-- and then serialize on the user_credits row lock instead, so the loser reaches the insert and trips
-- the unique index. Catching it here is what turns that race into the honest answer — the block's
-- implicit savepoint rolls back this transaction's decrement along with the failed insert, so the
-- user is charged exactly once and the second caller reports 'replay' like any other repeat. Without
-- the handler the exception would propagate and the service would report "not charged" for a request
-- that genuinely was charged, by the other caller.
exception
  when unique_violation then
    outcome := 'replay';
    select uc.balance into new_balance
    from public.user_credits uc
    where uc.user_id = p_user_id;
    return next;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 3. The replay lookup.
-- ---------------------------------------------------------------------------------------------
--
-- Idempotency for this fee is not satisfied by "the balance does not move a second time" — the REPLY
-- must also be the same reply. The order in the endpoint is what makes this necessary: the
-- idempotency probe runs `begin_generation(… amount => null)` BEFORE any transcript work and
-- therefore before every 422 exit this phase charges at. Our charge writes a settled reservation with
-- no summary, which begin_generation classifies as 'unavailable', which the endpoint answers with a
-- 409 "This request was already processed. Start a new generation." So without this lookup the second
-- attempt of a caption-less submit silently loses the caption-specific copy — and a balance-only test
-- would pass while it happened.
--
-- Returning null covers BOTH "no row on this key" and "a row that is not a refusal charge", and the
-- second case is load-bearing rather than a fallback: an operator-side settle_reservation() writes a
-- settled, summary-less row with no reason, and that row must keep the 409 its comment was written
-- for. Collapsing the two would either hide an operator action behind a transcript message, or start
-- telling users to start over after a refusal that will refuse identically.
create or replace function public.get_refusal_replay(
  p_user_id uuid,
  p_request_id uuid
)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select cr.refusal_reason
  from public.credit_reservations cr
  where cr.user_id = p_user_id
    and cr.request_id = p_request_id
    and cr.status <> 'refunded'
  limit 1;
$$;

-- ---------------------------------------------------------------------------------------------
-- 4. Least privilege.
-- ---------------------------------------------------------------------------------------------
--
-- charge_failed_transcript takes an explicit user id and is SECURITY DEFINER, so an authenticated
-- caller reaching it could debit any account. get_refusal_replay reads another user's ledger row.
-- service_role only, matching begin_generation / settle / refund / reconcile / persist_summary.
revoke all on function public.charge_failed_transcript(uuid, uuid, integer, text) from public, anon, authenticated;
grant execute on function public.charge_failed_transcript(uuid, uuid, integer, text) to service_role;

revoke all on function public.get_refusal_replay(uuid, uuid) from public, anon, authenticated;
grant execute on function public.get_refusal_replay(uuid, uuid) to service_role;
