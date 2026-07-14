-- Migration: atomic operator refill for summary credits
-- Created: 20260714094500
--
-- The operator script previously read the balance, added in JavaScript, and wrote back an absolute
-- value. A concurrent spend_credit() or second grant landing between the read and the write was
-- silently overwritten, so the applied delta could differ from the requested grant. This moves the
-- increment into the database so it is a single atomic statement.

-- Increment a specific user's balance and return the new value. Mirrors spend_credit()'s shape
-- (SECURITY DEFINER, empty search_path, returns the resulting balance) but takes an explicit
-- user_id: this runs offline from the operator script, where there is no auth.uid().
create or replace function public.grant_credits(target_user_id uuid, amount integer)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_balance integer;
begin
  if amount is null or amount <= 0 then
    raise exception 'amount must be a positive integer, got: %', amount;
  end if;

  update public.user_credits
  set balance = balance + amount, updated_at = now()
  where user_id = target_user_id
  returning balance into new_balance;

  if new_balance is null then
    raise exception 'no user_credits row for user_id: %', target_user_id;
  end if;

  return new_balance;
end;
$$;

-- Increment authority stays offline: only the service-role key (never wired into the Worker) may
-- execute this. authenticated deliberately gets nothing — that is what keeps the balance unforgeable.
revoke all on function public.grant_credits(uuid, integer) from public;
revoke all on function public.grant_credits(uuid, integer) from anon;
revoke all on function public.grant_credits(uuid, integer) from authenticated;
grant execute on function public.grant_credits(uuid, integer) to service_role;
