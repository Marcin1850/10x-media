# Rollout Phase 3 — Data-boundary authorization: Implementation Plan

## Overview

Give `test-plan.md` risk #4 — "one account's summaries or video list become reachable by another, or a
client reaches the user-agnostic shared caches at all" — its first automated coverage. Three test
artifacts, in descending value per unit of cost:

1. A **catalog invariant** that turns the per-table tightening *convention* into an enforcement point.
2. A **two-account policy probe** that proves the five owner-scoped policies through real user sessions,
   issuing unfiltered reads so the service layer's own `.eq("user_id", …)` cannot mask a regression.
3. One **boundary case** for `readStoredSummary`, the single place where application code — not RLS — is
   the trust boundary.

Then the documentation this phase owes: `test-plan.md` §6.3 has read "TBD — see §3 Phase 3" since the
plan was written.

**Plus one phase this plan did not originally have.** Implementing artifact 1 forced a re-verification
of the cloud project's privileges, and that pass found a live production divergence: `service_role`
holds full DML on all nine internal tables on cloud and none locally, because every migration's
`revoke` names `public, anon, authenticated` and stops there. Phase 4 closes it. That is the rollout
working as intended — the phase's premise was that per-table tightening is a convention with no
enforcement point, and the first thing the enforcement point found was an un-tightened role in
production.

## Current State Analysis

`research.md` (2026-09-05, commit `2772302`) mapped the whole surface. What matters here:

- **Twelve tables in `public`, all with RLS enabled.** Three are client-reachable — `videos` and
  `summaries` (`SELECT`, `DELETE`) and `user_credits` (`SELECT`) — each gated by an owner-scoped
  `auth.uid() = user_id` policy. The other nine hold `revoke all from public, anon, authenticated` and
  **zero policies**: deny-by-privilege, strictly stronger than an owner-scoped policy.
- **`anon` holds nothing at all**, and **no `public` function grants EXECUTE to `anon` or
  `authenticated`** — the last three client-callable RPCs were dropped in
  `20260724120000_drop_legacy_rpcs.sql:15-20`.
- **The phase's stated premise was wrong, and research resolved it in the schema's favour.** The shared
  caches added by S-07/S-09 are not the hole; every one of them is closed at the privilege layer.
- **The live failure mode is a *future* migration, and it already happened once.**
  `20260904130000_test_support_grants.sql` granted `service_role` direct SELECT/DELETE on four shared
  tables so the Phase 2 harness could bypass their `SECURITY DEFINER` RPCs. It shipped in `d8f37f1` and
  was reverted in `e0fdb0d` (2026-09-05) by **human impl-review, not by any test**.
- **The "new table" half cannot be proven behaviourally.** Local `pg_default_acl` gives `authenticated`
  only `Dxtm` (TRUNCATE/REFERENCES/TRIGGER/MAINTAIN — no DML); the cloud project grants `ALL`
  (`20260714140000_assert_least_privilege_functions.sql:8-16`). An untightened new table would deny the
  read locally *for the wrong reason* while staying wide open in production.
- **`listSummaries` and `getBalance` both apply `.eq("user_id", userId)` on top of RLS**
  (`summary-list.ts:58`, `credits.ts:31`). Driving the endpoint therefore proves nothing about the
  policy — the same caveat already disclaims the one prior manual cross-account check
  (`context/changes/browse-summary-list/reviews/manual-verification-phase-1.md:67-75`).
- **`readStoredSummary` (`summaries.ts:388-391`) reads a summary by id with RLS off and no `user_id`
  predicate.** Safe today because `begin_generation` derives the id double-scoped by session user
  (`20260723130000_idempotent_generation.sql:127-128,144`) — but it is an argument, not evidence.
- **The harness is close but not complete.** `getDbOwnerConnection()` (`db-owner.ts:22`) already gives a
  loopback-validated table-owner connection. `SyntheticAccount` (`synthetic-account.ts:28-44`) exposes
  `userId` and `cookieHeader` but **no RLS-scoped client**, and only one call site exists
  (`generate.db.int.test.ts:209`), so two concurrent accounts are unexercised though nothing blocks them.
- **Zero existing coverage.** Nine test files; none asserts cross-account isolation, role privileges, or
  policy behaviour.

### Verified against the running local stack during planning (non-destructive `pg_catalog` reads)

- `aclexplode(relacl)` yields a clean per-role privilege set. `anon` returns **zero rows** across all 12
  tables. `authenticated` returns exactly `{DELETE,SELECT}` on `videos`/`summaries` and `{SELECT}` on
  `user_credits`. The nine internal tables show `service_role` at
  `MAINTAIN,REFERENCES,TRIGGER,TRUNCATE` — **no DML**. `relrowsecurity` is `true` on all 12.
- **`graphql_public` is cheaper to pin than the research feared.** It holds **zero** relations and
  **exactly one** function — `graphql(operationName text, query text, variables jsonb, extensions jsonb)`
  — and `pg_depend` shows that function is **not** extension-owned, so a pg_graphql upgrade will not move
  it. No maintained exclusion list is needed.
- Seed-insert shape: the only `NOT NULL`-without-default columns are `videos(user_id, url, youtube_id)`
  and `summaries(user_id, video_id, character, content)`.

## Cloud verification pass (2026-09-06)

Phase 1 owed a re-verification of the one fact the whole risk framing rests on — that the cloud
project's default privileges differ from the local stack's — because the catalog test can only ever
read local state (CI must not hold production credentials). Four read-only `pg_catalog` queries were
run against project `10x-media`, branch `main`, as role `postgres`. Roles and privileges only; no
account identifier was read or recorded (`lessons.md`).

**The claim in `20260714140000:8-16` holds, and the divergence is wider than that migration records.**
Grantor `postgres`, schema `public`:

