-- Migration: Supadata budget reading + the reservation ledger behind lever C (S-09 Phase 5)
-- Created: 20260731150000
--
-- NOTE ON THE FILENAME: the plan names this `20260731130000_supadata_budget.sql`. That timestamp was
-- taken by 20260731130000_summaries_single_writer.sql, a Phase 4 follow-up that landed first, and
-- 140000 by 20260731140000_metadata_via_fetch_failed.sql. Migration order is filename order, so this
-- one takes the next free slot. Nothing else about the phase changes.
--
-- WHAT THIS IS FOR. Lever A bounds what ONE generation can cost; it does nothing about the fleet
-- exhausting a Free (100/mo) plan. Lever C refuses to START paid work when the month is nearly gone.
-- The decision needs an answer to "how much is left?", and neither available source can give it alone
-- (D5): `GET /v1/me` is authoritative but is an HTTP call that would land directly in front of the
-- transcript fetch and break the 1 req/s spacing generate.ts:552-556 maintains, while a purely local
-- tally does not know when the vendor's billing period resets and drifts out of phase. So the reading
-- ANCHORS and the reservations TRACK SPEND SINCE THE ANCHOR.
--
-- WHY NOT JUST SUM `supadata_calls`. This is the single most important structural decision in the
-- phase, and the natural design is the wrong one. Ledger rows are held in an in-memory meter and
-- flushed once in POST.finally (generate.ts:100-125), so during the entire paid window of a request
-- its own spend is invisible to every other request — a breaker reading the ledger reads a figure
-- stale by exactly the duration of the work it is trying to bound. `created_at` compounds it: it is
-- the batch's INSERTION time, not the HTTP call's, so it cannot be compared against a /v1/me snapshot
-- boundary without racing it. And `outcome = 'error'` with a null header means UNKNOWN, not zero, so
-- a ledger-derived total silently reads a possible charge as free. Live accounting therefore moves to
-- reservations, written synchronously at call time; `supadata_calls` keeps its original job of
-- telemetry and after-the-fact reconciliation (see part 6).
--
-- Five parts, ALL ADDITIVE — no function is dropped, so this migration opens NO deploy window of its
-- own. Nothing calls any of it when the phase ends; S-09 Phase 6 is the wiring.
--
--   1. public.supadata_budget          — the last /v1/me reading, one row, the fleet's lock point
--   2. public.supadata_reservations    — one row per in-flight or recently settled paid call
--   3. reserve_supadata_credits        — the breaker: sweep, lock, decide, reserve. Atomic.
--   4. settle_supadata_reservation     — record what the call actually billed
--   5. save_supadata_budget            — store a fresh reading and prune what it supersedes
--   6. (comment only) the per-outcome reconciliation query Phase 7 runs against supadata_calls
--
-- Rollback is code-only: leaving both tables in place costs nothing once nothing reads them.

-- ---------------------------------------------------------------------------------------------
-- 1. supadata_budget — the stored /v1/me reading, and the fleet's serialization point.
-- ---------------------------------------------------------------------------------------------
--
-- ONE ROW BY CONSTRUCTION. `singleton boolean primary key default true check (singleton)` makes a
-- second row impossible rather than merely discouraged: any insert defaults to true and collides with
-- the primary key. That is not tidiness. Every reserve takes `select ... where singleton for update`
-- on this row, which is what turns concurrent read/evaluate/spend into a QUEUE — the property the
-- whole lever rests on. A table that could hold two rows would be two independent queues.
create table if not exists public.supadata_budget (
  singleton boolean primary key default true check (singleton),
  max_credits integer,
  used_credits integer,
  read_at timestamptz,
  refresh_claimed_at timestamptz
);

comment on table public.supadata_budget is
  'The last GET /v1/me reading, stored so the breaker can decide without an in-line HTTP call '
  '(S-09 D5, lever C). Exactly one row, enforced by the `singleton` primary key. That row is also '
  'the fleet''s SERIALIZATION POINT: reserve_supadata_credits() locks it `for update` before reading '
  'or writing anything, so concurrent reserves queue instead of racing. Definer-only — reachable '
  'through the RPCs in this migration and nowhere else.';
comment on column public.supadata_budget.max_credits is
  'The plan''s monthly credit allowance as the vendor last reported it. Null only while '
  'uninitialized — see read_at.';
comment on column public.supadata_budget.used_credits is
  'Credits the vendor had recorded as spent AT read_at. Spend since then is tracked locally in '
  'supadata_reservations; the two are added, never compared.';
