-- Migration: per-user in-flight generation lock (impl-review F4)
-- Created: 20260720133000
--
-- Why this exists: POST /api/summaries/generate gates on a plain balance read *before* fetching a
-- transcript, but the authoritative cost gate is the atomic spend_credits() debit that runs after.
-- N concurrent requests from one user therefore all pass the read gate and each pay for a Supadata
-- transcript fetch, while only the affordable ones survive the debit. The debit stays correct — the
-- waste is the paid external work done by the losers, and nothing bounded how many losers there
-- could be. This adds the missing bound: one in-flight generation per user.
--
-- Postgres, not in-process state: the Worker runs on Cloudflare, where concurrent requests may land
-- in different isolates, so a module-level Set would not see its own siblings.

-- 1. Lock table. One row = one generation in flight. Cascade-deleted with the account so a deleted
-- user cannot leave a tombstone lock behind.
create table if not exists public.generation_locks (
  user_id uuid primary key references auth.users (id) on delete cascade,
  acquired_at timestamptz not null default now()
);

-- RLS on with no policies at all: this table is service-role-only by construction. A client that
-- could insert or delete here could either block its own generations or defeat the limit outright.
alter table public.generation_locks enable row level security;

revoke all on table public.generation_locks from public, anon, authenticated;

-- 2. Acquire. Returns true when the caller now holds the lock, false when another generation is
-- already in flight. The stale sweep is what keeps a crashed or timed-out request from wedging a
-- user permanently: a Worker request cannot outlive its runtime limits, and the transcript poller
-- tops out around 4 minutes, so a lock older than the default 10 minutes is certainly abandoned.
--
-- Delete-then-insert is safe as one statement pair inside the function's implicit transaction: the
-- primary key is the serialization point, so two concurrent acquires cannot both insert.
create or replace function public.acquire_generation_lock(target_user uuid, stale_seconds integer default 600)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.generation_locks
  where user_id = target_user
    and acquired_at < now() - make_interval(secs => stale_seconds);

  insert into public.generation_locks (user_id)
  values (target_user)
  on conflict (user_id) do nothing;

  -- FOUND reflects the INSERT: false when ON CONFLICT DO NOTHING suppressed it, i.e. lock held.
  return found;
end;
$$;

-- 3. Release. Idempotent — releasing a lock that a stale sweep already removed is not an error.
create or replace function public.release_generation_lock(target_user uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.generation_locks where user_id = target_user;
end;
$$;

-- 4. Least privilege, matching grant_credits(): both functions take an explicit user_id and are
-- SECURITY DEFINER, so an authenticated caller reaching them could lock or unlock arbitrary users.
-- Only the service-role key (used server-side by the generate endpoint) may execute them.
revoke all on function public.acquire_generation_lock(uuid, integer) from public, anon, authenticated;
grant execute on function public.acquire_generation_lock(uuid, integer) to service_role;

revoke all on function public.release_generation_lock(uuid) from public, anon, authenticated;
grant execute on function public.release_generation_lock(uuid) to service_role;