| objtype | cloud | local | consequence |
| --- | --- | --- | --- |
| `r` tables | `authenticated=arwdDxtm` | `authenticated=Dxtm` | a new table lands with full CRUD for `authenticated` on cloud, no DML locally |
| `f` functions | `authenticated=X` | *(absent)* | a new function lands EXECUTE-able by `authenticated` on cloud |
| `S` sequences | `authenticated=rwU` | `authenticated=w` | cloud adds SELECT/USAGE |

The function row is new information — `20260714140000` recorded only the table half. It compounds the
implicit-ACL finding below: on cloud a migration that forgets its function `revoke` is exposed twice,
by the `PUBLIC` default *and* by the `authenticated` default.

`anon` is absent from all three `postgres`/`public` rows, so `20260714140000:41-43` is doing its job in
production. (`supabase_admin`'s `public` defaults do list `anon`, but they never apply to objects
migrations create.)

**Everything the roster asserts about `anon` and `authenticated` matches production exactly** — the
same twelve base tables, RLS on all of them, the five owner-scoped `auth.uid() = user_id` policies,
`authenticated` at `{DELETE,SELECT}` / `{DELETE,SELECT}` / `{SELECT}` on `videos`/`summaries`/
`user_credits` and nothing on the nine internal tables, `anon` holding nothing anywhere, and zero
`public` functions EXECUTE-able by either role. Invariants 1–7 would pass unchanged against cloud.

### The finding: `service_role` holds full DML on all nine internal tables in production

Invariant 8 asserts `service_role` holds no `SELECT/INSERT/UPDATE/DELETE` on the nine internal tables.
True locally; **false on cloud**, where it holds all four on every one of them.

**Cause.** Each internal table's migration runs `revoke all on table … from public, anon,
authenticated` — never from `service_role`. Locally that suffices, because the local default hands
`service_role` only `Dxtm`. On cloud the default hands it `arwdDxtm`, so the privilege survives.

**Consequences, stated precisely:**

- The intent recorded in `src/test/db-owner.ts:6-11` and `test-plan.md` §6.2 — "these tables
  deliberately grant `service_role` no direct table privileges; the app reaches them exclusively
  through `SECURITY DEFINER` RPCs" — describes the **local stack only**. In production it has never
  held.
- It is **not** a breach of the PRD privacy guardrail. `service_role` carries `rolbypassrls` and is a
  server-only secret that no client reaches. The property lost is defence in depth, not isolation.
- It changes the reading of `d8f37f1` → `e0fdb0d`. Reverting `20260904130000_test_support_grants.sql`
  was still right — it kept intent explicit and kept the harness off the production privilege surface
  — but its stated rationale ("permanently widens what the production request-path secret can do") did
  not hold: on cloud those four tables already granted `service_role` everything.
- **Invariant 8 is environment-dependent**, passing locally for a reason that does not obtain in
  production. Phase 4 exists to close that gap.

**The implicit-ACL finding this pass extends.** The local `f` default row reads `{postgres=X/postgres}`
— `anon` absent, exactly as `20260714140000:41-43` intends — but it does not behave as that row
suggests. Verified locally in a rolled-back transaction: a function created by `postgres` in `public`
lands with `proacl = NULL`, and `has_function_privilege('anon', …, 'EXECUTE')` returns **true**,
because a NULL function ACL means the built-in default, which is EXECUTE to `PUBLIC`. So a migration
that forgets `revoke all on function … from public, anon, authenticated` leaves that function
client-callable in **both** environments — and on cloud the `authenticated=X` default grants it a
second time, so revoking `PUBLIC` alone would not be enough there. That is why invariant 5 goes
through `has_function_privilege` rather than `aclexplode(proacl)`: the ACL-array form cannot see a
`PUBLIC` grant (grantee oid 0 joins to no role) and would have passed. The current production surface
is clean — zero such functions — and invariant 5 is what keeps it that way.

## Desired End State

`npm run test:integration` fails if any of the following stops being true, and the `integration` CI job
(which `deploy` needs) carries that signal:

- A migration adds a table to `public` without classifying it in the committed roster.
- A new table lands without RLS, or with any `authenticated` privilege beyond the allow-list.
- `anon` gains any table privilege or any function EXECUTE in `public`.
- A `public` function becomes EXECUTE-able by `anon` or `authenticated`.
- A granted `authenticated` verb loses its matching owner-scoped policy, or a policy's `qual` stops being
  `auth.uid() = user_id`.
- `service_role` gains DML on any of the nine internal tables (the `e0fdb0d` regression).
- The schema-wide `anon` default-privilege revoke is undone.
- An object appears in `graphql_public`.
- A signed-in account can see, or delete, another account's `summaries`, `videos` or `user_credits` row —
  by unfiltered list, by direct id, or through the production embed shape.
- Two accounts submitting the **same** `requestId` can reach each other's stored summary.

Plus: `test-plan.md` §6.3 documents the pattern, and the cloud/local default-privilege divergence is
re-verified and dated in this change folder rather than resting on a 2026-07-14 note.

### Key Discoveries

- The catalog is the only layer that can express the "new table" property (research §5) — and the two
  states *are* locally distinguishable: a tightened table has **no `authenticated` ACL entry at all**, an
  untightened one has a stray `Dxtm`, which on cloud means full CRUD.
- `service_role` carries `rolbypassrls = true`, so its ACL is not a trust boundary in the PRD's terms.
  Asserting it is defence-in-depth — but it is the assertion that would have caught `20260904130000`.
- `fetch-firewall.ts` permits loopback, so a real `supabase-js` session client against
  `http://127.0.0.1:54321` works inside the integration project without touching the firewall.
- `fetch-firewall.ts`'s `afterAll` already closes the owner connection pool — a new test file that calls
  `getDbOwnerConnection()` needs no teardown of its own.

