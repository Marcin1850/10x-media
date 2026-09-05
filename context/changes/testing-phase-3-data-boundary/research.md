---
date: 2026-09-05T11:15:45Z
researcher: Marcin Drobiecki
git_commit: 277230243b460bd7ad98aa312f766f9445ee182c
branch: master
repository: 10x-media
topic: "Rollout Phase 3 — data-boundary authorization (test-plan risk #4)"
tags: [research, codebase, rls, supabase, migrations, authorization, integration-tests]
status: complete
last_updated: 2026-09-05
last_updated_by: Marcin Drobiecki
---

# Research: Rollout Phase 3 — data-boundary authorization (test-plan risk #4)

**Date**: 2026-09-05T11:15:45Z
**Researcher**: Marcin Drobiecki
**Git Commit**: `2772302`
**Branch**: `master`
**Repository**: 10x-media

## Research Question

Ground rollout Phase 3 of `context/foundation/test-plan.md` — risk #4, "one account's summaries or
transcripts become reachable by another". Enumerate every table, which have RLS enabled, which policies
exist per table and per role, what table-level grants and default privileges apply (especially to tables
added after the schema-wide `anon` revoke), and how the app reaches the user-agnostic caches versus the
per-user tables. Verify or correct the response guidance, locate existing tests, identify the cheapest
useful test layer, and flag speculative risks or misleading hot-spot evidence.

## Summary

**Six findings, in the order they should change the plan.**

1. **The "must challenge" assumption in §2 does not hold — and it resolves in the schema's favour.**
   The guidance says to challenge "that per-user policies on the two original domain tables cover the
   user-agnostic shared tables added later by S-07 and S-09." No such coverage is claimed or relied on.
   Every shared table added after 2026-07-14 carries `enable row level security` **plus** an explicit
   `revoke all ... from public, anon, authenticated` and **zero policies** — a deny-by-privilege default
   that is strictly stronger than an owner-scoped policy. Verified live against the running local stack:
   an `authenticated` session gets `42501 insufficient_privilege` on all nine internal tables, and RLS is
   never even consulted. The shared caches are not the hole.

2. **The whole client-reachable surface is three tables and zero functions.** From an `authenticated`
   PostgREST session the reachable objects are exactly `summaries` (SELECT, DELETE), `videos` (SELECT,
   DELETE) and `user_credits` (SELECT) — every one gated by an owner-scoped `auth.uid() = user_id`
   policy — and **no function in `public` is executable by `anon` or `authenticated`** (the last three
   client-callable RPCs were dropped in `20260724120000_drop_legacy_rpcs.sql`). `anon` holds nothing at
   all. That makes risk #4's behavioural half small, fully enumerable, and cheap to pin.

3. **The real live failure mode is a *future* migration, and it already happened once — one day ago.**
   `20260904130000_test_support_grants.sql` granted `service_role` direct SELECT/DELETE on
   `transcript_cache`, `metadata_cache`, `credit_reservations` and `supadata_calls` purely so the Phase 2
   harness could bypass their `SECURITY DEFINER` RPCs. It shipped in `d8f37f1` and was reverted in
   `e0fdb0d` (2026-09-05) by **human impl-review, not by any test**. Risk #4 is live — but its shape is
   "the next migration forgets or over-grants", not "the current tables leak".

4. **The default-privilege half of the risk is NOT reproducible behaviourally on the local stack.**
   Locally, `alter default privileges for role postgres in schema public` gives `authenticated` only
   `Dxtm` (TRUNCATE/REFERENCES/TRIGGER/MAINTAIN) — **no DML**. On the cloud project it grants `ALL`
   (verified on prod 2026-07-14, `20260714140000_assert_least_privilege_functions.sql:8-16`; only the
   `anon` half was revoked schema-wide, deliberately). So a two-session probe against an untightened new
   table would return `42501` locally and would still be wide open in production. **A behavioural test
   cannot cover this half.** It must be a catalog invariant — and that *is* detectable locally, because a
   forgotten revoke leaves a visible `authenticated=Dxtm` ACL entry while a tightened table has no
   `authenticated` entry at all. Empirically confirmed with a rolled-back `create table` probe.

