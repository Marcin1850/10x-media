-- Migration: finish the least-privilege assertion — function grants + default privileges.
--
-- Why this exists: 20260714101500_assert_least_privilege.sql asserted the TABLE half of impl-review
-- F2 but skipped the FUNCTION half, because the local ACL check showed no surviving `anon` grant on
-- spend_credit() and the finding's function claim was recorded as "does not hold". That check was
-- LOCAL ONLY. The cloud project told a different story — verified 2026-07-14 after `db push`:
--
--   GRANT ALL ON FUNCTION "public"."spend_credit"() TO "anon";
--
-- Cloud default privileges (`ALTER DEFAULT PRIVILEGES ... GRANT ALL ON FUNCTIONS TO anon`) granted it
-- automatically at creation. The same defaults are why `anon` held ALL on the app tables on prod while
-- holding only TRUNCATE/REFERENCES/TRIGGER locally — so the note in 20260714101500 lines 38-39
-- ("anon held only TRUNCATE/REFERENCES/TRIGGER before this, never SELECT") is true locally and false
-- on prod. That migration is already applied and is left as-is; this one is the correction of record.
--
-- Not exploitable today: spend_credit() filters on `where user_id = auth.uid()`, and auth.uid() is
-- null for anon, so an anon call matches no row and decrements nothing. This is defense-in-depth —
-- the function is SECURITY DEFINER and runs as postgres, so if it ever grows a user_id parameter,
-- an anon caller could drain arbitrary balances. Same blast-radius argument 20260714101500 makes for
-- TRUNCATE.

-- 1. spend_credit(): callable by `authenticated` only.
-- `authenticated` MUST keep EXECUTE — this is the app's spend path, called per generation.
revoke all on function public.spend_credit() from public, anon;
grant execute on function public.spend_credit() to authenticated;

-- 2. handle_new_user_credits(): trigger-only, never called directly by a client.
-- Safe to revoke from every API role: PostgreSQL checks EXECUTE on a trigger function at CREATE
-- TRIGGER time, not at fire time, so the existing on_auth_user_credits_created trigger keeps working.
revoke all on function public.handle_new_user_credits() from public, anon, authenticated;

-- 3. Make the end state durable. Without this, the cloud defaults re-grant ALL to `anon` on every
-- future table/function created by postgres, and steps 1-2 above (plus 20260714101500) silently decay
-- as the schema grows — S-01 and S-04 both add tables. `anon` is intentionally left with nothing in
-- `public`: every app path behind these objects requires authentication.
--
-- Scoped to `anon` and to `for role postgres` (the role migrations run as) on purpose. `authenticated`
-- defaults are deliberately NOT touched: new tables landing with authenticated CRUD is the shape this
-- app's RLS design already assumes, and revoking it schema-wide would break future migrations that
-- rely on it without re-granting. Per-table tightening stays each feature's job, as user_credits did.
alter default privileges for role postgres in schema public revoke all on tables from anon;
alter default privileges for role postgres in schema public revoke all on sequences from anon;
alter default privileges for role postgres in schema public revoke all on functions from anon;