## What We're NOT Doing

- **No e2e**, and no Playwright. That is §3 Phase 4.
- **No test that creates a table to observe default-privilege inheritance.** It proves the wrong thing
  locally (research §5).
- **No mutation testing.** There is no application code under test — the subject is SQL DDL and catalog
  state, which Stryker does not mutate.
- **No assertion about what a user can see made through a `service_role` or owner connection.** Both
  bypass RLS by definition and would go green against a broken policy.
- **No production schema change.** Specifically, we are *not* revoking the `authenticated` half of
  `pg_default_acl` schema-wide — `20260714140000:36-40` records that decision and its reason, and
  reversing it inside a testing phase would risk breaking future migrations that rely on it.
- **Not disabling `graphql_public`.** We assert it is empty instead; dropping the exposure would be a
  production config change that must be mirrored on cloud, which is the very divergence class this phase
  exists to pin down.
- **No `RESERVED_YOUTUBE_IDS` entries for Phase 2's seeded rows.** That registry guards the
  *user-agnostic* caches; Phase 2 seeds no cache row, and `dispose()`'s `auth.users` cascade removes the
  seeded `videos`/`summaries`.
- **No change to `listSummaries` / `getBalance`.** Their redundant `.eq("user_id", …)` is defence in
  depth; the point here is to test *around* it, not remove it.
- **No refresh of `test-plan.md` §2.** Risk #4's wording and Source cell were already backported on
  2026-09-05 (§8 freshness ledger).

## Implementation Approach

Two new integration files plus one case appended to an existing one, ordered so the cheapest and
highest-value artifact lands first and nothing later depends on anything earlier.

The **catalog invariant** (Phase 1) needs no accounts, no HTTP, and tens of milliseconds. Its oracle is a
**hand-written, default-deny roster** committed in the test file with a source citation per entry: any
table, function, grant or policy not on the roster fails. A generated snapshot was rejected — its oracle
would be the implementation, and the fix for a red run would be `--update`, which is exactly the
vibe-test failure mode `test-plan.md` §6.1 rules out. The roster's maintenance cost (a test edit per new
table) **is** the deliverable: it is the enforcement point the convention has never had.

The **policy probe** (Phase 2) issues unfiltered reads through the app's own
`createClient(new Headers({ Cookie: … }), …)`, built per test from the synthetic account's cookie header
— so the header round-trips through the app's real `parseCookieHeader` and the session under test is the
one production builds. `synthetic-account.ts` is left unchanged.

The **replay boundary** (Phase 3) reuses `generate.db.int.test.ts`'s cache-seeding and `llm.ts` mock
wholesale rather than rebuilding the paid-path harness.

Both new files live in `src/test/`, next to the harness they extend — the colocation rule in §6.1 names
"the module it covers", and these cover schema and policy state, which has no module. Both belong to the
**`integration` project**, deliberately: the catalog test needs neither the `fetch` firewall nor a
synthetic account and is two orders of magnitude faster than the rest of that suite, but it needs
`getDbOwnerConnection()` and therefore the loopback guard, which only `globalSetup` provides.

## Critical Implementation Details

**`Dxtm` is signal, not noise, and it means different things per role.** `MAINTAIN,REFERENCES,TRIGGER,
TRUNCATE` is what the local `postgres` default privileges hand out; it contains no DML. For
`authenticated` on a table outside the allow-list, its *presence* is the forgotten-revoke signal and must
fail. For `service_role` on the nine internal tables, it is inherited and expected, so that assertion
must target DML specifically (`SELECT`/`INSERT`/`UPDATE`/`DELETE`) rather than "zero privileges" — an
invariant asserting the latter would go red today (research §1, precision note).

**Two accounts, two disposals, and the first one must not swallow the second.** `withTwoAccounts` needs
nested `try/finally` (or an equivalent) so a throw while disposing A still disposes B. `dispose()` throws
by design (impl-review F3), and a leaked `auth.users` row aborts the *next* run's stale-account guard.

**`vi.doMock` registrations outlive `vi.resetModules()`.** `generate.db.int.test.ts:155` documents this
the hard way — Phase 3's new case must go through the existing `loadRealEndpoint()`, which unmocks
`@/lib/supabase-admin` first, rather than registering its own mocks.

**Ordering inside Phase 3's teardown.** Caches first (by `youtube_id`, through the owner connection),
then each account's `dispose()`. Reversed, `supadata_calls` rows orphan into the ledger risk #2 sums.

---

## Phase 1: Catalog invariant

### Overview

The enforcement point risk #4's "new table" half has never had. One new integration file, no accounts,
no HTTP. Plus the one-off cloud read that re-dates the divergence the whole risk framing rests on.

### Changes Required:

#### 1. The invariant test

**File**: `src/test/authorization-invariants.int.test.ts` (new)

**Intent**: Assert the client-facing authorization surface of `public` against a committed, default-deny
roster, so a migration that adds a table, widens a grant, drops a policy, or exposes a function goes red
in CI instead of relying on a reviewer noticing. Reads `pg_class`, `pg_policy`, `pg_proc`,
`pg_default_acl` and `pg_namespace` through `getDbOwnerConnection()` — `pg_catalog` needs no grant, so
this test applies **no** privilege pressure of its own (which is what `d8f37f1` did wrong).

**Contract**: The roster is the oracle and lives at the top of the file, each entry carrying the source
that justifies it — PRD guardrail (`prd.md:36-37`, `prd.md:90-92`) and each table's own migration intent,
never the current catalog. Two buckets:

- `CLIENT_READABLE` — `videos: ["DELETE","SELECT"]`, `summaries: ["DELETE","SELECT"]`,
  `user_credits: ["SELECT"]`.
