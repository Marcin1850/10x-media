-- Migration: durable credit reservation ledger (impl-review re-review F1)
-- Created: 20260720160000
--
-- Why this exists: the generate endpoint debits BEFORE the paid LLM call, so the refund path is what
-- upholds "failed work never charges the user". Until now that path was refund_credits() — an
-- unconditional `balance + amount` with no record of WHICH debit it reversed. Two consequences:
--
--   1. Not durable. If the refund RPC itself failed (transient network/DB error), the only trace was
--      a CREDIT_LEAK log line. The user stayed charged and nothing in the database knew it.
--   2. Not idempotent. Retrying after an ambiguous response (request sent, reply lost) could credit
--      twice, because a bare increment cannot tell a retry from a second genuine refund.
--
-- This replaces the bare increment with a ledger. Every debit writes a `reserved` row; the row is
-- then moved to `settled` (generation succeeded) or `refunded` (generation failed). The status
-- transition — not a log line — is the record of who is owed what.
--
-- EXPAND-ONLY, same reasoning as 20260719120000: spend_credits() and refund_credits() are left in
-- place so the currently-deployed Worker keeps working until the one calling reserve_credits() is
-- live. All three legacy functions are dropped together in the Phase 8 contract migration.

-- 1. The ledger. One row = one debit and its outcome.
create table if not exists public.credit_reservations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  amount integer not null check (amount > 0),
  status text not null default 'reserved' check (status in ('reserved', 'settled', 'refunded')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

-- RLS on with no policies at all, matching generation_locks: this table is definer/service-role-only
-- by construction. A client that could write here could forge refunds against its own balance.
alter table public.credit_reservations enable row level security;

revoke all on table public.credit_reservations from public, anon, authenticated;

-- Reconciliation index over "debits that were never resolved":
--
--   select id, user_id, amount, created_at
--   from public.credit_reservations
--   where status = 'reserved' and created_at < now() - interval '1 hour'
--   order by created_at;
--
-- The partial index keeps that sweep cheap as settled rows accumulate.
--
-- NOTE (superseded by 20260722120000_link_summary_to_reservation): do NOT blindly refund these rows.
-- A `reserved` row can be delivered-but-unsettled work as well as a genuine unpaid debt. Resolve each
-- with `select public.reconcile_reservation(user_id, id);`, which settles rows that produced a linked
-- summary and refunds only rows with none. See that migration for the reasoning.
create index if not exists credit_reservations_unresolved_idx
  on public.credit_reservations (created_at)
  where status = 'reserved';

-- 2. Reserve = atomic debit + ledger insert, in one transaction. Same conditional-decrement
-- serialization point as spend_credits (`where balance >= amount`), so concurrent requests on a
-- stale read still cannot overspend. Returns the reservation id and the new balance, or
-- (null, -1) when there was nothing to spend. Owner-scoped via auth.uid(), so it can only ever
-- lower the caller's own balance — safe to expose to authenticated.
create or replace function public.reserve_credits(amount integer default 1)
returns table (reservation_id uuid, new_balance integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := auth.uid();
  balance_after integer;
  inserted_id uuid;
begin
  if amount is null or amount < 1 then
    raise exception 'amount must be a positive integer, got: %', amount;
  end if;

  -- SECURITY DEFINER runs as postgres, so a null caller would otherwise match no row and silently
  -- return the insufficient sentinel. Fail loudly instead: an unauthenticated reserve is a bug.
  if caller is null then
    raise exception 'reserve_credits requires an authenticated caller';
  end if;

  update public.user_credits
  set balance = balance - amount, updated_at = now()
  where user_id = caller and balance >= amount
  returning balance into balance_after;

  if balance_after is null then
    return query select null::uuid, -1;
    return;
  end if;

  insert into public.credit_reservations (user_id, amount)
  values (caller, amount)
  returning id into inserted_id;

  return query select inserted_id, balance_after;
end;
$$;

-- 3. Settle: the generation succeeded and the user keeps paying for it. Takes an explicit user_id
-- so a reservation can only be settled by its owner's id, never by id alone.
create or replace function public.settle_reservation(target_user uuid, reservation uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  affected integer;
begin
  update public.credit_reservations
  set status = 'settled', resolved_at = now()
  where id = reservation and user_id = target_user and status = 'reserved';

  get diagnostics affected = row_count;
  return affected > 0;
end;
$$;

-- 4. Refund: the generation failed, so release the debit. The status transition IS the idempotency
-- guard — only a row still in 'reserved' yields an amount, so a retry after an ambiguous response
-- finds nothing to reverse and returns false without touching the balance. Both statements run in
-- the function's implicit transaction, so the ledger and the balance cannot diverge.
create or replace function public.refund_reservation(target_user uuid, reservation uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  refunded_amount integer;
begin
  update public.credit_reservations
  set status = 'refunded', resolved_at = now()
  where id = reservation and user_id = target_user and status = 'reserved'
  returning amount into refunded_amount;

  if refunded_amount is null then
    return false;
  end if;

  update public.user_credits
  set balance = balance + refunded_amount, updated_at = now()
  where user_id = target_user;

  return true;
end;
$$;

-- 5. Least privilege, matching spend_credits/refund_credits. reserve_credits is owner-scoped and can
-- only lower a balance, so authenticated may call it. settle/refund take an explicit user_id and are
-- SECURITY DEFINER, so an authenticated caller reaching refund_reservation could self-credit —
-- service_role only, via the admin client the generate endpoint already requires in preflight.
revoke all on function public.reserve_credits(integer) from public, anon;
grant execute on function public.reserve_credits(integer) to authenticated;

revoke all on function public.settle_reservation(uuid, uuid) from public, anon, authenticated;
grant execute on function public.settle_reservation(uuid, uuid) to service_role;

revoke all on function public.refund_reservation(uuid, uuid) from public, anon, authenticated;
grant execute on function public.refund_reservation(uuid, uuid) to service_role;

-- NOTE: do NOT drop spend_credits()/refund_credits() here — expand-only, see the header. The drop of
-- all three legacy functions (spend_credit, spend_credits, refund_credits) lands together in the
-- Phase 8 contract migration, once the Worker calling reserve_credits is confirmed live on cloud.