5. **The anti-pattern warning is right, and sharper than written.** `listSummaries(supabase, userId)`
   applies `.eq("user_id", userId)` **on top of** RLS, and both call sites pass the id
   (`src/pages/summaries.astro:25`, `src/pages/api/summaries/index.ts:34`). Driving the endpoint therefore
   proves nothing about the policy — the filter would mask a policy regression. This exact caveat was
   already recorded against the one prior cross-account check
   (`context/changes/browse-summary-list/reviews/manual-verification-phase-1.md:67-75`). The policy probe
   must issue an **unfiltered** select through a real user session.

6. **The hot-spot evidence is stale.** §2 cites `supabase/migrations/` at 28 commits/30d. As of today the
   trailing 30 days hold **4** commits touching that directory (33 over 90 days); the burst was late July.
   The risk still stands — on the PRD guardrail, the structural default-privilege mechanism, and finding
   #3 — but not on current churn.

**Cheapest useful layer**: two new integration files, plus one boundary case. A **catalog-invariant test**
(no accounts, no HTTP, ~50ms) is the only thing that can catch the "new table" half, and it also pins every
grant and policy in one place. A **two-account policy probe** (two synthetic accounts, rows seeded through
the owner connection, unfiltered selects through the app's own client) covers the behavioural half without
touching the paid path at all — no transcript, no LLM, so §7 is satisfied by construction. Details in §7
below.

## Detailed Findings

### 1. Complete table inventory — live state of the local stack (2026-09-05)

Queried from `pg_class` / `pg_policies` / `relacl` on `supabase_db_10x-media`. `Dxtm` = TRUNCATE,
REFERENCES, TRIGGER, MAINTAIN (the local `postgres` default privileges); it contains no DML.

| Table | Created by | RLS | Policies | `anon` | `authenticated` | `service_role` |
|---|---|---|---|---|---|---|
| `videos` | `20260613145120_videos_and_summaries.sql:4` | on | 2 — SELECT, DELETE | ∅ | SELECT, DELETE | ALL |
| `summaries` | `20260613145120_videos_and_summaries.sql:34` | on | 2 — SELECT, DELETE | ∅ | SELECT, DELETE | ALL |
| `user_credits` | `20260712175240_user_credits.sql:5` | on | 1 — SELECT | ∅ | SELECT | ALL |
| `generation_locks` | `20260720133000_generation_locks.sql:16` | on | **0** | ∅ | ∅ | `Dxtm` |
| `credit_reservations` | `20260720160000_credit_reservations.sql:22` | on | **0** | ∅ | ∅ | `Dxtm` |
| `transcript_fetch_attempts` | `20260722130000_transcript_spend_guards.sql:17` | on | **0** | ∅ | ∅ | `Dxtm` |
| `transcript_quotes` | `20260722130000_transcript_spend_guards.sql:77` | on | **0** | ∅ | ∅ | `Dxtm` |
| `transcript_cache` | `20260728120000_generation_telemetry.sql:58` | on | **0** | ∅ | ∅ | `Dxtm` |
| `supadata_calls` | `20260728120000_generation_telemetry.sql:95` | on | **0** | ∅ | ∅ | `Dxtm` |
| `metadata_cache` | `20260731120000_metadata_cache.sql:45` | on | **0** | ∅ | ∅ | `Dxtm` |
| `supadata_budget` | `20260731150000_supadata_budget.sql:52` | on | **0** | ∅ | ∅ | `Dxtm` |
| `supadata_reservations` | `20260731150000_supadata_budget.sql:155` | on | **0** | ∅ | ∅ | `Dxtm` |

Twelve tables, all with RLS enabled, none with `FORCE ROW LEVEL SECURITY`, all owned by `postgres`.

**Precision note for the test oracle.** `test-plan.md` §6.2 says the four shared tables "deliberately
grant `service_role` no direct table privileges". That is true of DML only — `service_role` does hold
`Dxtm` on all nine internal tables, inherited from the local defaults, and `TRUNCATE` is a table-level
privilege RLS does not filter (the same argument `20260714101500_assert_least_privilege.sql:8-13` makes
for the client roles). An invariant asserting "`service_role` has zero privileges on `transcript_cache`"
would go red today. The invariant that matters is about `anon` and `authenticated`; `service_role` also
carries `rolbypassrls = true`, so its ACL is not a boundary in any case.

### 2. The three client-reachable policies (all owner-scoped, all SELECT/DELETE)

```
public.summaries    | summaries_select_authenticated    | SELECT | roles=authenticated | using=(auth.uid() = user_id)
public.summaries    | summaries_delete_authenticated    | DELETE | roles=authenticated | using=(auth.uid() = user_id)
public.videos       | videos_select_authenticated       | SELECT | roles=authenticated | using=(auth.uid() = user_id)
public.videos       | videos_delete_authenticated       | DELETE | roles=authenticated | using=(auth.uid() = user_id)
public.user_credits | user_credits_select_authenticated | SELECT | roles=authenticated | using=(auth.uid() = user_id)
```

The INSERT/UPDATE policies from `20260613145120` are gone: dropped for `videos` in
`20260726120000_videos_single_writer.sql:36-37` and for `summaries` in
`20260731130000_summaries_single_writer.sql:38-39`, each alongside a revoke-then-grant that leaves
`authenticated` with `select, delete` only. Both migrations state the motive was **provenance**, not
isolation — `20260726120000_videos_single_writer.sql:11` and `20260731130000_summaries_single_writer.sql:9`
both say "Cross-user isolation was never at risk (the policies are owner-scoped); provenance was."
`user_credits` never had a write policy (`20260712175240_user_credits.sql:13-19`).

**Live behavioural verification** (rolled-back transaction, two synthetic users, `set local role
authenticated` + `request.jwt.claims`; the local DB holds zero real users, so nothing real was touched):

```
A sees summaries: A-secret                   -- B-secret filtered out
A sees videos: probeA                        -- probeB filtered out
A sees credit rows: 1
A embed videos via summaries: probeA         -- the PostgREST embed shape is filtered too
```

The policies work. This is the shape the Phase 3 behavioural test must assert — and the run above is a
working prototype of the oracle.

### 3. The internal tables are closed at the privilege layer, not the policy layer

Same session, same transaction:

```
transcript_cache    -> denied (42501)      supadata_budget           -> denied (42501)
metadata_cache      -> denied (42501)      supadata_reservations     -> denied (42501)
supadata_calls      -> denied (42501)      generation_locks          -> denied (42501)
credit_reservations -> denied (42501)      transcript_quotes         -> denied (42501)
                                           transcript_fetch_attempts -> denied (42501)
rpc get_transcript_cache -> denied (42501)
```

And `anon`, probed over real HTTP through PostgREST with the local anon key, gets `401` /
`42501 permission denied` on all eight tables tried — `summaries`, `videos`, `user_credits`,
`transcript_cache`, `metadata_cache`, `supadata_calls`, `credit_reservations`, `supadata_budget`.

Each of those tables documents the intent in its own migration.
`20260728120000_generation_telemetry.sql:81-84`:

> `-- RLS on with no policies, matching generation_locks / transcript_quotes: definer/service-role-only`
> `-- by construction. A client that could write here could forge a transcript into another user's summary.`

`20260728120000_generation_telemetry.sql:69-72` also records *why* the caches carry no owner column:

> `'Shared, user-agnostic transcript cache. One row per YouTube video, overwritten on refresh — never per-user, because a per-user row would cascade away on account deletion and take a transcript other users depend on with it. Holds public third-party content only, no personal data.'`

That last clause matters for scoping the risk: risk #4 names "summaries **or transcripts**", but the
transcript cache holds public third-party content keyed by `youtube_id` with no personal data and no
owner. Cross-account *reachability* of the cache is not a privacy breach in the PRD's terms; the breach
would be a client reaching it at all (forging a transcript into someone's summary), which is what the
privilege revoke closes.

### 4. The function surface: nothing is client-callable

All 24 `public` functions are `SECURITY DEFINER` and every ACL is `postgres=X, service_role=X` (plus
`handle_new_user_credits`, which is `postgres=X` only — trigger-fired, `20260714140000:28-31`). **No
function grants EXECUTE to `anon` or `authenticated`.** The three that once did —
`spend_credit()`, `spend_credits(integer)`, `reserve_credits(integer)` — were dropped wholesale in
`20260724120000_drop_legacy_rpcs.sql:15-20` as the contract half of S-01's expand/contract chain.

This closes a surface the risk statement does not mention: a `SECURITY DEFINER` function granted to
`authenticated` runs as the owner and bypasses RLS entirely, so one taking a `user_id` parameter would be
a direct cross-account read. `20260714140000_assert_least_privilege_functions.sql:18-22` calls out exactly
that blast radius for `spend_credit`. Today the surface is empty — which is itself worth pinning, since
"add an RPC for the client" is a natural future change.

### 5. Default privileges — the actual mechanism behind risk #4

Live `pg_default_acl`, the rows that matter:

```
postgres | schema=public | objtype=r | acl=postgres=arwdDxtm/postgres , authenticated=Dxtm/postgres , service_role=Dxtm/postgres
postgres | schema=public | objtype=f | acl=postgres=X/postgres
```

`anon` is absent from all three object types — that is
`20260714140000_assert_least_privilege_functions.sql:41-43` doing its job. `authenticated` is deliberately
left, and the migration says why (lines 36-40):

> `-- Scoped to 'anon' and to 'for role postgres' (the role migrations run as) on purpose. 'authenticated'`
> `-- defaults are deliberately NOT touched: new tables landing with authenticated CRUD is the shape this`
> `-- app's RLS design already assumes, and revoking it schema-wide would break future migrations that`
> `-- rely on it without re-granting. Per-table tightening stays each feature's job, as user_credits did.`

The roadmap records the same decision (`context/foundation/roadmap.md:175`):

> "the push revealed that cloud default privileges grant `ALL` on new tables to `anon`/`authenticated`;
> `20260714140000` revoked the `anon` half schema-wide, but `authenticated` still gets CRUD on any new
> table by default — tighten per-table as `user_credits` does."

**So the guard against risk #4 is per-migration discipline, by design.** Every table added since has
honoured it (§1). Nothing enforces it.

**And the environments diverge.** `20260714140000:8-16` records that the cloud defaults grant `ALL` while
the local ones do not — the same migration's header calls the local-only check that missed it "LOCAL ONLY"
and names the cloud grant it found (`GRANT ALL ON FUNCTION "public"."spend_credit"() TO "anon"`). Confirmed
today by creating and rolling back a probe table in the local stack:

```
PROBE relacl :: postgres=arwdDxtm/postgres | authenticated=Dxtm/postgres | service_role=Dxtm/postgres
PROBE rls    :: false
```

A new local table lands with **no DML for `authenticated`** and **RLS off**. On cloud the same table lands
with `authenticated=arwdDxtm` and RLS off.

Two consequences, both load-bearing for the plan:

- A **behavioural** probe of the "new table" half is worthless: locally the untightened table denies the
  read for the wrong reason. Only a **catalog** assertion works.
- A catalog assertion *does* work locally, because the two states are distinguishable in `relacl`: a
  tightened table has **no `authenticated` entry at all** (see `transcript_cache` in §1), an untightened
  one has `authenticated=Dxtm`. The stray `Dxtm` is a faithful local proxy for "this migration never ran
  a revoke", which on cloud means full CRUD.
- RLS-off is the second signal, and it is environment-independent: every one of the twelve tables enables
  RLS explicitly, so `relrowsecurity = false` on a `public` table is unambiguous drift.

### 6. How the app reaches each table

Two client constructors, one seam each:

- `src/lib/supabase.ts:5` — `createClient(requestHeaders, cookies)`, the anon/SSR cookie client. Runs as
  `authenticated` when a session cookie is present. **RLS applies.**
- `src/lib/supabase-admin.ts:14` — `createAdminClient()`, service-role. **RLS bypassed.** Null-guarded at
  both call sites (`src/pages/api/account/delete.ts:39-42`, `src/pages/api/summaries/generate.ts:119-122`),
  each returning `503` before any DB work.

**The anon/SSR client (RLS-scoped) touches exactly three things**: `auth.users` via `.auth.*`,
`user_credits` via `getBalance` (`src/lib/services/credits.ts:30`, `src/middleware.ts:29`), and
`summaries` + embedded `videos` via `listSummaries` (`src/lib/services/summary-list.ts:58`). **It never
touches a user-agnostic cache table.**

**Every internal table is reached only through `SECURITY DEFINER` RPCs on the admin client** — no
`.from(<internal table>)` exists anywhere in `src/` or `scripts/`:

| Table | RPCs | Wrapper |
|---|---|---|
| `transcript_cache` | `get_transcript_cache`, `save_transcript_cache` | `src/lib/services/transcript-cache.ts:97,201` |
| `metadata_cache` | `get_metadata_cache`, `save_metadata_cache` | `src/lib/services/metadata-cache.ts:55,119` |
| `supadata_calls` | `record_supadata_calls` | `src/lib/services/supadata-ledger.ts:174` |
| `credit_reservations` | `begin_generation`, `charge_failed_transcript`, `get_refusal_replay`, `refund_reservation` | `src/lib/services/credits.ts:108,277,348,402` |
| `generation_locks` | `acquire_generation_lease`, `release_generation_lease` | `src/lib/services/generation-lock.ts:29,55` |
| `transcript_quotes` / `transcript_fetch_attempts` | `get/save/discard_transcript_quote`, `record_transcript_attempt` | `src/lib/services/transcript-guard.ts:42,74,141,179` |
| `supadata_budget` / `supadata_reservations` | `reserve_supadata_credits`, `save_supadata_budget`, `settle_supadata_reservation` | `src/lib/services/supadata-budget.ts:267,395,579` |
| `videos` + `summaries` (writes) | `persist_summary` | `src/lib/services/summaries.ts:309` |

**No endpoint accepts a user id from the request.** `POST /api/summaries/generate`, `GET /api/summaries`
and `POST /api/account/delete` all take the id from `context.locals.user`, resolved in
`src/middleware.ts:13` from the session cookie.

**One RLS-bypassing read by id, and it is the residual worth a test.** `readStoredSummary`
(`src/lib/services/summaries.ts:388-391`) does
`admin.from("summaries").select("content, model").eq("id", summaryId)` with **no `user_id` predicate** —
the only place a summary row is read with RLS off and no owner filter. It is reached only from the
`already_persisted` replay branch (`src/pages/api/summaries/generate.ts:987`), and the `summaryId` is
server-derived: `begin_generation` looks the reservation up as
`where cr.user_id = target_user and cr.request_id = request`
(`20260723130000_idempotent_generation.sql:127-128`) and then the summary as
`where s.reservation_id = existing.id and s.user_id = target_user` (line 144) — double-scoped, with
`target_user` coming from the session. Safe today. But it is the one place where **application code, not
RLS, is the boundary**, so it deserves one boundary test rather than an argument.

### 7. Cheapest useful test layer

Three pieces, in descending value per unit of cost. Together they fill `test-plan.md` §6.3.

**(A) Catalog-invariant test — new, and the highest-value item.** A single `*.int.test.ts` that reads
`pg_class` / `pg_policy` / `pg_proc` / `pg_default_acl` through `getDbOwnerConnection()`
(`src/test/db-owner.ts:22`). No accounts, no HTTP, no cleanup, tens of milliseconds. Asserts:

1. Every table in `public` has `relrowsecurity = true`.
2. `anon` holds **no** privilege on any table in `public`, and EXECUTE on no function in `public`.
3. `authenticated`'s privilege set on every table matches an **explicit allow-list**: `{SELECT, DELETE}`
   for `videos` and `summaries`, `{SELECT}` for `user_credits`, **∅ for everything else**. A stray `Dxtm`
   fails (§5) — that is the forgotten-revoke signal.
4. `authenticated` holds EXECUTE on no function in `public`.
5. Every verb granted to `authenticated` has a matching owner-scoped policy, and every policy's `qual` is
   `auth.uid() = user_id`.
6. `pg_default_acl` for role `postgres` in schema `public` still excludes `anon` for tables, sequences and
   functions.

The allow-list **is** the oracle, sourced from the PRD guardrail (`prd.md:36-37`, `prd.md:90-92`) and each
migration's own stated intent — not from reading the current catalog. Adding a table forces a conscious
edit to that list, which is exactly the "newly added table does not inherit blanket access" property, and
the only form of it that survives the local/cloud divergence. It would have caught
`20260904130000_test_support_grants.sql` if extended to `service_role` DML too (worth doing: assert
`service_role` holds no DML on the nine internal tables, since that is the invariant `db-owner.ts` exists
to preserve — see Open Question 2).

**(B) Two-account policy probe — new, and where the anti-pattern bites.** Two synthetic accounts; seed
`videos` + `summaries` rows for each **through `getDbOwnerConnection()`**, not through the endpoint — no
generation, no transcript, no LLM, so §7's hard rule is satisfied by construction and the test costs one
insert per row. Then, through a **real RLS-scoped session client for account B**, assert:

- `from("summaries").select("id")` with **no filter** returns only B's ids (never A's). Same for `videos`,
  same for `user_credits`.
- `from("summaries").select("*").eq("id", <A's id>)` returns empty.
- `from("summaries").delete().eq("id", <A's id>)` reports 0 rows affected **and** A's row still exists
  when read back through the owner connection. (`authenticated` really does hold DELETE, so this is a live
  verb, not a hypothetical.)
- The PostgREST embed shape used in production — `select("id, videos(youtube_id)")` — filters the embed
  too.

Assert each by its own shape, and **never** call `listSummaries`/`getBalance` with a `userId`: both apply
`.eq("user_id", …)` on top of RLS (`summary-list.ts:58`, `credits.ts:31`), which masks a policy
regression. This is precisely the caveat already recorded at
`context/changes/browse-summary-list/reviews/manual-verification-phase-1.md:67-75`.

*Harness gap to close in the plan:* `SyntheticAccount` (`src/test/synthetic-account.ts:28-44`) exposes
`userId` and `cookieHeader` but **no RLS-scoped client**. Two options, both test-only: return the
`signInClient` already built at line 80, or build one per test from the cookie header through the app's
own `createClient(new Headers({ Cookie: account.cookieHeader }), …)` (`src/lib/supabase.ts:5`). The second
keeps Phase 2's fidelity argument intact (the header round-trips through the app's real
`parseCookieHeader`) and is the better fit for a test whose subject is the trust boundary. Nothing blocks
two concurrent accounts today — the email is a fresh `crypto.randomUUID()` (line 66) and the cookie jar is
a per-call local (line 79) — but only one call site exists (`generate.db.int.test.ts:209`), so it is
unexercised. No new `RESERVED_YOUTUBE_IDS` entries are needed: this layer seeds no cache rows, and
`dispose()`'s `auth.users` cascade removes the seeded `videos`/`summaries`.

