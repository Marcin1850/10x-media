-- Migration: get_refusal_replay also returns the caller's current balance
-- Created: 20260908120000
--
-- Why this exists: the refusal REPLAY was the one balance-bearing exit that answered without a
-- balance. 20260731110000:221-236 returns the refusal reason alone, and the endpoint's replay branch
-- documented the omission as harmless -- "a replay moves no credit, so whatever the client learned
-- from the original refusal is still true". That assumption is exactly what the idempotency retry
-- exists to break: the retry's whole purpose is a first attempt whose RESPONSE was lost, so the
-- client that reaches this branch is precisely the client that never learned the balance. It then
-- confirms `charged: true` while the header keeps showing the pre-charge number, and a user at a true
-- zero can still be shown one credit -- and the form's own credit gate reads that number.
--
-- The successful replay has always carried `creditsRemaining` (begin_generation's `replay` outcome
-- returns new_balance); this makes the refusal replay symmetric with it.
--
-- The return type changes from `text` to `table(refusal_reason text, balance integer)`, which
-- CREATE OR REPLACE cannot do -- hence the explicit DROP. Dropping discards the function's ACL, so
-- the least-privilege grant from 20260731110000:249-250 is re-asserted below; without it the
-- recreated function would be EXECUTE-able by PUBLIC in both environments. The identity arguments are
-- unchanged, so the authorization-invariants roster needs no edit.
--
-- The balance is read in the SAME statement as the reason rather than by a second query from the
-- endpoint: the two facts are read at one database boundary through one already-trusted SECURITY
-- DEFINER call, so there is no window in which the endpoint holds a reason from one instant and a
-- balance from another, and no split failure policy to decide.

drop function if exists public.get_refusal_replay(uuid, uuid);

-- ---------------------------------------------------------------------------------------------
-- The replay lookup (body unchanged from 20260731110000:221-236 apart from the balance column).
-- ---------------------------------------------------------------------------------------------
--
-- Idempotency for this fee is not satisfied by "the balance does not move a second time" -- the REPLY
-- must also be the same reply. The order in the endpoint is what makes this necessary: the
-- idempotency probe runs `begin_generation(... amount => null)` BEFORE any transcript work and
-- therefore before every 422 exit this phase charges at. Our charge writes a settled reservation with
-- no summary, which begin_generation classifies as 'unavailable', which the endpoint answers with a
-- 409 "This request was already processed. Start a new generation." So without this lookup the second
-- attempt of a caption-less submit silently loses the caption-specific copy -- and a balance-only test
-- would pass while it happened.
--
-- NO ROW covers BOTH "no row on this key" and "a row that is not a refusal charge", and the second
-- case is load-bearing rather than a fallback: an operator-side settle_reservation() writes a settled,
-- summary-less row with no reason, and that row must keep the 409 its comment was written for.
-- Collapsing the two would either hide an operator action behind a transcript message, or start
-- telling users to start over after a refusal that will refuse identically. A row with a null
-- `refusal_reason` therefore still reaches the caller and is rejected there, the same as before.
--
-- `balance` is a left-joined scalar: a user with no `user_credits` row yields null, which the caller
-- reads as zero, matching charge_failed_transcript's and begin_generation's `insufficient` branches.
create or replace function public.get_refusal_replay(
  p_user_id uuid,
  p_request_id uuid
)
returns table (refusal_reason text, balance integer)
language sql
stable
security definer
set search_path = ''
as $$
  select cr.refusal_reason,
         (select uc.balance from public.user_credits uc where uc.user_id = p_user_id) as balance
  from public.credit_reservations cr
  where cr.user_id = p_user_id
    and cr.request_id = p_request_id
    and cr.status <> 'refunded'
  limit 1;
$$;

-- Least privilege, re-asserted after the drop: get_refusal_replay is SECURITY DEFINER and reads
-- another user's ledger row and balance from an explicit user id. service_role only, matching
-- begin_generation / charge_failed_transcript / settle / refund / reconcile / persist_summary.
revoke all on function public.get_refusal_replay(uuid, uuid) from public, anon, authenticated;
grant execute on function public.get_refusal_replay(uuid, uuid) to service_role;