comment on column public.supadata_budget.read_at is
  'When the reading it accompanies was TAKEN (the caller''s clock immediately before issuing '
  'GET /v1/me), not when it was stored. NULL IS THE UNINITIALIZED STATE and must be read as "no '
  'authoritative reading has ever been taken" — never as "a very old reading". The distinction '
  'decides the path: a stale reading still supports a decision, because the reservations written '
  'since it bound the drift, while an absent one supports none at all and the caller must fail open '
  'explicitly. The row is seeded with all three figures null at the bottom of this migration.';
comment on column public.supadata_budget.refresh_claimed_at is
  'Set by the one caller that reserve_supadata_credits() elected to refresh the reading, cleared by '
  'save_supadata_budget(). It is what keeps a stale reading from sending every concurrent request to '
  'GET /v1/me at once, and it is also why no `warned_at` column is needed: the threshold report fires '
  'from the refreshing caller, i.e. at most once per reading TTL. A claim whose refresh failed is '
  'left to EXPIRE rather than cleared, so a dead claimant cannot wedge the refresh permanently; the '
  'expiry window is derived inside reserve_supadata_credits().';

-- RLS on with no policies, plus an explicit revoke — definer-only by construction, matching
-- transcript_cache / metadata_cache / supadata_calls / generation_locks.
alter table public.supadata_budget enable row level security;
revoke all on table public.supadata_budget from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- 2. supadata_reservations — one row per in-flight or recently settled paid provider call.
-- ---------------------------------------------------------------------------------------------
--
-- `credits` is the MAXIMUM the call could bill, not the expectation: a transcript fetch reserves 1, a
-- metadata fetch reserves 2 because fetchVideoMetadata retries a retryable failure once and that
-- retry is separately billed (metadata.ts:169-178). The breaker cannot gate a retry that happens
-- inside the helper, but it can refuse to start the call unless both requests fit.
--
-- `actual_credits` null has TWO meanings and they are deliberately treated the same way: "not settled
-- yet", and "settled but the vendor reported no x-billable-requests header". Both count at the
-- reserved maximum in reserve_supadata_credits — see the coalesce there.
create table if not exists public.supadata_reservations (
  reservation_id uuid primary key default gen_random_uuid(),
  credits integer not null,
  actual_credits integer,
  settled boolean not null default false,
  settled_at timestamptz,
  created_at timestamptz not null default now()
);

comment on table public.supadata_reservations is
  'Spend held against the stored /v1/me reading since it was taken (S-09 lever C). One row per paid '
  'Supadata call, written synchronously BEFORE the call and settled after it — unlike supadata_calls, '
  'which is batched into POST.finally and therefore blind to a request''s own in-flight spend. Stays '
  'small by construction: save_supadata_budget() deletes every row the new reading already contains, '
  'so the table holds at most the in-flight calls plus one TTL''s worth of completed ones.';
comment on column public.supadata_reservations.credits is
  'The MAXIMUM this call could bill (transcript 1, metadata 2 — the second is the separately-billed '
  'retry inside fetchVideoMetadata). Reserving the maximum is what makes the 3-credit per-generation '
  'ceiling enforced rather than aspirational.';
comment on column public.supadata_reservations.actual_credits is
  'What the call really billed, from x-billable-requests. NULL means UNKNOWN — either not settled '
  'yet, or settled with no header reported (a 206 transcript-unavailable is billed 1 and reports '
  'none). Both are counted at `credits`, so an ambiguous failure is charged rather than forgiven.';
comment on column public.supadata_reservations.settled_at is
  'When the call finished. THIS, NOT created_at, IS THE PRUNING BOUNDARY. created_at cannot answer '
  '"is this call''s spend already inside the vendor''s snapshot?" — a reservation created long before '
  'a /v1/me read may still have been IN FLIGHT when that read was taken, in which case the snapshot '
  'provably cannot contain it. Only a call that finished at or before the reading is certainly '
  'represented in it. See save_supadata_budget().';

-- The sweep and the outstanding total scan on created_at; the prune scans settled_at.
create index if not exists supadata_reservations_created_at_idx
  on public.supadata_reservations (created_at);
create index if not exists supadata_reservations_settled_at_idx
  on public.supadata_reservations (settled_at);