**(C) One boundary case for the RLS-bypassing replay read.** Accounts A and B both `POST
/api/summaries/generate` with the **same** `requestId` UUID, caches pre-seeded and `llm.ts` mocked (the
established real-DB recipe, `test-plan.md` §6.2). B must receive B's own generation, never A's content.
This is the only test of `readStoredSummary` (`summaries.ts:388`) as a boundary, and it exercises the
partial unique index `(user_id, request_id)` (`20260723130000:48-50`) as the thing that keeps two
accounts' identical keys apart. One test, not a group.

**Explicitly not worth it here:** an e2e; a test that creates a table to observe default-privilege
inheritance (§5 — it proves the wrong thing locally); mutation testing (there is no application code under
test — the subject is SQL DDL); and any assertion made through a `service_role` or owner connection about
what a *user* can see, since both bypass RLS by definition and would go green against a broken policy.

### 8. Existing coverage on this ground

Nine test files exist; **none** asserts cross-account isolation, role privileges, or policy behaviour.

- `src/pages/api/summaries/generate.db.int.test.ts` is the closest: it drives the endpoint as one real
  synthetic account and its header (line 14) notes "`getBalance`'s RLS-scoped read runs against the actual
  local Postgres". But its verification helper `readBalance()` (line 112) reads `user_credits` through
  the **admin** client — a bypass, not a policy assertion — and one account cannot demonstrate isolation.
