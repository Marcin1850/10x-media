-- Migration: owner-scoped generation lock lease (impl-review re-review F2)
-- Created: 20260720170000
--
-- Why this exists: 20260720133000 identifies a lock row by `user_id` alone, which makes release
-- ownerless. That is safe only while no request ever outlives the stale window — and nothing
-- enforces that. summarize() sets no explicit timeout and transcript.ts documents that the Worker
-- has no wall-clock request limit, so this interleaving is reachable:
--
--   A acquires  →  A stalls > stale_seconds  →  B sweeps A's row and inserts its own
--   →  A finally-blocks and calls release(user_id)  →  B's row is deleted while B is still running
--   →  C acquires and now runs concurrently with B
--
-- The result is exactly the paid-work amplification the lock was added to bound. The fix is to give
-- each acquisition an opaque identity and require it on release, so a stale predecessor's release is
-- a no-op against its successor's lease.
--
-- EXPAND-ONLY, same reasoning as 20260719120000 and 20260720160000: acquire_generation_lock() and
-- release_generation_lock() are left in place so the currently-deployed Worker keeps working until
-- the one calling the lease functions is live. Both are dropped in the Phase 8 contract migration.

-- 1. Lease identity on the existing lock row. Defaulted, so the legacy acquire_generation_lock()
-- keeps inserting valid rows during the overlap window — it simply never reads the id back.
alter table public.generation_locks
  add column if not exists lock_id uuid not null default gen_random_uuid();

-- 2. Acquire. Returns the new lease id when the caller now holds the lock, NULL when a generation is
-- already in flight. The stale sweep is unchanged: a row older than stale_seconds is presumed
-- abandoned and taken over — but taking it over now mints a *new* lock_id, which is what makes the
-- displaced request's later release harmless.
--
-- `on conflict do nothing returning lock_id` yields no row when the insert was suppressed, so the
-- NULL return and "lock held" are the same event. The primary key remains the serialization point.
create or replace function public.acquire_generation_lease(target_user uuid, stale_seconds integer default 600)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  acquired uuid;
begin
  delete from public.generation_locks
  where user_id = target_user
    and acquired_at < now() - make_interval(secs => stale_seconds);

  insert into public.generation_locks (user_id)
  values (target_user)
  on conflict (user_id) do nothing
  returning lock_id into acquired;

  return acquired;
end;
$$;

-- 3. Release. Scoped to the lease it was handed: a request that was swept and replaced deletes
-- nothing, because the row it is trying to release no longer carries its lock_id. Still idempotent —
-- releasing an already-swept lease is not an error. Returns whether a row was actually removed so
-- the caller can log a lost lease (it means that generation ran past the stale window).
create or replace function public.release_generation_lease(target_user uuid, lease uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  affected integer;
begin
  delete from public.generation_locks
  where user_id = target_user and lock_id = lease;

  get diagnostics affected = row_count;
  return affected > 0;
end;
$$;

-- 4. Least privilege, matching the functions these replace: both take an explicit user_id and are
-- SECURITY DEFINER, so an authenticated caller reaching them could lock or unlock arbitrary users.
-- Service-role only, via the admin client the generate endpoint already requires in preflight.
revoke all on function public.acquire_generation_lease(uuid, integer) from public, anon, authenticated;
grant execute on function public.acquire_generation_lease(uuid, integer) to service_role;

revoke all on function public.release_generation_lease(uuid, uuid) from public, anon, authenticated;
grant execute on function public.release_generation_lease(uuid, uuid) to service_role;

-- NOTE: do NOT drop acquire_generation_lock()/release_generation_lock() here — expand-only, see the
-- header. They are dropped alongside the legacy credit functions in the Phase 8 contract migration.
