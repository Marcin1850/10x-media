-- Migration: explicit table privileges for the API roles.
--
-- Tables created by the `postgres` role via `supabase migration up` do not automatically receive
-- SELECT/INSERT/UPDATE/DELETE grants for the API roles on some Supabase setups (postgres' default
-- privileges only cover TRUNCATE/REFERENCES/TRIGGER), which makes RLS-scoped reads/writes fail with
-- "permission denied" over PostgREST. Grant them explicitly here so access is self-contained and
-- reproducible across environments. Row-level access is still governed entirely by the RLS policies
-- defined on each table; these grants only open the table to the role so RLS can then filter it.
-- GRANT is idempotent, so this is a no-op where the privileges already exist.

-- videos / summaries: authenticated performs full CRUD, gated per-row by their RLS policies.
grant select, insert, update, delete on public.videos to authenticated;
grant select, insert, update, delete on public.summaries to authenticated;

-- user_credits: authenticated may only READ its own balance. There is deliberately no write grant
-- (and no write RLS policy) — balance changes flow exclusively through the SECURITY DEFINER
-- functions (seed, spend_credit) and the offline service-role script. This keeps the balance
-- unforgeable at the privilege level as well as the policy level.
grant select on public.user_credits to authenticated;

-- service_role bypasses RLS and is used only offline (e.g. the grant-credits operator script);
-- give it full access to the app tables.
grant select, insert, update, delete on public.videos to service_role;
grant select, insert, update, delete on public.summaries to service_role;
grant select, insert, update, delete on public.user_credits to service_role;
