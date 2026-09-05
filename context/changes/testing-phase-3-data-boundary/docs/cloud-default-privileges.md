# Cloud default privileges — verification record

**Status:** pending the manual pass (plan.md Phase 1, Progress 1.6–1.8)
**Local counterpart:** `src/test/authorization-invariants.int.test.ts`, invariant 9
**Claim under test:** `supabase/migrations/20260714140000_assert_least_privilege_functions.sql:8-16`

## Why this record exists

The whole framing of test-plan risk #4 rests on one asserted fact: **the cloud project's default
privileges grant `authenticated` `ALL` on new tables, while the local stack grants only
`Dxtm`** (TRUNCATE/REFERENCES/TRIGGER/MAINTAIN — no DML). That divergence is why the "a new table
must not inherit blanket access" property cannot be proven behaviourally on the local stack: an
untightened table would deny a read locally *for the wrong reason* while staying wide open in
production (research.md §5).

That fact was last verified on **2026-07-14**, by hand, and has lived as a comment in a migration
ever since. This record re-verifies and dates it, and additionally confirms that the cloud project's
per-table grants match the roster `authorization-invariants.int.test.ts` commits — because the
catalog test can only ever read the local stack (CI must not hold production credentials).

**No account identifiers belong in this file** (`lessons.md`, "Never commit account identifiers from
a real-environment pass"): the repo is public. Both queries below return roles, schemas and
privileges only — no email, `user_id`, token or key. Record the output verbatim; describe people by
role if they must be mentioned at all.

## How to run

Supabase dashboard → the 10xMedia project → **SQL Editor** → paste each query, run, paste the output
below. Both are read-only `select`s against `pg_catalog`; neither needs a grant and neither writes.

### Query 1 — default privileges: does `authenticated` still get `ALL` on new tables?

```sql
select d.defaclrole::regrole::text as grantor, n.nspname, d.defaclobjtype, d.defaclacl::text
from pg_default_acl d join pg_namespace n on n.oid = d.defaclnamespace;
```

### Query 2 — do the live per-table grants match the roster this phase commits?

```sql
select c.relname, r.rolname, array_agg(a.privilege_type order by a.privilege_type) as privs
from pg_class c
  join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
  cross join lateral aclexplode(c.relacl) a
  join pg_roles r on r.oid = a.grantee
where c.relkind = 'r' and r.rolname in ('anon','authenticated','service_role')
group by 1, 2 order by 1, 2;
```

## Results

**Date run:** _pending_
**Postgres version (`show server_version`):** _pending_

### Query 1 output

```
(paste verbatim)
```

### Query 2 output

```
(paste verbatim)
```

## Verdict

_pending_

Fill in against these three questions:

1. **Does `20260714140000:8-16` still hold?** The claim is that grantor `postgres`, schema `public`,
   objtype `r` carries `authenticated=arwdDxtm` on cloud (vs. `authenticated=Dxtm` locally). Answer
   holds / no longer holds / changed shape, and say which.
2. **Is `anon` still absent from grantor `postgres`'s `public` defaults for `r`, `S` and `f`?** That
   is `20260714140000:41-43` doing its job; invariant 9 asserts the local half of exactly this.
3. **Does Query 2's output match the roster?** Expected, per `CLIENT_READABLE` / `INTERNAL`:
   `authenticated` holds `{DELETE,SELECT}` on `videos` and `summaries`, `{SELECT}` on `user_credits`,
   and **nothing** on the nine internal tables; `anon` returns **zero rows** throughout;
   `service_role` holds no DML on the nine.

Any divergence in (3) is a **live finding**, not a test-design question — report it before Phase 2
starts (Progress 1.8).

## Reference — the local values this is compared against

Read from the running local stack on 2026-09-05, the same reads invariant 9 makes:

```
grantor  | nspname | objtype | acl
postgres | public  | r       | {postgres=arwdDxtm/postgres,authenticated=Dxtm/postgres,service_role=Dxtm/postgres}
postgres | public  | S       | {postgres=rwU/postgres,authenticated=w/postgres,service_role=w/postgres}
postgres | public  | f       | {postgres=X/postgres}
```

`anon` is absent from all three — as intended. A second grantor, `supabase_admin`, also carries
`public` defaults locally and *does* list `anon=arwdDxtm`; it is deliberately out of scope, because
migrations run as `postgres` and only that grantor's defaults apply to what they create.

### A local finding worth carrying into the cloud pass

The `f` (function) row above reads `{postgres=X/postgres}` — `anon` absent, exactly as
`20260714140000:41-43` intends. **It does not behave as that row suggests.** Verified on the local
stack, in a rolled-back transaction: a function created by `postgres` in `public` lands with
`proacl = NULL`, and `has_function_privilege('anon', …, 'EXECUTE')` returns **true** — because a NULL
function ACL means the built-in default, which is `EXECUTE` to `PUBLIC`.

So a migration that adds a `SECURITY DEFINER` function and forgets its
`revoke all on function … from public, anon, authenticated` leaves that function client-callable, in
**both** environments, and the default-privilege revoke does not prevent it. That is why invariant 5
in `authorization-invariants.int.test.ts` goes through `has_function_privilege` rather than
`aclexplode(proacl)`: the ACL-array form cannot see a PUBLIC grant (grantee oid 0 joins to no role)
and would have passed. Worth confirming the same holds on cloud while the SQL editor is open —
optional third query:

```sql
-- expect zero rows; a non-empty result means a public function is client-callable
select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as signature,
       has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_exec
from pg_proc p join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
where has_function_privilege('anon', p.oid, 'EXECUTE')
   or has_function_privilege('authenticated', p.oid, 'EXECUTE')
order by 1;
```