- Lines 9-11 and 49-53 of that file *document* the privilege boundary on the four shared tables. No test
  asserts it.
- The only cross-account check in the repo is manual and outside `src/`:
  `context/changes/browse-summary-list/reviews/manual-verification-phase-1.md:67-75`, which disclaims
  itself — "the explicit filter would mask a policy regression … a future change to those policies is not
  covered by this row."

So Phase 3 starts from zero automated coverage, which matches `test-plan.md` §5's integration row
("authorization is still §3 Phase 3").

### 9. Speculative risks and misleading evidence

- **Hot-spot churn is stale.** §2 cites `supabase/migrations/` at 28 commits/30d. Measured today
  (2026-08-06 → 2026-09-05): **4** commits, three of them from `testing-phase-2-paid-path` and one from a
  design sweep; 33 commits over 90 days. Only four migration files changed in the window, one of which
  (`20260904130000`) was added and reverted. Recommend the Source cell drop the churn figure and cite the
  `e0fdb0d` near-miss instead — it is stronger evidence and it is current.
- **"Transcripts become reachable by another account" is not, by itself, a privacy breach.**
  `transcript_cache` is shared by design and holds public third-party content with no personal data
  (`20260728120000:69-72`; `context/changes/persist-time-and-cost/plan.md:101`). Cross-user *reuse* of a
  cached transcript is a shipped feature (roadmap S-07: "Reuse-on-regeneration is IN, cross-user"). The
  risk's real content for that table is a *client* reaching it at all — write access would let one account
  forge a transcript into another's summary. Worth rewording so the test does not chase a non-property.
