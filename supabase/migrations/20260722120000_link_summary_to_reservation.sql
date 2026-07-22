-- Migration: link a persisted summary to the reservation that paid for it (impl-review re-review F16)
-- Created: 20260722120000
--
-- Why this exists: the generate endpoint persists the summary and only THEN settles its reservation,
-- best-effort. If that settle is lost (transport failure / lost reply), a delivered summary leaves its
-- reservation stuck in `reserved` — the SAME state left when failed work could not be refunded. The
-- 20260720160000 reconciliation runbook told the operator to refund every aged `reserved` row, so
-- following it would hand credits back for work the user actually received.
--
-- The ledger had no durable evidence of delivery. This adds it: the summary insert now records the
-- reservation that paid for it, inside the same code path that persists the summary and BEFORE the
-- best-effort settle. Reconciliation then distinguishes the two cases exactly — a `reserved` row with
-- a linked summary was delivered (settle it); a `reserved` row with none is failed work (refund it).
--
-- EXPAND-ONLY: `summaries.reservation_id` is nullable, so existing rows and the currently-deployed
-- Worker (which does not yet write it) keep working. No legacy function is dropped here.

-- 1. Composite-FK target. The link must be validated to the SAME user, mirroring the existing
-- `summaries (video_id, user_id) -> videos (id, user_id)` pattern. A composite FK needs a unique
-- constraint on exactly the referenced columns; `id` is already the PK, so `(id, user_id)` is
-- trivially unique and cheap to add.
alter table public.credit_reservations
  add constraint credit_reservations_id_user_key unique (id, user_id);

-- 2. The link column. Nullable (expand-only); unique so one reservation backs at most one summary; and
-- a composite FK so a summary can only ever cite a reservation owned by the same user. `on delete
-- cascade` matches the sibling video FK and only ever fires during account deletion, where the summary
-- is being removed anyway (reservations are never deleted on their own — only status-transitioned).
alter table public.summaries
  add column reservation_id uuid,
  add constraint summaries_reservation_id_key unique (reservation_id),
  add constraint summaries_reservation_id_fkey
    foreign key (reservation_id, user_id)
    references public.credit_reservations (id, user_id)
    on delete cascade;

-- 3. Reconciliation, encoded as one safe, idempotent call per aged `reserved` row. This SUPERSEDES the
-- refund-everything runbook in 20260720160000: the operator query is unchanged --
--
--   select id, user_id from public.credit_reservations
--   where status = 'reserved' and created_at < now() - interval '1 hour'
--   order by created_at;
--
-- -- but each row is now resolved with `select public.reconcile_reservation(user_id, id);`, which
-- settles rows that produced a linked summary (delivered work the user keeps paying for) and refunds
-- only rows with no summary (failed work). Re-running it is a no-op once the row leaves `reserved`.
create or replace function public.reconcile_reservation(target_user uuid, reservation uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  res_amount integer;
  has_summary boolean;
begin
  -- Lock the row and act only while it is still an open debit owned by target_user. `for update`
  -- serializes reconcile against a late in-endpoint settle/refund racing on the same reservation.
  select amount into res_amount
  from public.credit_reservations
  where id = reservation and user_id = target_user and status = 'reserved'
  for update;

  if res_amount is null then
    return 'noop';
  end if;

  select exists (
    select 1 from public.summaries
    where reservation_id = reservation and user_id = target_user
  ) into has_summary;

  if has_summary then
    -- Durable proof of delivery: the summary is persisted and linked. Close the debit, no refund.
    update public.credit_reservations
    set status = 'settled', resolved_at = now()
    where id = reservation;
    return 'settled';
  end if;

  -- No linked summary: the paid work never landed. Reverse the debit, same as refund_reservation.
  update public.credit_reservations
  set status = 'refunded', resolved_at = now()
  where id = reservation;

  update public.user_credits
  set balance = balance + res_amount, updated_at = now()
  where user_id = target_user;

  return 'refunded';
end;
$$;

-- 4. Least privilege. reconcile_reservation raises balances and takes an explicit user_id, so it is
-- service_role only, matching settle_reservation / refund_reservation.
revoke all on function public.reconcile_reservation(uuid, uuid) from public, anon, authenticated;
grant execute on function public.reconcile_reservation(uuid, uuid) to service_role;
