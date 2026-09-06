<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Rollout Phase 3 — Data-boundary authorization

- **Plan**: `context/changes/testing-phase-3-data-boundary/plan.md`
- **Scope**: Phases 1–5 of 5 (full slice)
- **Date**: 2026-09-06
- **Verdict**: NEEDS ATTENTION
- **Findings**: 0 critical, 3 warnings, 3 observations
- **Triage**: 2026-09-06 — 5 fixed, 1 accepted; 0 pending

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | WARNING |
| Scope Discipline | PASS |
| Safety & Quality | WARNING |
| Architecture | WARNING |
| Pattern Consistency | WARNING |
| Success Criteria | WARNING |

## Verification

| Command / check | Result |
|-----------------|--------|
| `npm run lint` | PASS |
| `npm run typecheck` | PASS |
| `npm run typecheck:astro` | PASS — 0 errors; 5 deprecation hints |
| `npm test` | PASS — 99 tests |
| `npx supabase migration up` | PASS — no pending migrations |
| `npm run test:integration` (first run) | PASS — 83 tests |
| `npm run test:integration` (immediate second run) | PASS — 83 tests; cleanup guard stayed green |
| `CLAUDE.md` vs `AGENTS.md`, `## Testing` + `## Conventions` | PASS — identical |

## Findings

### F1 — `service_role` invariant preserves the pre-migration contract

- **Severity**: ⚠️ WARNING
- **Impact**: 🔬 HIGH — architectural stakes; think carefully before deciding
- **Dimension**: Architecture
- **Location**: `src/test/authorization-invariants.int.test.ts:367`
- **Detail**: Phase 4 executes `REVOKE ALL` on every internal table and the project convention now requires internal tables to grant `service_role` no direct table privilege. Invariant 8 still filters only `SELECT/INSERT/UPDATE/DELETE` and explicitly tolerates `MAINTAIN/REFERENCES/TRIGGER/TRUNCATE`. After the migration those privileges are no longer expected. More importantly, when a future internal table is added to the roster but its migration forgets `service_role`, local defaults give only `Dxtm`, so every invariant passes locally while cloud defaults recreate the full-DML divergence this slice was meant to prevent. The repair text in invariants 1 and 4 also still omits `service_role` (`:248-251`, `:302-307`).
- **Fix ⭐ Recommended**: Compare all effective privileges for each `INTERNAL` table with `[]`, then update the invariant messages and §6.3/§6.6 documentation to state the post-migration zero-privilege contract.
  - Strength: Enforces the actual Phase 4 migration and makes a forgotten `service_role` revoke visible locally through the `Dxtm` signal.
  - Tradeoff: The roster must explicitly model any future intentional direct privilege exception.
  - Confidence: HIGH — the migration already removes all privileges locally and both current integration runs are green.
  - Blind spot: This still verifies the local catalog; the cloud correction remains dependent on the recorded deployment pass.
- **Decision**: FIXED — invariant 8 now compares ALL effective privileges for each INTERNAL table with `[]` and is renamed accordingly; `DML_PRIVILEGES` removed as dead. Repair text in invariants 1 and 4 now names `service_role` in the revoke list. `test-plan.md` §6.3 (catalog-layer table) and §6.6 (Phase 3, `Dxtm` bullet) restated to the post-migration zero-privilege contract. Verified non-vacuous: all nine internal tables read `(none)` for `service_role` locally while the three client-readable tables still hold their verbs.

### F2 — Default-ACL invariant passes when the required rows disappear

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Plan Adherence
- **Location**: `src/test/authorization-invariants.int.test.ts:397`
- **Detail**: The plan and failure message say invariant 9 proves that the schema-wide `anon` default-privilege revoke for tables, sequences, and functions remains intact. The implementation only filters existing rows whose ACL text contains `anon=` and expects none. Deleting the relevant `pg_default_acl` rows therefore passes. For functions, a missing explicit default ACL falls back to PostgreSQL's built-in EXECUTE-to-PUBLIC behavior—the exact implicit exposure the file warns about.
- **Fix**: Assert that the required `postgres`/`public` object-type rows (`r`, `S`, `f`) exist and encode the intended effective defaults, in addition to asserting that none grants `anon`.
  - Strength: Makes removal of the schema-wide revoke fail by name and matches the stated Phase 1 contract.
  - Tradeoff: Pins this assertion to the local Supabase default-ACL shape, so version-driven changes need deliberate review.
  - Confidence: HIGH — removing all matching rows currently makes `mentioningAnon` remain `[]` by construction.
  - Blind spot: Cloud defaults deliberately differ and still require the dated manual pass described in the plan.