- **`graphql_public` is exposed** (`supabase/config.toml:13`) and its `supabase_admin` default ACLs grant
  `anon`/`authenticated` ALL on objects created *in that schema*. pg_graphql resolves through the same
  grants and RLS on `public`, so it adds no new surface — but nothing tests it. Low priority; noted so it
  is a decision rather than an oversight.
- **`FORCE ROW LEVEL SECURITY` is off on all twelve tables.** That only matters for the owner role
  (`postgres`), which is `getDbOwnerConnection()`'s role and therefore a test-harness concern, not a
  client one. Not a finding — recorded so a future reader does not mistake it for one.

## Code References

- `supabase/migrations/20260613145120_videos_and_summaries.sql:4,16-32,34,47-63` — `videos`/`summaries`, RLS, the original four policies each
- `supabase/migrations/20260712175240_user_credits.sql:5,11,13-19` — `user_credits`, read-only-by-policy rationale
- `supabase/migrations/20260714101500_assert_least_privilege.sql:8-13,20-35` — revoke-then-grant pattern; why TRUNCATE matters
- `supabase/migrations/20260714140000_assert_least_privilege_functions.sql:8-16,36-43` — **the cloud/local default-privilege divergence, and the deliberate decision to leave `authenticated` defaults alone**
- `supabase/migrations/20260724120000_drop_legacy_rpcs.sql:15-20` — the last three client-callable RPCs removed
- `supabase/migrations/20260726120000_videos_single_writer.sql:11,25-37` — `videos` write path closed; "cross-user isolation was never at risk"
- `supabase/migrations/20260728120000_generation_telemetry.sql:58,69-72,81-84,95,120-121` — `transcript_cache`/`supadata_calls`; the "RLS on with no policies" pattern and the user-agnostic rationale
- `supabase/migrations/20260731120000_metadata_cache.sql:45,70-71` — `metadata_cache`, same pattern
- `supabase/migrations/20260731130000_summaries_single_writer.sql:9,27-39` — `summaries` write path closed
- `supabase/migrations/20260731150000_supadata_budget.sql:52,140-141,155,217-218` — budget singleton + reservations, same pattern
- `supabase/migrations/20260723130000_idempotent_generation.sql:48-50,127-128,144` — `(user_id, request_id)` partial unique index; the double-scoped replay lookup
- `src/lib/supabase.ts:5-23` — the RLS-scoped client; reads the raw `Cookie` header
- `src/lib/supabase-admin.ts:14` — service-role client, RLS bypassed
- `src/lib/services/summary-list.ts:52-58` — `listSummaries`; the `.eq("user_id", …)` that masks the policy
- `src/lib/services/credits.ts:26-38` — `getBalance`; same masking shape
- `src/lib/services/summaries.ts:379-391` — `readStoredSummary`, the one RLS-bypassing read by id
- `src/pages/api/summaries/index.ts:20,34` — `GET /api/summaries`; id from `context.locals.user`
- `src/middleware.ts:5,13,29,37-41` — session resolution, `PROTECTED_ROUTES`, the display-only balance read
- `src/test/synthetic-account.ts:28-44,66,79-102,107-124` — harness shape; no RLS-scoped client exposed
- `src/test/db-owner.ts:22-41` — loopback-validated table-owner connection (the catalog-query seam)
- `src/test/integration-setup.ts` / `src/test/fetch-firewall.ts` — `globalSetup` / `setupFiles`, inherited by the `integration` project only (`vitest.config.ts`)
- `supabase/config.toml:13` — `schemas = ["public", "graphql_public"]`

