-- Migration: direct table access for integration-test support (testing-phase-2-paid-path, Phase 5)
-- Created: 20260904130000
--
-- Why this exists: `transcript_cache`, `metadata_cache`, `credit_reservations`, and `supadata_calls`
-- each `revoke all ... from public, anon, authenticated` but never separately GRANT `service_role`
-- ordinary table privileges — by design, the app reaches all four exclusively through their
-- `SECURITY DEFINER` RPCs (`get_transcript_cache`, `save_transcript_cache`, `reconcile_reservation`,
-- `record_supadata_calls`, ...), which run as the table owner regardless of caller and so never needed
-- `service_role` to hold a grant of its own.
--
-- The Phase 5 real-database integration layer is the first caller that legitimately needs to reach
-- past those RPCs: it seeds/cleans up `transcript_cache` and `metadata_cache` rows for synthetic
-- video ids outside the app's own write path, looks up a synthetic account's active reservation to
-- force exit #34's branches, and deletes `supadata_calls` rows by youtube_id before deleting a
-- synthetic account (the ordering `lessons.md`/research.md §5 already documents, since that table's
-- `user_id` is `on delete set null` rather than cascading). `integration-setup.ts`'s stale-fixture-row
-- guard (Phase 2) already assumed this access and was a silent no-op only because `RESERVED_YOUTUBE_IDS`
-- was empty until Phase 5 populated it — this migration is what makes that guard's existing
-- `.from("transcript_cache").select(...)` / `.from("metadata_cache").select(...)` calls actually work,
-- with no change to that file.
--
-- Scoped to exactly what test support needs: SELECT (read verification / the stale-row guard) and
-- DELETE (cleanup) where used, nothing else. No application code path gains new privileges — every
-- existing RPC remains `SECURITY DEFINER` and unaffected by this grant.

grant select, delete on public.transcript_cache to service_role;
grant select, delete on public.metadata_cache to service_role;
grant select on public.credit_reservations to service_role;
grant delete on public.supadata_calls to service_role;