- **Decision**: FIXED — invariant 9 now asserts the three `pg_default_acl` object-type rows (`r`, `S`, `f`) for grantor `postgres` exist before asserting their content, so deleting them fails by name; the content check also now catches a grantee-less (PUBLIC) entry, not only `anon=`. Object types are sorted in JS because the query's `order by` applies the database collation.

### F3 — Cache cleanup failure can leak the second synthetic account

- **Severity**: ⚠️ WARNING
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: `src/pages/api/summaries/generate.db.int.test.ts:243`
- **Detail**: `withTwoAccounts` protects account A from an exception while disposing B, but `cleanupCaches(youtubeId)` and `accountB.dispose()` are sequential inside the same `finally`. If cache cleanup throws, B is never disposed and the next run can fail its stale-account guard. This weakens the cleanup contract the helper's own comment claims to provide.
- **Fix**: Nest `accountB.dispose([youtubeId])` in a `finally` around `cleanupCaches(youtubeId)`, keeping the existing outer `finally` for account A.
- **Decision**: FIXED — `cleanupCaches(youtubeId)` is wrapped in a `try` whose `finally` disposes account B, preserving the existing ordering and the outer `finally` for account A; the helper's docstring records why. `withTwoSeededAccounts` in `cross-account-policy.int.test.ts` was checked and needed no change (it runs no cache cleanup).

### F4 — Cookbook calls `graphql_public` empty while allowing one function

- **Severity**: 👁️ OBSERVATION
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: `context/foundation/test-plan.md:234`
- **Detail**: The cookbook summary says invariant 9 proves “`graphql_public` is empty”, while the test and the same document later require zero relations plus exactly the `graphql(...)` function (`:255`, `:305`). The short-form rule is literally inconsistent with its oracle.
- **Fix**: Replace “is empty” with “has zero relations and exactly the expected `graphql(...)` function”.
- **Decision**: FIXED — `test-plan.md` §6.3 short form and the later `graphql_public` bullet now say "zero relations and exactly the expected `graphql(...)` function". The identical claim in invariant 9's own test name was corrected in the same pass.

### F5 — Embed test overstates the distinct regression it catches

- **Severity**: 👁️ OBSERVATION
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: `src/test/cross-account-policy.int.test.ts:268`
- **Detail**: The assertion message and cookbook say the production embed catches a `videos` SELECT-policy regression that summaries-only probes cannot. The composite ownership foreign key means B's visible summary can only reference B's video, so broadening only the `videos` policy does not change this expected result; the earlier unfiltered `videos` probe catches that regression. The test remains valuable as a production query-shape check, but it is not an independent second-policy leak oracle as documented.
- **Fix**: Keep the test and reframe its message/cookbook entry as a production embed-shape regression check; remove the unsupported claim that it independently detects a broadened `videos` policy.
- **Decision**: FIXED — the embed probe's assertion message and the §6.3 cookbook entry now frame it as a production query-shape regression check and state explicitly that it is not an independent oracle for a broadened `videos` policy, pointing at the unfiltered `videos` probe instead. The test itself is unchanged.

### F6 — Several completed manual criteria have no reviewable artifact

- **Severity**: 👁️ OBSERVATION
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Success Criteria
- **Location**: `context/changes/testing-phase-3-data-boundary/plan.md:810`
- **Detail**: Phase 2's Studio/row-count checks, Phase 3's budget/cache checks, Phase 4's post-push cloud queries and production generation, and Phase 5's Linear check are marked complete with SHAs but have no retained result or link in the diff. The two fresh integration runs independently support local cleanup, and the Phase 1 cloud pass is documented well, but the remaining external/manual claims cannot be re-verified from this slice.
- **Fix**: Add a compact, identifier-free verification record (including the Linear issue link/comment references) for the manual checks that depend on cloud, Studio, production, or Linear.
  - Strength: Turns completed checkboxes into auditable evidence without exposing account identifiers.
  - Tradeoff: Adds maintenance overhead for one-off operational verification.
  - Confidence: HIGH — no such evidence artifact is present in `2772302..HEAD` beyond the checkbox text itself.
  - Blind spot: The actions may have been performed successfully; this finding concerns retained evidence, not their truth.
- **Decision**: ACCEPTED — risk accepted by the user. The gap concerns retained evidence for manual criteria that depend on cloud, Studio, production, or Linear, not whether those checks were performed; the slice is closing out and backfilling the record was judged not worth the maintenance overhead.