alter table public.supadata_reservations enable row level security;
revoke all on table public.supadata_reservations from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- 3. reserve_supadata_credits — the breaker itself, and the only place the decision is made.
-- ---------------------------------------------------------------------------------------------
--
-- FOUR DISJOINT OUTCOMES, and the caller must handle all of them:
--
--   'reserved'         — reservation_id returned, the spend is authorized, caller MUST settle
--   'refused'          — the call would take the remaining balance below the stop reserve
--   'refresh_required' — NO reservation written. This caller (and only this caller) holds the refresh
--                        claim: it must fetch /v1/me, save it, and call this function AGAIN
--   'uninitialized'    — no reading has ever been taken and someone else is already fetching one.
--                        Nothing to decide against; the caller fails open, UNTRACKED
--
-- WHY REFRESH IS A STATE *BEFORE* THE RESERVATION, NOT A FLAG ON ONE. The obvious shape — reserve,
-- then tell the caller to refresh — silently disarms the breaker. The refresh ends in
-- save_supadata_budget(), which prunes the reservations the new reading already contains; the
-- claimant''s own reservation was necessarily created before that save and has NOT been spent yet, so
-- it cannot be in the snapshot. Any pruning rule expressed in created_at would therefore delete the
-- row protecting the call that is about to happen: the later settle finds nothing and concurrent
-- callers re-spend credit that was supposedly held. Splitting the states removes the problem at the
-- source — a caller that must refresh holds NO reservation while it does so, and reruns the whole
-- decision afterwards. The reservation is thus always strictly NEWER than the reading that authorized
-- it, which is exactly what save_supadata_budget's retention rule depends on.
--
-- EVERY OUTCOME ALSO RETURNS THE STATISTICS BEHIND IT, under the same lock that produced them:
-- max_credits, used_credits, the outstanding total just computed, and read_at. This is not telemetry
-- padding. Phase 6's threshold report promises a self-sufficient payload (used, max, delta, which
-- threshold fired, reading age) and the only alternative is a second read after the lock is released
-- — which races every other reserve and reports figures that never coexisted. That is worse than
-- useless in an incident. The numbers leave the lock with the decision they justify, or they are not
-- trustworthy at all.
create or replace function public.reserve_supadata_credits(
  p_credits integer,
  p_stop_reserve integer,
  p_reading_max_age_seconds integer,
  p_stale_seconds integer
)
returns table (
  outcome text,
  reservation_id uuid,
  max_credits integer,
  used_credits integer,
  outstanding integer,
  read_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- How long a refresh claim is honoured before another caller may take it over. NOT a parameter,
  -- because it is not a policy knob: it must outlive exactly one /v1/me round trip
  -- (BUDGET_READ_TIMEOUT_MS = 2 s) plus the 1.2 s rate-limit spacing plus a second reserve pass —
  -- about four seconds in the worst case — and it must be far SHORTER than the reading TTL, so that a
  -- refresh which failed is retried by the next request instead of leaving the fleet untracked for a
  -- full TTL. 30 s clears the former by ~7x and is a thirtieth of the latter.
  c_refresh_claim_ttl_seconds constant integer := 30;
  v_max integer;
  v_used integer;
  v_read_at timestamptz;
  v_claimed_at timestamptz;
  v_outstanding integer;
  v_remaining integer;
  v_new_id uuid;
begin
  if p_credits is null or p_credits < 1 then
    raise exception 'reserve_supadata_credits requires a positive credit count, got: %', p_credits;
  end if;

  -- 1. SWEEP. A Worker killed mid-call leaves an unsettled row behind, and without a sweep that row
  -- wedges the breaker permanently — its credits are held against the fleet forever. Same reasoning
  -- and same shape as acquire_generation_lease's stale sweep (20260720170000:42-44); the window is
  -- supplied by the caller so it stays one number in one place (RESERVATION_STALE_SECONDS).
  delete from public.supadata_reservations r
  where r.settled = false
    and r.created_at < now() - make_interval(secs => p_stale_seconds);

  -- 2. THE SERIALIZATION POINT. Everything below runs under this row lock, which is what makes
  -- "read the budget, evaluate it, spend against it" a single atomic step instead of three racing
  -- ones. The row is guaranteed to exist because this migration seeds it; its CONTENTS are assumed
  -- nothing about.
  select b.max_credits, b.used_credits, b.read_at, b.refresh_claimed_at
  into v_max, v_used, v_read_at, v_claimed_at
  from public.supadata_budget b
  where b.singleton
  for update;

  if not found then
    -- Unreachable while the seed below is intact, and handled anyway rather than proceeding to lock
    -- nothing: a serialization point that does not exist cannot be locked, and `for update` on an
    -- empty table returns no row while silently skipping the queue the lever rests on. Re-seed and
    -- fail open for this one request; the next one finds the row and queues normally.
    insert into public.supadata_budget (singleton) values (true) on conflict do nothing;

    outcome := 'uninitialized';
    reservation_id := null;
    max_credits := null;
    used_credits := null;
    outstanding := null;
    read_at := null;
    return next;
    return;
  end if;

  -- 3. IS THE READING USABLE AT ALL? Never taken, or older than the caller's TTL.
  if v_read_at is null or v_read_at < now() - make_interval(secs => p_reading_max_age_seconds) then
    if v_claimed_at is null
       or v_claimed_at < now() - make_interval(secs => c_refresh_claim_ttl_seconds) then
      -- We are the one caller elected to refresh. Stamp the claim under the same lock that granted
      -- it — that is what makes "exactly one refresher per TTL" true rather than likely — and return
      -- with NO reservation. See the header for why the reservation cannot be written here.
      update public.supadata_budget b
      set refresh_claimed_at = now()
      where b.singleton;

      outcome := 'refresh_required';
      reservation_id := null;
      max_credits := v_max;
      used_credits := v_used;
      outstanding := null;
      read_at := v_read_at;
      return next;
      return;
    end if;

    -- Someone else is already refreshing. With a stale reading we still fall through and decide
    -- against it: the reservations written since read_at bound how far it can have drifted. With NO
    -- reading there is nothing to decide against, and evaluating against nulls would produce a null
    -- remaining and an accidental fall-through — so say so explicitly and let the caller fail open.
    if v_read_at is null then
      outcome := 'uninitialized';
      reservation_id := null;
      max_credits := null;
      used_credits := null;
      outstanding := null;
      read_at := null;
      return next;
      return;
    end if;
  end if;

  -- 4. OUTSTANDING = spend held against this reading. Unsettled calls, plus calls that settled AFTER
  -- the reading was taken (the vendor's snapshot cannot contain work that had not finished when it
  -- was computed). The coalesce is the pessimism that makes this correct: an unsettled call and a
  -- settled-but-unknown one both count at their reserved MAXIMUM, so an ambiguous failure is charged
  -- rather than forgiven. Only a call that reported a real x-billable-requests figure is counted at
  -- what it actually cost.
  select coalesce(sum(coalesce(r.actual_credits, r.credits)), 0)
  into v_outstanding
  from public.supadata_reservations r
  where r.settled = false
     or r.settled_at > v_read_at;

  -- 5. DECIDE. Refusing when `remaining - p_credits < stop_reserve` is exactly the condition under
  -- which the generation this call belongs to could overdraw the plan; the reserve itself (3) is
  -- derived in the service, where the derivation lives with the constant.
  v_remaining := coalesce(v_max, 0) - coalesce(v_used, 0) - v_outstanding;

  if v_remaining - p_credits < p_stop_reserve then
    outcome := 'refused';
    reservation_id := null;
  else
    insert into public.supadata_reservations (credits)
    values (p_credits)
    returning supadata_reservations.reservation_id into v_new_id;

    outcome := 'reserved';
    reservation_id := v_new_id;
  end if;

  max_credits := v_max;
  used_credits := v_used;
  outstanding := v_outstanding;
  read_at := v_read_at;
  return next;
end;
$$;

revoke all on function public.reserve_supadata_credits(integer, integer, integer, integer)
  from public, anon, authenticated;
grant execute on function public.reserve_supadata_credits(integer, integer, integer, integer)
  to service_role;

-- ---------------------------------------------------------------------------------------------
-- 4. settle_supadata_reservation — record what the call actually billed.
-- ---------------------------------------------------------------------------------------------
--
-- IT NEVER DELETES THE ROW. Deleting it here would open a window between the settle and the
-- POST.finally ledger flush in which the spend is visible NOWHERE AT ALL — not in the reservations,
-- not yet in supadata_calls — and a concurrent reserve would hand out credit that is already gone.
-- Rows are cleared by the next /v1/me refresh, which supersedes them.
--
-- Pass null for p_actual_credits when the vendor reported no x-billable-requests header. That is
-- "unknown", not "free": the row keeps counting at its reserved maximum, which is the pessimism the
-- outstanding total depends on.
--
-- Returns whether a row was actually settled, so the service can report a LOST reservation — false
-- means the row was already swept (the call outlived RESERVATION_STALE_SECONDS) or never existed,
-- both of which are worth seeing rather than swallowing. `settled = false` in the predicate keeps a
-- repeated settle idempotent instead of moving settled_at forward and un-pruning the row.
create or replace function public.settle_supadata_reservation(
  p_reservation_id uuid,
  p_actual_credits integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  affected integer;
begin
  if p_reservation_id is null then
    raise exception 'settle_supadata_reservation requires a reservation id';
  end if;

  update public.supadata_reservations r
  set settled = true,
      settled_at = now(),
      actual_credits = p_actual_credits
  where r.reservation_id = p_reservation_id
    and r.settled = false;

  get diagnostics affected = row_count;
  return affected > 0;
end;
$$;

revoke all on function public.settle_supadata_reservation(uuid, integer) from public, anon, authenticated;
grant execute on function public.settle_supadata_reservation(uuid, integer) to service_role;

-- ---------------------------------------------------------------------------------------------
-- 5. save_supadata_budget — store a fresh reading and prune only what it supersedes.
-- ---------------------------------------------------------------------------------------------
--
-- p_read_taken_at IS THE CALLER'S PRE-CALL TIMESTAMP, NOT now(). The caller records the clock
-- immediately BEFORE issuing GET /v1/me and passes that value. Using now() inside this function would
-- place the boundary AFTER the HTTP round trip and sweep away calls that settled DURING it — calls
-- the snapshot provably cannot include, since the vendor computed it before they finished.
--
-- The retention rule is deliberately asymmetric, and the direction matters: retaining a reservation
-- the reading already covers costs a temporarily over-conservative breaker, while deleting one it
-- does NOT cover costs real overdraw and strands a pending settle. So only rows SETTLED AT OR BEFORE
-- the reading are deleted. Everything unsettled, and everything settled after it, is kept.
--
-- Bounding follows from this rather than from a separate pruning job: every settled reservation is
-- deleted by the first refresh that postdates its settlement.
create or replace function public.save_supadata_budget(
  p_max_credits integer,
  p_used_credits integer,
  p_read_taken_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_read_taken_at is null then
    raise exception 'save_supadata_budget requires the timestamp the reading was taken at';
  end if;

  -- The row always exists (seeded below), so this is an update rather than an upsert. Clearing the
  -- claim here is what releases the next refresh: a claim is held only across the round trip that
  -- ends in this call.
  update public.supadata_budget b
  set max_credits = p_max_credits,
      used_credits = p_used_credits,
      read_at = p_read_taken_at,
      refresh_claimed_at = null
  where b.singleton;

  delete from public.supadata_reservations r
  where r.settled = true
    and r.settled_at <= p_read_taken_at;
end;
$$;

revoke all on function public.save_supadata_budget(integer, integer, timestamptz)
  from public, anon, authenticated;
grant execute on function public.save_supadata_budget(integer, integer, timestamptz) to service_role;

-- ---------------------------------------------------------------------------------------------
-- 6. Seed the singleton row, uninitialized.
-- ---------------------------------------------------------------------------------------------
--
-- LAST STATEMENT ON PURPOSE, AND NOT TIDINESS. A serialization point that does not exist cannot be
-- locked: `select ... where singleton for update` on an empty table returns no row and silently skips
-- the queue every reserve depends on. Seeding makes the lock unconditional from the very first
-- request on a fresh deployment.
--
-- Seeded UNINITIALIZED — max_credits, used_credits and read_at all null. read_at is null therefore
-- means "no authoritative reading has ever been taken", which is a different state from "a very old
-- reading" and takes a different path in reserve_supadata_credits. `on conflict do nothing` keeps the
-- migration re-runnable without resetting a live reading.
insert into public.supadata_budget (singleton) values (true) on conflict do nothing;

-- ---------------------------------------------------------------------------------------------
-- 7. The reconciliation query (comment only — not an RPC, not called by the app).
-- ---------------------------------------------------------------------------------------------
--
-- Phase 7 reconciles the observed `usedCredits` delta against supadata_calls for the same window.
-- That total CANNOT be `sum(billable_credits)`: a `206 transcript-unavailable` is billed 1 credit and
-- reports no x-billable-requests header, while a FAILED metadata call is billed 0 and also reports
-- none — both land as null, so a flat sum under-counts exactly the outcome that costs money. The
-- per-outcome shape is load-bearing and must not be simplified back. Pinned here while the reasoning
-- is fresh, because it is expensive to debug during a live credit pass:
--
--   select sum(case
--     when outcome = 'unavailable' then 1                      -- billable, never reports a header
--     when outcome = 'error'       then coalesce(billable_credits, 0)
--     else                              coalesce(billable_credits, 0)
--   end) as credits_spent
--   from public.supadata_calls
--   where created_at >= :window_start and created_at < :window_end;
--
-- Since S-09 Phase 2 the `unavailable` branch can be corroborated rather than trusted: those rows now
-- carry http_status = 206. If the recorded status and our own `outcome` label ever disagree, the
-- formula is wrong and the delta will say so.