## Architecture Insights

- **The schema uses two different isolation mechanisms, and they are not interchangeable.** Per-user
  tables use *grant + owner-scoped policy*; internal tables use *revoke everything, no policy*. The second
  is strictly stronger and is the one every table added since 2026-07-14 uses. A test that only knows the
  first mechanism would look for missing policies on the caches and find "nothing", reading a deliberate
  design as a gap.
- **`SECURITY DEFINER` RPC + `service_role`-only EXECUTE is the app's real access-control layer for
  everything except the three read paths.** RLS governs what a browser session can read; the RPCs govern
  everything the paid path writes. The trust boundary for risk #4 is the intersection: three tables, five
  policies, zero client-callable functions.
- **The guard on new tables is a convention with no enforcement point.** `20260714140000` chose per-table
  tightening over a schema-wide `authenticated` revoke, for a stated reason. That choice is what turns
  risk #4 from a bug into a standing obligation — and it is exactly the kind of obligation a catalog test
  discharges better than a review checklist.
- **Test-harness needs have already applied pressure on production privileges once.** `d8f37f1` →
  `e0fdb0d` is the whole cycle in two commits. `src/test/db-owner.ts` exists because the review insisted
  the harness reach around the boundary rather than widen it. Phase 3 must not reintroduce that pressure:
  its catalog test reads `pg_catalog`, which needs no grant at all, and its policy probe uses ordinary
  user sessions.