- `INTERNAL` — the nine deny-by-privilege tables: `generation_locks`, `credit_reservations`,
  `transcript_fetch_attempts`, `transcript_quotes`, `transcript_cache`, `supadata_calls`,
  `metadata_cache`, `supadata_budget`, `supadata_reservations`.

Nine assertions, each its own `it` with its own failure message naming the offending object and the
repair (an `it.each` only where the rows genuinely differ in what they catch):

1. **Roster completeness** — the set of base tables (`relkind = 'r'`) in `public` equals
   `keys(CLIENT_READABLE) ∪ INTERNAL`. A new table fails *whether or not it was tightened*; the message
   says to classify it here and confirm its migration revokes `authenticated`. This is the assertion that
   makes the convention enforceable.
2. **RLS everywhere** — `relrowsecurity = true` on every base table in `public`.
3. **`anon` holds nothing** — no table privilege in `public`, and EXECUTE on no `public` function.
4. **`authenticated`'s table privileges equal the roster exactly** — the allow-listed verbs on the three
   client-readable tables, and **no ACL entry at all** on the nine internal ones. A stray `Dxtm` fails;
   the message explains it means a migration skipped its revoke, and that on cloud the same omission is
   full CRUD.
5. **`authenticated` holds EXECUTE on no `public` function** — the surface a `SECURITY DEFINER` function
   taking a `user_id` would reopen (`20260714140000:18-22`).
6. **Policies match grants** — every verb granted to `authenticated` has a policy `for` that command
   `to authenticated`, and no policy exists for a table/verb outside the roster.
7. **Every policy's `qual` is owner-scoped** — `auth.uid() = user_id`, normalized for whitespace and
   parenthesization.
8. **`service_role` holds no DML on the nine internal tables** — `SELECT`/`INSERT`/`UPDATE`/`DELETE`
   specifically; `Dxtm` is tolerated and the header comment says why (research §1 precision note). This
   is the `20260904130000` regression, and the comment marks it defence-in-depth rather than a PRD
   guardrail, since `service_role` bypasses RLS anyway.
9. **Default privileges and `graphql_public`** — `pg_default_acl` for role `postgres` in schema `public`
   excludes `anon` for tables, sequences and functions; and `graphql_public` holds zero relations and
   exactly one function, `graphql`.

**Every function assertion is scoped to schema `public` — do not widen it.** `graphql_public.graphql()`
**is** EXECUTE-able by `anon` and `authenticated`, by design: that is how the GraphQL endpoint the CLI
exposes by default (`supabase/config.toml:13`) is reached at all. A query written without an `nspname =
'public'` filter therefore goes red on assertions 3 and 5 for a reason that is not a finding. The app
uses no GraphQL (zero references in `src/`/`scripts/`, no dependency in `package.json`), and pg_graphql
resolves through the same `public` grants and RLS — so it is a second door onto the same room, with the
same locks. The residual worth pinning is only that no *object* appears in `graphql_public`, where
`supabase_admin`'s default ACLs would grant `anon`/`authenticated` `ALL`; that is what assertion 9 covers.
Removing the exposure outright is a separate, deliberate change — `config.toml` configures only the local
stack, so it would have to be mirrored in the cloud project's API settings or it creates exactly the
local/cloud divergence this phase exists to pin down.

The file header states the environment boundary explicitly: assertion 9 pins the **local** default ACL
only, the cloud values are recorded in this plan's "Cloud verification pass" section, and assertions 1
and 4 are the environment-independent guard that makes that gap tolerable.

#### 2. The cloud divergence check

**Where it lands**: this plan's **"Cloud verification pass (2026-09-06)"** section, above. Deliberately
not a separate file — a one-off verification record with no consumer of its own belongs where the
decisions it feeds already live, and Phase 4 is one of those decisions.

**Intent**: Re-verify and date the 2026-07-14 claim that the cloud project's default privileges grant
`authenticated` `ALL` on new tables — the fact the entire risk framing rests on — and confirm the cloud
project's per-table ACLs match the roster Phase 1 commits.

