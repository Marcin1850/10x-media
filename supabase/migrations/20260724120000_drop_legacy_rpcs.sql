-- Contract half of the expand/contract chains opened in S-01 (Phase 8).
-- Safe only after the phases 1-7 Worker is live on cloud (see plan §Migration Notes).
--
-- spend_credit -> spend_credits (20260719120000) -> reserve_credits (20260720160000)
--                                                -> begin_generation (20260723130000)
-- refund_credits (20260719120000)                 -> refund_reservation (20260720160000)
-- acquire/release_generation_lock (20260720133000) -> ..._generation_lease (20260720170000)
--
-- All six are SECURITY DEFINER and unreferenced by the shipped Worker; refund_credits in
-- particular credits an arbitrary user by amount with no reservation to validate against, and
-- release_generation_lock releases by user_id alone — the ownerless release F2 replaced.
-- settle_reservation() is intentionally NOT dropped: it has no wrapper since F23 but is kept
-- as an operator recovery tool, alongside reconcile_reservation().
drop function if exists public.spend_credit();
drop function if exists public.spend_credits(integer);
drop function if exists public.refund_credits(uuid, integer);
drop function if exists public.reserve_credits(integer);
drop function if exists public.acquire_generation_lock(uuid, integer);
drop function if exists public.release_generation_lock(uuid);
