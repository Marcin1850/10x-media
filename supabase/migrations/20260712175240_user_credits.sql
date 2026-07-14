-- Migration: per-user summary credit balance (table, read-only RLS, seed trigger, atomic spend)
-- Created: 20260712175240

-- 1. Credits table: one mutable balance per user, cascade-deleted with the account.
create table if not exists public.user_credits (
  user_id uuid primary key references auth.users (id) on delete cascade,
  balance integer not null default 5 check (balance >= 0),
  updated_at timestamptz not null default now()
);

alter table public.user_credits enable row level security;

-- Owner-only read. No insert/update/delete policy: balance changes flow exclusively through the
-- SECURITY DEFINER functions (seed, spend) and the offline service-role script. This is what makes
-- the balance unforgeable by the authenticated client.
drop policy if exists "user_credits_select_authenticated" on public.user_credits;
create policy "user_credits_select_authenticated" on public.user_credits
  for select to authenticated using (auth.uid() = user_id);

-- 2. New-user seed: every new account starts at 5 credits, regardless of how it's created.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.user_credits (user_id)
  values (new.id)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Backfill accounts that already exist (the seed trigger only fires on future inserts).
insert into public.user_credits (user_id)
select id from auth.users
on conflict (user_id) do nothing;

-- 3. Atomic spend: the only client-reachable balance mutation. A conditional decrement of the
-- caller's own row that can only ever lower the balance, so it is safe to expose to authenticated.
-- Returns the new balance, or -1 when there was nothing to spend (missing row or already 0).
create or replace function public.spend_credit()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_balance integer;
begin
  update public.user_credits
  set balance = balance - 1, updated_at = now()
  where user_id = auth.uid() and balance > 0
  returning balance into new_balance;

  if new_balance is null then
    return -1;
  end if;

  return new_balance;
end;
$$;

revoke all on function public.spend_credit() from public;
grant execute on function public.spend_credit() to authenticated;