**Contract**: Read-only queries run by hand in the cloud project's SQL editor, with the date and a
verdict against `20260714140000:8-16`. Per `lessons.md` ("Never commit account identifiers from a
real-environment pass"), the record carries **no** email, `user_id`, token or key — roles and
privileges only. Queries:

```sql
-- 1. default privileges: does `authenticated` still get ALL on new tables?
select d.defaclrole::regrole::text as grantor, n.nspname, d.defaclobjtype, d.defaclacl::text
from pg_default_acl d join pg_namespace n on n.oid = d.defaclnamespace;

-- 2. do the live per-table grants match the roster this phase commits?
select c.relname, r.rolname, array_agg(a.privilege_type order by a.privilege_type) as privs
from pg_class c
  join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
  cross join lateral aclexplode(c.relacl) a
  join pg_roles r on r.oid = a.grantee
where c.relkind = 'r' and r.rolname in ('anon','authenticated','service_role')
group by 1, 2 order by 1, 2;
```

### Success Criteria:

#### Automated Verification:

- `npm run test:integration` passes with the new file green
- `npm run lint` passes
- `npm run typecheck` passes
- A deliberate temporary edit to the roster (drop `user_credits`) makes assertion 1 fail with a message
  naming `user_credits` — revert after confirming
- A deliberate temporary `grant select on transcript_cache to authenticated` in a rolled-back transaction
  makes assertion 4 fail — revert after confirming

#### Manual Verification:

- The queries above are run against the cloud project and their outcome recorded in this plan's
  "Cloud verification pass" section, with the date and the verdict against `20260714140000:8-16`
- The record contains no account identifiers (`lessons.md`)
- If cloud's per-table grants diverge from the roster, that divergence is reported before Phase 2 starts —
  it would be a live finding, not a test-design question

**Implementation Note**: After completing this phase and all automated verification passes, pause here
for manual confirmation from the human that the manual testing was successful before proceeding.

---

## Phase 2: Two-account policy probe

### Overview

The behavioural half. Two synthetic accounts, rows seeded through the owner connection, **unfiltered**
reads issued through real RLS-scoped sessions — the shape that cannot be masked by the service layer's
own `user_id` filter.

### Changes Required:

#### 1. The probe

**File**: `src/test/cross-account-policy.int.test.ts` (new)

**Intent**: Prove the five owner-scoped policies behaviourally, from the position of a real signed-in
account, so a policy regression is caught by a test rather than by the manual, self-disclaiming check
that is the only prior coverage.

**Contract**: Two accounts from `createSyntheticAccount(admin)`. `videos` and `summaries` rows for each
seeded **through `getDbOwnerConnection()`** — no endpoint, no generation, no transcript, no LLM, so
§7's hard rule is satisfied by construction. Required seed columns are
`videos(user_id, url, youtube_id)` and `summaries(user_id, video_id, character, content)`; `character`
must be `'informational'` or `'educational'` (check constraint). Synthetic youtube ids carry their own
prefix (e.g. `xacct0001`) and are **deliberately not** added to `RESERVED_YOUTUBE_IDS` — a one-line
comment in `synthetic-fixtures.ts` records that the registry guards the user-agnostic *caches*, which
this file never touches, so a future reader does not read the omission as an oversight.

The RLS-scoped session is built per test from the account's cookie header through the app's own client:
`createClient(new Headers({ Cookie: account.cookieHeader }), <AstroCookies stand-in>)` from
`@/lib/supabase` — reachable in the integration project via the `astro:env/server` alias, and permitted
by `fetch-firewall.ts` because the local stack is loopback. The `AstroCookies` stand-in follows the cast
shape already used at `generate.db.int.test.ts:190-196`. `synthetic-account.ts` is not modified.

Six assertions, each catching a different regression:

- **Unfiltered list is owner-scoped** — `it.each` over `summaries`, `videos`, `user_credits`:
  `.select("id")` with **no filter**, as B, returns exactly B's rows. Three rows because each is a
  separate policy.
- **Direct id lookup is filtered too** — `.select("*").eq("id", <A's summary id>)` as B returns empty.
  Distinct from the list case: it proves the policy is not merely shaping a list.
- **DELETE is denied and non-destructive** — `.delete().eq("id", <A's summary id>)` as B affects 0 rows
  **and** A's row still exists when read back through the owner connection. `authenticated` genuinely
  holds `DELETE`, so this is a live verb, not a hypothetical.
- **The production embed shape is filtered** — `.select("id, videos(youtube_id)")` as B, the shape
  `listSummaries` actually issues, returns only B's rows with only B's embedded video.
- **An unauthenticated session sees nothing** — the same client built with an empty `Cookie` header
  returns zero rows (or an error) on all three tables, covering the `anon` half behaviourally.

The file header states the anti-pattern in the negative: this file must **never** call `listSummaries`
or `getBalance` with a `userId`, because both apply `.eq("user_id", …)` on top of RLS
(`summary-list.ts:58`, `credits.ts:31`) and would mask exactly the regression under test — citing
`browse-summary-list/reviews/manual-verification-phase-1.md:67-75`.

**Cleanup**: a `withTwoAccounts` helper disposing both accounts in nested `try/finally` so a throw
disposing the first still disposes the second. No `youtubeIds` argument is passed to `dispose()` — no
`supadata_calls` row is created — and the seeded `videos`/`summaries` go with the `auth.users` cascade.

### Success Criteria:

#### Automated Verification:

- `npm run test:integration` passes with the new file green
- `npm run lint` and `npm run typecheck` pass
- Re-running `npm run test:integration` immediately afterwards passes — proving cleanup left no stale
  synthetic account for `globalSetup`'s guard to trip on
- Temporarily broadening `summaries_select_authenticated`'s `using` clause to `true` in a rolled-back
  transaction turns the unfiltered-list row red — revert after confirming

#### Manual Verification:

- Supabase Studio's Auth panel shows no `synthetic-db-int-` accounts after the run
- The two-account seeding does not disturb the operator's real local data (row counts on `videos` and
  `summaries` for non-synthetic users unchanged)

**Implementation Note**: Pause for manual confirmation before proceeding to Phase 3.

---

## Phase 3: Replay boundary case

### Overview

One test, not a group: the only place application code — not RLS — is the trust boundary.

### Changes Required:

#### 1. A cross-account replay case

**File**: `src/pages/api/summaries/generate.db.int.test.ts` (extend)

**Intent**: Prove that two accounts submitting the **same** `requestId` cannot reach each other's stored
summary — replacing the double-scoping *argument* about `readStoredSummary` (`summaries.ts:388-391`, no
`user_id` predicate, RLS bypassed) with evidence, and exercising the `(user_id, request_id)` partial
unique index (`20260723130000:48-50`) as the thing that keeps two accounts' identical keys apart.

**Contract**: A and B both `POST /api/summaries/generate` with the same `requestId` UUID against the same
synthetic video id, caches pre-seeded once via the file's existing `seedCaches`, `llm.ts` mocked through
the existing `loadRealEndpoint()` so each account's call returns **distinguishable** content. Assertions:
B's response carries B's own content and B's own `summaryId` (never A's), and B's balance debits — B's
request is a fresh generation, not a replay of A's.

Oracle: the PRD privacy guardrail (`prd.md:36-37`) plus `begin_generation`'s own documented lookup,
scoped `where cr.user_id = target_user and cr.request_id = request`
(`20260723130000_idempotent_generation.sql:127-128,144`) — read from the migration, not from
`generate.ts`.

Reuses `loadRealEndpoint()` unchanged (it unmocks `@/lib/supabase-admin` first — `generate.db.int.test.ts:155`).

#### 2. A fixture id for it

