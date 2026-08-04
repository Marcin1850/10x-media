-- Migration: make `summaries` single-writer at the privilege and policy layers.
--
-- Why this exists: 20260731120000_metadata_cache.sql added `summaries.metadata_via`, a server-owned
-- provenance marker recording HOW a generation obtained its metadata ('fetched' = a vendor request
-- was attempted, 'stored' = served from metadata_cache with no paid call, 'skipped_budget' = the
-- budget breaker refused the call). D10 cost-per-generation reporting reads that column as fact.
-- The claim is only as strong as the set of writers: `authenticated` still held INSERT/UPDATE on the
-- table plus matching per-row RLS policies from 20260613145120, so a client talking straight to
-- PostgREST could stamp 'stored' on a generation that really made a paid call, or null the column
-- out entirely — and the same hole covers the telemetry columns 20260728120000 added. Cross-user
-- isolation was never at risk (the policies are owner-scoped); provenance was.
--
-- No application code touches `summaries` directly: every row is inserted by the SECURITY DEFINER
-- `persist_summary` RPC, which runs as the function owner and is unaffected by the privileges below.
-- Removing the client write path therefore closes the forgery surface without removing a path
-- anything uses.
--
-- authenticated keeps SELECT (read your own summaries) and DELETE (remove your own). Reads and
-- deletes cannot forge a provenance or cost claim, and the owner-scoped policies for both remain in
-- force.
--
-- This is the same treatment 20260726120000 gave `videos`, for the same reason and in the same
-- order. Pattern follows 20260714101500: revoke-then-grant asserts the intended end state rather
-- than assuming the starting one.

-- 1. Drop to a known-empty baseline for the client-facing roles.
revoke all on public.summaries from anon, authenticated;

-- 2. Re-grant exactly the intended privileges. Row-level access is still governed by the remaining
-- RLS policies; these grants only open the table so RLS can then filter it.
grant select, delete on public.summaries to authenticated;

-- anon intentionally receives nothing, as before.
-- service_role is deliberately left as-is: it bypasses RLS by design.

-- 3. Remove the write policies themselves, so the intent is legible in the policy list and a future
-- re-grant cannot silently reopen the path.
drop policy if exists "summaries_insert_authenticated" on public.summaries;
drop policy if exists "summaries_update_authenticated" on public.summaries;
