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
only, the cloud value is recorded in `docs/cloud-default-privileges.md`, and assertions 1 and 4 are the
environment-independent guard that makes that gap tolerable.

#### 2. The cloud divergence record

**File**: `context/changes/testing-phase-3-data-boundary/docs/cloud-default-privileges.md` (new)

**Intent**: Re-verify and date the 2026-07-14 claim that the cloud project's default privileges grant
`authenticated` `ALL` on new tables — the fact the entire risk framing rests on — and confirm the cloud
project's per-table ACLs match the roster Phase 1 commits.

**Contract**: Two read-only queries run by hand in the cloud project's SQL editor, with their verbatim
output, the date, and a one-line verdict against `20260714140000:8-16`. Per `lessons.md` ("Never commit
account identifiers from a real-environment pass"), the record carries **no** email, `user_id`, token or
key — roles and privileges only. Queries:

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

- The two queries above are run against the cloud project and their output recorded in
  `docs/cloud-default-privileges.md`, with the date and the verdict against `20260714140000:8-16`
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

## Phase 4: Cookbook, project docs, and status sync

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

**Intent**: Reflect that Phase 3 shipped, and record what it taught so Phase 4 does not rediscover it.

**Contract**: §3's Phase 3 row Status → `complete`. §5's integration row drops "authorization is still §3
Phase 3". A §6.6 "Phase 3" block records: the `Dxtm`-per-role asymmetry; that `pg_catalog` reads need no
grant, which is why this phase applied no privilege pressure; the `graphql_public` finding (zero
relations, one non-extension-owned function); and the roster's maintenance contract. §8 gains a dated
entry.

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
`src/test/authorization-invariants.int.test.ts`'s roster or the integration suite fails.

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
2. **Run the cloud queries** from Phase 1 and record their output, stripped of account identifiers.
3. **Run `npm run test:integration` twice in a row.** The second run passing is the cleanup assertion.
4. **Check Supabase Studio's Auth panel** for surviving `synthetic-db-int-` accounts.

## Performance Considerations

The catalog test adds tens of milliseconds. The policy probe adds two account create/sign-in/delete
cycles (~1-2s). The replay case adds one more account and one more endpoint round-trip to a file that
already runs several. The `integration` CI job's wall time is dominated by `supabase start`, so the
relative cost is negligible.

## Migration Notes

No migration. This phase deliberately adds no SQL — its whole argument is that test-harness needs must
not apply pressure on production privileges (`d8f37f1` → `e0fdb0d`), and `pg_catalog` reads need no
grant.

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

- [x] 1.1 `npm run test:integration` passes with the new file green
- [x] 1.2 `npm run lint` passes
- [x] 1.3 `npm run typecheck` passes
- [x] 1.4 A dropped roster entry makes assertion 1 fail naming the table (reverted)
- [x] 1.5 A temporary `grant select on transcript_cache to authenticated` makes assertion 4 fail (reverted)

#### Manual

- [ ] 1.6 Cloud default-privilege and per-table-grant queries run and recorded in `docs/cloud-default-privileges.md` with date and verdict
- [ ] 1.7 The record contains no account identifiers
- [ ] 1.8 Any divergence between cloud grants and the roster reported before Phase 2 starts

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

### Phase 4: Cookbook, project docs, and status sync

#### Automated

- [ ] 4.1 `npm run lint` passes
- [ ] 4.2 `npm run typecheck` and `npm run typecheck:astro` pass
- [ ] 4.3 `npm test` and `npm run test:integration` both pass
- [ ] 4.4 `CLAUDE.md` and `AGENTS.md` `## Testing` / `## Conventions` sections show no divergence

#### Manual

- [ ] 4.5 §6.3 is usable without re-reading the test files
- [ ] 4.6 MAR-21 carries a comment per phase and no stale `Next:` pointer
- [ ] 4.7 `test-plan.md` §3's Phase 3 row and §5's integration row agree