**File**: `src/test/synthetic-fixtures.ts` (extend)

**Intent**: Register the new scenario's synthetic video id so `globalSetup`'s stale-row guard knows to
look for it.

**Contract**: One new key in `DB_LAYER_YOUTUBE_IDS` — `crossAccountReplay: "sdbtest0010"`.

#### 3. Two-account teardown in the paid-path file

**File**: `src/pages/api/summaries/generate.db.int.test.ts` (extend)

**Intent**: Extend the file's `withAccount` pattern to two accounts without weakening its cleanup
contract.

**Contract**: A `withTwoAccounts(youtubeId, run)` alongside the existing `withAccount`. Teardown order is
load-bearing: `cleanupCaches(youtubeId)` once, then each account's `dispose([youtubeId])` — nested
`try/finally` so a throw disposing the first still disposes the second. `supadata_calls` is
`on delete set null`, so it must go before the `auth.users` row (§6.2).

### Success Criteria:

#### Automated Verification:

- `npm run test:integration` passes with the new case green
- `npm run lint` and `npm run typecheck` pass
- Re-running `npm run test:integration` immediately afterwards passes — no stale cache row for
  `sdbtest0010`, no stale synthetic account
- The mocked `summarize` is called twice (once per account), confirming B's request was a real generation
  and not a replay of A's

#### Manual Verification:

- `select count(*) from supadata_budget` is unchanged before and after the run — the singleton row this
  layer must never touch
- No row for `sdbtest0010` survives in `transcript_cache` or `metadata_cache` after the run

**Implementation Note**: Pause for manual confirmation before proceeding to Phase 4.

---

## Phase 4: Close the `service_role` divergence the tests exposed

### Overview

**This phase was not in the original plan.** It exists because Phase 1's catalog invariant, plus the
cloud pass it forced, surfaced a live production divergence that no local test can see: `service_role`
holds full DML on all nine internal tables on cloud, and none locally (see "Cloud verification pass"
above). Invariant 8 therefore passes locally for a reason that does not obtain in production, and the
intent recorded in `db-owner.ts` and `test-plan.md` §6.2 describes only the local stack.

This is the test rollout doing its job: the phase's whole argument was that per-table tightening is a
convention with no enforcement point, and the first thing the enforcement point found was an
un-tightened role in production. Fixing it makes invariant 8 mean the same thing in both environments,
which is what turns it from a local curiosity into coverage.

The earlier "no production schema change" boundary applied to *test-harness convenience* — the
`d8f37f1` failure mode, where a migration widened privileges so a test could reach past an RPC. This
change is its opposite: it narrows privileges to match documented intent, and no test needs it to pass.

### Changes Required:

#### 1. The revoke

**File**: `supabase/migrations/<YYYYMMDDHHmmss>_revoke_service_role_internal_tables.sql` (new)

**Intent**: Bring production in line with the design every internal table's migration states — reachable
only through `SECURITY DEFINER` RPCs — by removing the table privileges the cloud default privileges
handed `service_role` and no migration ever revoked.

**Contract**: One statement, revoking every table privilege from `service_role` on the nine tables in
`INTERNAL`:

```sql
revoke all on table
  public.generation_locks, public.credit_reservations,
  public.transcript_fetch_attempts, public.transcript_quotes,
  public.transcript_cache, public.supadata_calls,
  public.metadata_cache, public.supadata_budget,
  public.supadata_reservations
from service_role;
```

The header must record: that this is a **cloud-only correction** (locally it is a near-no-op — the local
default grants `service_role` only `Dxtm`, so only that is removed); that `service_role` keeps `EXECUTE`
on every RPC and needs nothing else; and the `20260714140000:8-16` divergence that caused it, so a
future reader does not mistake the revoke for a tightening that was always in force.

**Why it should be behaviour-neutral**: no `.from(<internal table>)` exists anywhere in `src/` or
`scripts/` (research.md §6) — every path goes through a `SECURITY DEFINER` function, which executes as
the table owner (`postgres`), not as the caller. The test harness already reaches these tables through
`getDbOwnerConnection()`, which is a table-owner connection and unaffected.

#### 2. Make invariant 8 say what it now means

**File**: `src/test/authorization-invariants.int.test.ts` (extend)

**Intent**: The invariant's message and the file header currently frame `service_role` DML as a
regression that "would have caught `20260904130000`". After this migration that is true in both
environments; before it, it was true only locally. Record the distinction so the next reader does not
re-derive it.

**Contract**: Extend invariant 8's failure message and the file header with the cloud finding, its date,
and the migration that closed it. No assertion changes — the invariant already asserts the right thing;
what changes is that production now satisfies it too.

### Success Criteria:

#### Automated Verification:

- `npx supabase migration up` applies cleanly against the local stack
- `npm run test:integration` passes — invariant 8 still green locally (the migration removes `Dxtm`
  there, which the invariant does not assert)
- `npm run lint` and `npm run typecheck` pass

#### Manual Verification:

- `npx supabase db push` applied to the cloud project
- Query 2 from the cloud pass re-run against cloud: `service_role` returns **no rows** for the nine
  internal tables, and the three client-readable tables are unchanged
- A full generation run against production succeeds end to end — the only way to prove no RPC path
  reaches those tables as `service_role` by a route research.md §6 did not find
- `anon` and `authenticated` grants unchanged on cloud (the revoke names `service_role` only)

**Implementation Note**: Pause for manual confirmation before proceeding to Phase 5. The cloud push is
the load-bearing step here — a green local run proves almost nothing, because locally the migration is
a near-no-op.

---

## Phase 5: Cookbook, project docs, and status sync

### Overview

The documentation this phase owes, plus the status transitions `lessons.md` requires in the same session
as the work.

### Changes Required:

#### 1. The §6.3 cookbook section

