-- Migration: revoke `service_role`'s table privileges on the nine internal tables
-- Created: 20260906120000
--
-- CLOUD-ONLY CORRECTION. Locally this is a near-no-op; on the cloud project it removes full CRUD.
--
-- WHAT WENT WRONG. Every internal table's migration runs
-- `revoke all on table <t> from public, anon, authenticated` and stops there — `service_role` is
-- never named. That reads as sufficient against the LOCAL stack, where `alter default privileges
-- for role postgres in schema public` hands `service_role` only `Dxtm`
-- (TRUNCATE/REFERENCES/TRIGGER/MAINTAIN — no DML), so there is no DML to revoke. On the cloud
-- project the same default hands out `arwdDxtm`, so SELECT/INSERT/UPDATE/DELETE survived every one
-- of those revokes. The divergence is recorded in
-- `20260714140000_assert_least_privilege_functions.sql:8-16` for the `authenticated` half; the
-- `service_role` half was found on 2026-09-06 by a read-only cloud pass and is written up in
-- `context/changes/testing-phase-3-data-boundary/plan.md`, "Cloud verification pass".
--
-- SO: the intent stated in `src/test/db-owner.ts:6-11` and `context/foundation/test-plan.md` §6.2 —
-- "these tables deliberately grant `service_role` no direct table privileges; the app reaches them
-- exclusively through SECURITY DEFINER RPCs" — has only ever held locally. This statement makes it
-- true in production too, which is what makes invariant 8 of
-- `src/test/authorization-invariants.int.test.ts` mean the same thing in both environments.
--
-- DO NOT READ THIS AS A TIGHTENING THAT WAS ALWAYS IN FORCE. It is a correction of an omission, and
-- the omission is invisible locally. A future internal table must name `service_role` in its own
-- revoke list (`public, anon, authenticated, service_role`) or it re-opens the same gap.
--
-- BEHAVIOUR-NEUTRAL. No `.from(<internal table>)` exists anywhere in `src/` or `scripts/`
-- (research.md §6) — every path goes through a `SECURITY DEFINER` function, which executes as the
-- table owner (`postgres`), not as the caller, and `service_role` keeps EXECUTE on every one of
-- those RPCs. It needs nothing else on these tables. The integration harness reaches the same rows
-- through `getDbOwnerConnection()` (`src/test/db-owner.ts:22`), a table-owner connection this does
-- not touch.
--
-- NOT a breach of the PRD privacy guardrail either way: `service_role` carries `rolbypassrls` and is
-- a server-only secret no client reaches. The property restored is defence in depth.

revoke all on table
  public.generation_locks,
  public.credit_reservations,
  public.transcript_fetch_attempts,
  public.transcript_quotes,
  public.transcript_cache,
  public.supadata_calls,
  public.metadata_cache,
  public.supadata_budget,
  public.supadata_reservations
from service_role;