## Historical Context (from prior changes)

- `context/foundation/roadmap.md:175` (S-05) — the origin of risk #4: cloud default privileges grant `ALL`
  on new tables to `anon`/`authenticated`; only the `anon` half was revoked schema-wide; "tighten
  per-table as `user_credits` does."
- `context/changes/summary-credits/reviews/impl-review.md:54-67,167,184-194` — the original least-privilege
  incident (F2): additive `GRANT` migrations were not deterministic, which produced both
  `20260714101500` and `20260714140000`.
- `context/changes/persist-time-and-cost/plan.md:101` — `transcript_cache` designed with **no `user_id`**:
  shared public content, must not vanish with an account deletion; RLS on with no policies.
- `context/changes/testing-phase-2-paid-path/research.md:168` — confirms `supadata_budget`,
  `supadata_reservations`, `transcript_cache`, `metadata_cache` are all "RLS enabled with **zero policies**
  plus `revoke all from public, anon, authenticated` … reachable only through `SECURITY DEFINER` RPCs".
- `context/changes/testing-phase-2-paid-path/reviews/impl-review.md` (F2) → commit `e0fdb0d` — the
  reverted `20260904130000_test_support_grants.sql`; the live precedent for how this risk actually
  materialises.
- `context/changes/browse-summary-list/reviews/manual-verification-phase-1.md:67-75` — the only prior
  cross-account check, manual, and self-disclaiming about the masking filter.