**File**: `context/foundation/test-plan.md`

**Intent**: Replace §6.3's "TBD — see §3 Phase 3" with the actual pattern, so the next data-access test is
written from the plan rather than by reading these three files.

**Contract**: §6.3 covers (a) the two-account ownership pattern — seed through the owner connection,
assert through an RLS-scoped session built from the cookie header, never through `listSummaries` /
`getBalance` and why; (b) the catalog-invariant pattern and the roster's maintenance contract — adding a
table means classifying it, and that cost is the feature; (c) the local/cloud default-privilege
divergence and why the "new table" property cannot be proven behaviourally; (d) which of the two layers a
given new assertion belongs in.

#### 2. Rollout status and phase notes

**File**: `context/foundation/test-plan.md`

**Intent**: Reflect that Phase 3 shipped, and record what it taught so the next rollout phase does not
rediscover it.

**Contract**: §3's Phase 3 row Status → `complete`. §5's integration row drops "authorization is still §3
Phase 3". A §6.6 "Phase 3" block records: the `Dxtm`-per-role asymmetry; that `pg_catalog` reads need no
grant, which is why this phase applied no privilege pressure; the `graphql_public` finding (zero
relations, one non-extension-owned function); the roster's maintenance contract; **the two findings the
cloud pass produced** — that a function with no explicit ACL is EXECUTE-able by `PUBLIC`, which is why
role assertions go through `has_*_privilege` and not `aclexplode`, and the `service_role` divergence
Phase 4 closed; and **the rule those two share**: an invariant that reads a *default* privilege pins
only the environment it runs in, so the assertions that carry the guarantee must be the per-object ones.
§6.2's "these tables deliberately grant `service_role` no direct table privileges" is corrected in the
same pass — true in both environments only from Phase 4 onward. §8 gains a dated entry.

#### 3. Agent-facing rules

**Files**: `CLAUDE.md`, `AGENTS.md` (both carry the same `## Testing` and `## Conventions` blocks —
**keep them identical**)

**Intent**: Two edits. Add the data-boundary layer to the short-form testing rules; and correct the
migrations convention bullet, which currently prescribes a pattern the schema has not used since
2026-07-14.

**Contract**: (a) A new `## Testing` bullet naming the third integration layer — catalog invariants and
the two-account probe, both reading through `getDbOwnerConnection()`, with the "never assert a user's
visibility through an RLS-bypassing connection" rule and a pointer to §6.3. (b) The `## Conventions`
bullet currently reads "Always enable RLS on new tables with granular per-operation, per-role policies";
the schema uses **two** mechanisms, and for internal tables the second is the correct one — RLS on,
`revoke all from public, anon, authenticated`, zero policies. Rewrite it to name both and say which
applies when, and add that a new table must be classified in
`src/test/authorization-invariants.int.test.ts`'s roster or the integration suite fails. The revoke list
must now read `public, anon, authenticated, service_role` for an internal table — Phase 4's finding is
that omitting `service_role` leaves the cloud default in place, and the omission is invisible locally.
Same for a new function: `revoke all on function … from public, anon, authenticated` is required, and
`public` is the load-bearing word — without it the function is client-callable in both environments.

#### 4. README

**File**: `README.md`

**Intent**: Keep the CI section's description of what the integration suite covers accurate.

**Contract**: The `integration` bullet in the CI section gains authorization/data-boundary coverage
alongside the paid-path coverage it already names.

#### 5. Linear

**Intent**: `lessons.md` requires the board to move in the same session as the work.

**Contract**: MAR-21 stays **In Progress** (the change is not archived here) with one comment per phase
completion summarizing what landed. The `Next:` pointer in the issue description is updated or removed.
The roadmap is **not** touched: no item in `context/foundation/roadmap.md` carries
`testing-phase-3-data-boundary` as its `Change ID` (test-rollout phases are tracked in `test-plan.md` §3,
not the product roadmap).

#### 6. Change identity

**File**: `context/changes/testing-phase-3-data-boundary/change.md`

**Contract**: `status: complete`, `updated: <date>`.

### Success Criteria:

#### Automated Verification:

- `npm run lint` passes (markdown is Prettier-formatted by the per-edit hook)
- `npm run typecheck` and `npm run typecheck:astro` pass
- `npm test` and `npm run test:integration` both pass
- `diff` of the `## Testing` and `## Conventions` sections between `CLAUDE.md` and `AGENTS.md` shows no
  divergence

#### Manual Verification:

- §6.3 is specific enough that the next data-access test can be written from it without re-reading the
  test files
- MAR-21 carries a comment per phase and its description holds no stale `Next:` pointer
- `test-plan.md` §3's Phase 3 row and §5's integration row agree with each other

---

## Testing Strategy

This phase *is* tests, so the strategy below is about what proves the tests themselves work.

### Unit Tests:

None. Nothing here is a pure function; the subject is catalog state and policy behaviour.

### Integration Tests:

- `src/test/authorization-invariants.int.test.ts` — nine catalog assertions against a committed roster.
- `src/test/cross-account-policy.int.test.ts` — six behavioural assertions across two live sessions.
- `src/pages/api/summaries/generate.db.int.test.ts` — one cross-account replay case.

### Manual Testing Steps:

1. **Prove each new test can fail.** For Phase 1, temporarily drop a roster entry and separately
   `grant select on transcript_cache to authenticated` inside a rolled-back transaction; both must go
   red with a message naming the object. For Phase 2, broaden `summaries_select_authenticated`'s `using`
   clause to `true` in a rolled-back transaction; the unfiltered-list row must go red. Revert every probe.
   A test that has never been seen red is not evidence.
