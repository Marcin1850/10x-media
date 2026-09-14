-- Migration: summaries.worth_watching — the user's watch/skip mark, and the one column a client may update
-- Created: 20260914120000
--
-- Why this exists: roadmap S-14 (Linear MAR-25). A user records on each saved summary whether the video
-- is worth watching: `null` unmarked (the starting state), `true` worth watching, `false` not worth
-- watching. It is the app's first user-initiated UPDATE on a persisted summary.
--
-- Why the grant is COLUMN-SCOPED and must stay that way: 20260731130000_summaries_single_writer.sql made
-- the SECURITY DEFINER `persist_summary` RPC the only writer of `summaries` — `content`, `reservation_id`,
-- `metadata_via` and the cost/telemetry columns are claims the paid path makes, and a client able to
-- rewrite them could forge provenance or detach a paid summary from its credit reservation. That
-- migration revoked UPDATE and dropped `summaries_update_authenticated`. The easy re-opening
-- (`grant update on public.summaries`) would undo all of it silently, with nothing in the UI to show it.
-- So `authenticated` receives UPDATE on `worth_watching` alone. The roster in
-- src/test/authorization-invariants.int.test.ts pins the exact (table, column) set, and
-- src/test/cross-account-policy.int.test.ts probes that `content` / `reservation_id` stay refused.
--
-- The policy's `with check` is owner-scoped as well as its `using`. Today the column grant alone stops
-- `user_id` from being rewritten, but a `with check (true)` would let a row be re-owned the moment a later
-- migration widens the grant.
--
-- Idempotent: `add column if not exists`, drop-then-create policy, and a grant is a no-op when held.
-- Additive and nullable: existing rows read as unmarked, no backfill. `persist_summary` only ever inserts,
-- so a regenerated summary starts `null` with no function change. `anon` is untouched.

alter table public.summaries add column if not exists worth_watching boolean;

grant update (worth_watching) on public.summaries to authenticated;

drop policy if exists "summaries_update_authenticated" on public.summaries;
create policy "summaries_update_authenticated"
  on public.summaries
  for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
