-- Migration: make the API-role table privileges deterministic (least privilege).
--
-- Why this exists: GRANT is additive, so 20260712182527_grant_table_privileges.sql could only ever
-- ADD privileges — it could not remove the ones the environment had already granted. In practice the
-- API roles retained TRUNCATE/REFERENCES/TRIGGER on all three app tables, so `authenticated` was not
-- actually read-only on user_credits at the privilege layer, despite the comment saying so.
--
-- TRUNCATE is the one that matters: it is a TABLE-level privilege that RLS does NOT filter, so it
-- ignores the owner-only policies entirely. It is not reachable today (PostgREST emits no TRUNCATE,
-- and no function in `public` builds dynamic SQL), which is why this is defense-in-depth rather than
-- a live hole: it caps the blast radius of any future SQL-injection surface at the injecting user's
-- own rows instead of every balance in the table.
--
-- REFERENCES/TRIGGER are revoked for the same determinism reason; both are already unusable because
-- neither role holds CREATE on schema public.
--
-- Pattern: revoke-then-grant asserts the intended end state rather than assuming the starting one.

-- 1. Drop to a known-empty baseline for the two client-facing roles.
revoke all on public.videos from anon, authenticated;
revoke all on public.summaries from anon, authenticated;
revoke all on public.user_credits from anon, authenticated;

-- 2. Re-grant exactly the intended privileges. Row-level access is still governed by the RLS
-- policies on each table; these grants only open the table so RLS can then filter it.

-- videos / summaries: authenticated performs full CRUD, gated per-row by their RLS policies.
grant select, insert, update, delete on public.videos to authenticated;
grant select, insert, update, delete on public.summaries to authenticated;

-- user_credits: authenticated may only READ its own balance. No write grant and no write RLS policy —
-- balance changes flow exclusively through the SECURITY DEFINER functions (handle_new_user,
-- spend_credit) and the offline service-role script (grant_credits). Now enforced at the privilege
-- layer too, not just documented.
grant select on public.user_credits to authenticated;

-- anon intentionally receives nothing on the app tables: every app path requiring them is behind
-- authentication. (anon held only TRUNCATE/REFERENCES/TRIGGER before this, never SELECT, so this
-- removes dead privilege without changing any working path.)

-- service_role is deliberately left as-is: it bypasses RLS by design and is used only offline.
