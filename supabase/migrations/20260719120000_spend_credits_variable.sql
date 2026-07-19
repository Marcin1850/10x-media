-- Migration: variable-cost credit spend + refund (expand-only)
-- Created: 20260719120000
--
-- Adds an atomic, owner-scoped, variable-amount spend so a generation can cost more than 1 credit,
-- plus a service-role-only refund that reverses a debit on a failed generation. This migration is
-- EXPAND-ONLY: it leaves the old spend_credit() in place so the currently-deployed Worker keeps
-- working until the new one (calling spend_credits) is live. The drop of spend_credit() is deferred
-- to a later contract migration (F3 / Migration Notes in the plan).

-- 1. Variable-amount spend: a conditional decrement of the caller's own row that can only ever lower
-- the balance, so it is safe to expose to authenticated. The row-level `UPDATE ... WHERE balance >=
-- amount` is the concurrency serialization point — parallel requests on a stale read cannot overspend
-- (losers get the -1 sentinel). Returns the new balance, or -1 when there was nothing to spend.
create or replace function public.spend_credits(amount integer default 1)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_balance integer;
begin
  if amount is null or amount < 1 then
    raise exception 'amount must be a positive integer, got: %', amount;
  end if;
  update public.user_credits
  set balance = balance - amount, updated_at = now()
  where user_id = auth.uid() and balance >= amount
  returning balance into new_balance;
  if new_balance is null then
    return -1;
  end if;
  return new_balance;
end;
$$;

revoke all on function public.spend_credits(integer) from public, anon;
grant execute on function public.spend_credits(integer) to authenticated;

-- 2. Refund restores a debit after a failed generation. It RAISES a balance, so it must never be
-- user-callable: service_role only, invoked via the admin client, with an explicit target user id.
create or replace function public.refund_credits(target_user uuid, amount integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if amount is null or amount < 1 then
    raise exception 'amount must be a positive integer, got: %', amount;
  end if;
  update public.user_credits
  set balance = balance + amount, updated_at = now()
  where user_id = target_user;
end;
$$;

revoke all on function public.refund_credits(uuid, integer) from public, anon, authenticated;
grant execute on function public.refund_credits(uuid, integer) to service_role;

-- NOTE (F3): do NOT drop spend_credit() here. This migration is expand-only so the old Worker keeps
-- working until the new one is deployed. The drop lands in a later contract migration once the new
-- Worker (calling spend_credits) is confirmed live.