2. **Run the cloud queries** from Phase 1 and record their outcome, stripped of account identifiers.
3. **Run `npm run test:integration` twice in a row.** The second run passing is the cleanup assertion.
4. **Check Supabase Studio's Auth panel** for surviving `synthetic-db-int-` accounts.
5. **After Phase 4's `db push`, re-run the cloud pass's Query 2** and confirm `service_role` returns no
   rows for the nine internal tables, then drive one full generation against production. Phase 4 is the
   only step here whose local run is not evidence.

## Performance Considerations

The catalog test adds tens of milliseconds. The policy probe adds two account create/sign-in/delete
cycles (~1-2s). The replay case adds one more account and one more endpoint round-trip to a file that
already runs several. The `integration` CI job's wall time is dominated by `supabase start`, so the
relative cost is negligible.

## Migration Notes

**One migration, added mid-flight (Phase 4), and it is the opposite of the thing this phase forbids.**
Phases 1-3 add no SQL: their whole argument is that test-harness needs must not apply pressure on
production privileges (`d8f37f1` → `e0fdb0d`), and `pg_catalog` reads need no grant. Phase 4's migration
is not harness pressure — it *narrows* `service_role` to match what every internal table's own migration
already claims, and no test needs it to pass. It exists because the catalog invariant found a real
divergence, which is the enforcement point working as designed.

It is a **cloud-only correction in effect**: locally it removes `Dxtm` (which nothing asserts), on cloud
it removes full CRUD. So a green local run proves almost nothing — `db push` plus a re-run of the cloud
pass's Query 2 is the verification that counts.

## References

- Research: `context/changes/testing-phase-3-data-boundary/research.md`
- Risk and rollout row: `context/foundation/test-plan.md` §2 risk #4, §3 Phase 3, §6.3
- Guardrail (the oracle): `context/foundation/prd.md:36-37, 90-92`
- The live near-miss: `20260904130000_test_support_grants.sql`, `d8f37f1` → `e0fdb0d`
- The divergence decision: `supabase/migrations/20260714140000_assert_least_privilege_functions.sql:8-16,36-43`
- The prior manual check and its disclaimer: `context/changes/browse-summary-list/reviews/manual-verification-phase-1.md:67-75`
- Harness this phase extends: `src/test/db-owner.ts:22`, `src/test/synthetic-account.ts:28-44`,
  `src/test/integration-setup.ts`, `src/test/fetch-firewall.ts`
- Pattern to follow: `src/pages/api/summaries/generate.db.int.test.ts` (`withAccount`, `loadRealEndpoint`,
  the `AstroCookies` cast at `:190-196`)

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Catalog invariant

#### Automated

- [x] 1.1 `npm run test:integration` passes with the new file green — bd136af
- [x] 1.2 `npm run lint` passes — bd136af
- [x] 1.3 `npm run typecheck` passes — bd136af
- [x] 1.4 A dropped roster entry makes assertion 1 fail naming the table (reverted) — bd136af
- [x] 1.5 A temporary `grant select on transcript_cache to authenticated` makes assertion 4 fail (reverted) — bd136af

#### Manual

- [x] 1.6 Cloud default-privilege and per-table-grant queries run and recorded in the plan's "Cloud verification pass" section with date and verdict — d0629d3
- [x] 1.7 The record contains no account identifiers — d0629d3
- [x] 1.8 Any divergence between cloud grants and the roster reported before Phase 2 starts — d0629d3

### Phase 2: Two-account policy probe

#### Automated

- [ ] 2.1 `npm run test:integration` passes with the new file green
- [ ] 2.2 `npm run lint` and `npm run typecheck` pass
- [ ] 2.3 A second consecutive `npm run test:integration` passes (cleanup proven)
- [ ] 2.4 Broadening `summaries_select_authenticated`'s `using` to `true` turns the unfiltered-list row red (reverted)

#### Manual

- [ ] 2.5 No `synthetic-db-int-` accounts survive in Supabase Studio's Auth panel
- [ ] 2.6 Non-synthetic `videos`/`summaries` row counts unchanged

### Phase 3: Replay boundary case

#### Automated

- [ ] 3.1 `npm run test:integration` passes with the new case green
- [ ] 3.2 `npm run lint` and `npm run typecheck` pass
- [ ] 3.3 A second consecutive `npm run test:integration` passes (no stale `sdbtest0010` row, no stale account)
- [ ] 3.4 The mocked `summarize` is called twice, confirming B generated rather than replayed

#### Manual

- [ ] 3.5 `supadata_budget` row count unchanged before and after the run
- [ ] 3.6 No `sdbtest0010` row survives in `transcript_cache` or `metadata_cache`

### Phase 4: Close the `service_role` divergence the tests exposed

#### Automated

- [ ] 4.1 `npx supabase migration up` applies the revoke cleanly against the local stack
- [ ] 4.2 `npm run test:integration` passes — invariant 8 still green locally
- [ ] 4.3 `npm run lint` and `npm run typecheck` pass

#### Manual

- [ ] 4.4 `npx supabase db push` applied to the cloud project
- [ ] 4.5 Cloud Query 2 re-run: `service_role` returns no rows for the nine internal tables
- [ ] 4.6 `anon` and `authenticated` grants unchanged on cloud
- [ ] 4.7 One full generation run against production succeeds end to end

### Phase 5: Cookbook, project docs, and status sync

#### Automated

- [ ] 5.1 `npm run lint` passes
- [ ] 5.2 `npm run typecheck` and `npm run typecheck:astro` pass
- [ ] 5.3 `npm test` and `npm run test:integration` both pass
- [ ] 5.4 `CLAUDE.md` and `AGENTS.md` `## Testing` / `## Conventions` sections show no divergence

#### Manual

- [ ] 5.5 §6.3 is usable without re-reading the test files
- [ ] 5.6 MAR-21 carries a comment per phase and no stale `Next:` pointer
- [ ] 5.7 `test-plan.md` §3's Phase 3 row and §5's integration row agree