- `context/foundation/prd.md:36-37, 70-73, 90-92` — the guardrail this phase protects: "summaries and video
  list visible only to the logged-in user"; "each user sees only their own data … Structure prepared for
  opening registration in the future."

## Related Research

- `context/changes/testing-phase-2-paid-path/research.md` — the integration harness this phase extends
  (`synthetic-account.ts`, `db-owner.ts`, `integration-setup.ts`, `fetch-firewall.ts`); §5 there covers the
  `supadata_calls` cleanup ordering that `dispose()` implements.
- `context/changes/testing-phase-1-bootstrap/research.md` — the `astro:env/server` and `@/*` alias
  constraints that make endpoint-level integration tests reachable at all.

## Open Questions

1. **Does the cloud project's `pg_default_acl` still grant `authenticated` `ALL` on new tables?** Last
   verified 2026-07-14 (`20260714140000:8-16`). The local stack cannot answer this and CI must not hold
   production credentials, so the catalog test can only pin the *local* default. Options: accept the gap
   and rely on the per-table allow-list (which is environment-independent), or add a one-off manual
   production read recorded in the change folder. Recommend the former plus a note; the allow-list catches
   the failure in either environment.
2. **Should the catalog invariant also cover `service_role` DML on the nine internal tables?** It would
   have caught `20260904130000`. Argues yes; the counter-argument is that `service_role` bypasses RLS
   anyway, so the assertion protects a defence-in-depth property rather than the PRD guardrail. Worth a
   decision at plan time rather than a silent inclusion.
3. **Should §2's risk #4 wording separate "summaries" from "transcripts"?** The two have different
   properties (§9). If yes, this is a `--refresh`/backport question for `/10x-test-plan`, not a plan
   question.
4. **Does the catalog test belong in the `integration` project or its own?** It needs
   `getDbOwnerConnection()` and therefore the loopback guard, so `integration` is the natural home — but it
   needs neither the `fetch` firewall nor a synthetic account, and it is two orders of magnitude faster
   than the rest of that suite. Recommend `integration` for the guard alone; noted so the plan states it
   deliberately.
