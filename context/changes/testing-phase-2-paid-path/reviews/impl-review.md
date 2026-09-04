<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Paid-path integration tests

- **Plan**: `context/changes/testing-phase-2-paid-path/plan.md`
- **Scope**: Phases 1-6 of 6 (full slice)
- **Date**: 2026-09-05
- **Verdict**: REJECTED at review → **APPROVED after triage** (all 10 findings fixed; see per-finding `Decision` fields)
- **Findings**: 1 critical, 8 warnings, 1 observation — **10 fixed, 0 skipped, 0 accepted**

## Verdicts

| Dimension | At review | After triage |
|-----------|-----------|--------------|
| Plan Adherence | FAIL | PASS — F4 oracle resolved from the RPC contract, F7 contract completed, F8 wiring proven end-to-end |
| Scope Discipline | FAIL | PASS — F2 production grants removed; the one production change that remains (F4) was a deliberate, reviewed decision |
| Safety & Quality | FAIL | PASS — F1 fetch firewall, F3 cleanup propagation, F10 loopback coverage |
| Architecture | FAIL | PASS — test harness reaches definer-only tables via a table-owner connection instead of widening `service_role` |
| Pattern Consistency | WARNING | PASS — F9 project pinning |
| Success Criteria | FAIL | PASS — F5 cookbook corrected, F6 fail-open branches covered |

## Post-triage verification (2026-09-05)

| Check | Result |
|---|---|
| `npm test` | PASS — 4 files, 99 tests |
| `npm run test:integration` | PASS — 5 files, **63 tests** (was 51) |
| `npm run lint` | PASS |
| `npm run typecheck` | PASS |
| `npm run typecheck:astro` | PASS — 0 errors, 0 warnings, 5 pre-existing hints |
| `npx prettier --check .` | PASS |
| Local residue after the full run | PASS — 0 rows in `transcript_cache`, `metadata_cache`, `supadata_calls`; 0 synthetic accounts; 0 `reserved` reservations; `supadata_budget` untouched (nulls) |

**One production behavior change was made during triage** (F4, explicitly decided by the user): `generate.ts` now reads the persisted row back on the `already_persisted` path so the 200 body is internally coherent. The plan's original "no production code changes" boundary was relaxed for this one case because the plan's own oracle was wrong and the test could not be made honest without it.

## Verification

| Check | Result |
|---|---|
| `npm test` | PASS - 4 files, 99 tests |
| `npm run test:integration` | PASS - 5 files, 51 tests; vendor keys explicitly overridden with placeholders for review safety |
| `npm run lint` | PASS |
| `npm run typecheck` | PASS |
| `npm run typecheck:astro` | PASS - 0 errors; 5 pre-existing deprecation hints |
| Prettier | PASS via non-mutating `npx prettier --check .` |
| `npx supabase migration up` | PASS - no pending migrations |
| Non-loopback guard | PASS - integration global setup aborted before connection for `https://production-project.supabase.co` |
| Local cleanup residue after reviewed run | PASS for the current scenarios - 0 reserved cache rows, synthetic accounts, or `supadata_calls` rows |
| CI/PR and Linear MAR-20 | Not independently re-verified; completion is recorded in plan commit `7c0357f`, but no connector evidence was available in this review |

## Findings

### F1 - Real-database tests can escape to paid vendors

- **Severity**: CRITICAL
- **Impact**: HIGH - architectural stakes; think carefully before deciding
- **Dimension**: Safety & Quality
- **Location**: `package.json:18`; `src/pages/api/summaries/generate.db.int.test.ts:18`
- **Detail**: The local integration script automatically loads `.env`, and this review confirmed (without printing values) that it contains both vendor keys. The real-database tests do not install a `fetch` firewall or Supadata stub; they rely on seeded cache hits to keep execution away from the paid boundary. A regression in cache lookup, TTL, language matching, or cleanup can therefore make a real Supadata request before the assertion fails. `test:coverage` and `test:watch` also select the integration project by default. This violates the locked rule that no test ever contacts a live transcript provider or LLM. The shared fixture URL additionally uses a real YouTube ID (`dQw4w9WgXcQ`), increasing the consequence of an escaped request.
- **Fix**: Install an integration-worker `fetch` firewall that permits loopback Supabase traffic and rejects every non-loopback request unless a test replaces `fetch` with its explicit fixture; force placeholder vendor keys in every integration entry point and replace the real YouTube ID with a synthetic 11-character ID.
  - Strength: Makes the paid-boundary rule fail closed even when the behavior under test regresses.
  - Tradeoff: Requires a shared `setupFiles` layer and explicit opt-in for every HTTP fixture.
  - Confidence: HIGH - the unsafe path and real-key presence were both verified locally; the integration suite passed with placeholders.
  - Blind spot: The firewall must be designed so stub-layer `vi.stubGlobal("fetch", ...)` tests restore to the firewall, not to the native fetch.
- **Decision**: FIXED — added `src/test/fetch-firewall.ts` (setupFile on the integration project) installing a `beforeEach`/`afterEach` fetch guard that only permits loopback traffic and throws otherwise; forces `SUPADATA_API_KEY`/`OPENROUTER_API_KEY` to placeholder values before every integration test file's imports; replaced the real YouTube ID in the shared stub-layer fixture (`generation-harness.ts`) with a synthetic one. Verified: unit (99), integration (51), lint, typecheck all pass; a manual sanity test confirmed the firewall blocks a real non-loopback fetch.

### F2 - Test support expands production database privileges

- **Severity**: WARNING
- **Impact**: HIGH - architectural stakes; think carefully before deciding
- **Dimension**: Scope Discipline
- **Location**: `supabase/migrations/20260904130000_test_support_grants.sql:26`
- **Detail**: The plan explicitly locked production code changes out and allowed one comment-only migration. A second migration permanently grants direct SELECT/DELETE capabilities on four production tables to `service_role` solely for the test harness. This reverses the established definer-only RPC pattern and makes the production request-path secret capable of operations it previously could not perform. The comment that no application capability changes is therefore inaccurate.
- **Fix A - Recommended**: Remove the production grant migration and make fixture setup/cleanup use a loopback-validated, test-only database-owner connection.
  - Strength: Preserves production least privilege and the plan's no-production-change boundary.
  - Tradeoff: Adds a local/CI database connection path and credentials to the test harness.
  - Confidence: HIGH - all affected operations are test setup/inspection, not application behavior.
  - Blind spot: The exact cross-platform owner client/driver has not been selected.
- **Fix B**: Apply narrowly scoped grants only to the ephemeral local/CI stack during test bootstrap and revoke them during teardown.
  - Strength: Keeps the current Supabase client-based harness with smaller changes.
  - Tradeoff: Teardown cannot run after a hard kill, so local privileges may remain until explicitly repaired.
  - Confidence: MEDIUM - safe for production if the SQL is fully removed from deployable migrations.
  - Blind spot: Parallel local runs need serialization around grant/revoke.
- **Decision**: FIXED via Fix A — removed `supabase/migrations/20260904130000_test_support_grants.sql`; added `src/test/db-owner.ts`, a loopback-validated, table-owner Postgres connection (`postgres` devDependency) that the test harness now uses instead. `integration-setup.ts`'s stale-fixture check, `generate.db.int.test.ts`'s cache cleanup and `credit_reservations` reads, and `synthetic-account.ts`'s `supadata_calls` cleanup all moved off `service_role`/PostgREST onto this connection. `service_role` regains zero privileges it didn't already have. Verified: `npx supabase db reset` reapplied the migration set without the grants, then the full integration suite (51 tests) still passed; typecheck/lint clean.

### F3 - Cleanup silently ignores failures and cannot filter the ledger

- **Severity**: WARNING
- **Impact**: MEDIUM - real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: `src/test/synthetic-account.ts:101`; `src/pages/api/summaries/generate.db.int.test.ts:97`
- **Detail**: Cache deletes, the `supadata_calls` delete, and `deleteUser` discard every Supabase `{ error }`. Worse, the migration grants DELETE but not SELECT on `supadata_calls`; a read-only `EXPLAIN DELETE ... WHERE youtube_id = ...` under `service_role` was verified to fail with `permission denied` and a hint to grant SELECT. `dispose()` would then delete the user anyway, turning any matching ledger rows into permanent `user_id = NULL` orphans. Current tests happened to leave zero ledger rows because cache hits create none, so the green run does not exercise this cleanup. Progress item 5.4 also overclaims hard-interruption cleanup: the code explicitly says SIGKILL leaves rows and only aborts the next run with manual repair instructions.
- **Fix**: Check and propagate every cleanup result, never delete the user after a failed ledger cleanup, use a channel with the privileges required to filter safely, and narrow 5.4 to controlled failures (or add a recoverable stale-row cleanup strategy).
  - Strength: Turns cleanup from a best-effort comment into an enforced data-safety invariant.
  - Tradeoff: Teardown needs structured error aggregation so later safe cleanup steps are still attempted.
  - Confidence: HIGH - PostgreSQL rejected the exact filtered DELETE plan under the migrated role.
  - Blind spot: No synthetic ledger row was inserted during review because review actions were kept non-destructive.
- **Rescoped at triage**: the F2 fix already resolved the privilege half. Cache deletes and the `supadata_calls` delete now run through the `postgres` owner connection, which rejects on error, so those failures propagate; the `permission denied` filtered-DELETE problem is gone with the grants.
- **Decision**: FIXED — `synthetic-account.ts`'s `dispose()` now checks `deleteUser`'s `{ error }` and throws a named message (naming the surviving row and how to remove it) instead of discarding it, so a leak is attributed to the test that caused it rather than surfacing as an unrelated abort on the next run; the `dispose` doc comment records that it throws. Plan progress item 5.4 narrowed to what the code actually guarantees: a *controlled* failure cleans up via `try/finally`, while a hard kill (SIGKILL) leaves rows and is covered by **detection** (`integration-setup.ts` aborts the next run with manual repair instructions), not cleanup. Verified: unit 99, integration 51, typecheck clean.

### F4 - `already_persisted` test mirrors current code instead of the plan oracle

- **Severity**: WARNING
- **Impact**: HIGH - architectural stakes; think carefully before deciding
- **Dimension**: Plan Adherence
- **Location**: `src/pages/api/summaries/generate.db.int.test.ts:29`; `src/pages/api/summaries/generate.db.int.test.ts:405`
- **Detail**: The plan requires a 500 for the third exit-#34 branch. The test explicitly rejects that oracle and pins the implementation's current 200. It also proves the 200 body is internally inconsistent: fresh generated text is returned with IDs belonging to an earlier persisted summary. This is the repository's prohibited mirror-test pattern: a discovered implementation mismatch was converted into the expected value without first resolving the contract from a source.
- **Fix**: Reopen the product contract for `already_persisted`, choose one coherent observable outcome (prefer an idempotent replay of the persisted row), update plan/research as the oracle, then change production behavior and assert the selected response rather than the implementation's present branch.
  - Strength: Removes both plan drift and the response-identity bug the test currently documents.
  - Tradeoff: Expands beyond the original test-only scope and requires a production behavior decision.
  - Confidence: HIGH - the test itself demonstrates the mismatched text/IDs.
  - Blind spot: Callers' preferred behavior for a concurrent already-persisted result has not been validated with product stakeholders.
- **Investigated at triage**: the plan's 500 oracle was itself wrong. `persist_summary`'s documented contract reads *"'already_persisted' — this reservation already produced a summary; ids replayed, nothing written"* (`20260723120000_atomic_persist_summary.sql:42`), so a success status is what the source calls for. The branch is only reachable when an earlier call on the **same reservation** already persisted and settled — so the charge is correct and exactly one summary exists. The genuine defect was narrower than "wrong status": the response body's `summary` was this request's freshly-generated text under the earlier row's `videoId`/`summaryId`.
- **Decision**: FIXED via a rescoped Fix A (contract resolved from the RPC's own documentation, not from the branch under test). `PersistSummaryResult` now carries `replayed: boolean` distinguishing the RPC's two success outcomes; `readStoredSummary()` (new, in `summaries.ts`) reads the persisted row's `content`/`model`; `generate.ts` uses those for the response body on the replayed path (and answers 500 without refunding if that read fails — the work is saved and the charge settled, only the body can't be built). The plan's exit-#34 table and intro were corrected to the real oracle. The test now asserts coherence positively (`json.summary` **is** the out-of-band content, `model` is its model) *and* against the discarded text, so a regression to shipping `summary.text` fails rather than passing by omission. Verified: unit 99, integration 51, typecheck clean.

### F5 - The integration cookbook teaches the wrong real-DB pattern

- **Severity**: WARNING
- **Impact**: MEDIUM - real tradeoff; pause to reason through it
- **Dimension**: Success Criteria
- **Location**: `context/foundation/test-plan.md:182`
- **Detail**: Section 6.2 says the real-DB layer fakes the paid boundary with the same response fixtures, says caches remain reachable only from the stub layer, and names only `dispose()` for cleanup. In reality the file mocks `llm.ts`, bypasses Supadata by seeding both caches through RPCs, separately runs `cleanupCaches`, and `dispose()` does not remove cache rows. A contributor following the cookbook cold would leave stale cache rows and trigger the next global setup abort. The stack table at line 83 also still says API mocking is "none yet" and internal services are never mocked.
- **Fix**: Rewrite the real-DB row and cleanup recipe to match the actual cache-seed + cache-cleanup + account-dispose sequence, document the required paid-request firewall, and refresh the stale API-mocking stack row.
  - Strength: Restores the Phase 6 handoff criterion that section 6.2 is sufficient on its own.
  - Tradeoff: Must be updated again if F1/F2 change the harness channel.
  - Confidence: HIGH - the contradictions are direct file-to-doc mismatches.
  - Blind spot: Final wording should follow the implementation selected during F1/F2 triage.
- **Decision**: FIXED — §6.2 rewritten against the current tree. The real-DB row now states what is actually faked (`llm.ts` only; Supadata is *never called* because both checkpoints are pre-seeded cache hits) and a new paragraph explains why seeding through the production `save_*_cache` RPCs is deliberate. Two previously undocumented mechanisms added: the `fetch` firewall (`setupFiles`, what it blocks, how a stub-layer test opts in, and that `afterEach` restores the firewall rather than the native `fetch`) and the table-owner connection (`db-owner.ts` — which tables grant `service_role` nothing and why, and when to use `admin` instead). The cleanup recipe replaced with the real **two-step** sequence as a runnable `withAccount` snippet (`cleanupCaches` then `dispose`), plus the fixture-id registration rule and an explicit "a hard kill is *detected*, not cleaned" paragraph. The stale line-83 stack row now names the actual tools and versions. Also corrected the "Two projects" paragraph (both `globalSetup` **and** `setupFiles`) and the vendor-fixtures note (`llm.ts` is mocked in both layers).

### F6 - Documented budget fail-open branches are missing

- **Severity**: WARNING
- **Impact**: MEDIUM - real tradeoff; pause to reason through it
- **Dimension**: Success Criteria
- **Location**: `src/lib/services/supadata-budget.int.test.ts:97`
- **Detail**: Research section 6 names every `untracked` exit, including a lost refresh claim and a non-terminating second reserve pass. The suite covers first-RPC errors, `uninitialized`, and `/v1/me` failures, but not `save_supadata_budget` error/`claim-lost` or second-pass `refresh_required`/`uninitialized`/error. The describe title and completed plan row claim every fail-open path despite these omissions.
- **Fix**: Add parameterized cases for save error, claim lost, and each non-terminal/error second-pass outcome; assert `untracked`, no reservation to settle, and exactly one `/v1/me` call.
  - Strength: Covers the explicitly researched branches where accidental recursion or refusal would break the fail-open contract.
  - Tradeoff: Adds several queue-based cases and must account for the retry-delay timer.
  - Confidence: HIGH - the missing switch outcomes are enumerated in `research.md:167` and `supadata-budget.ts:475-508`.
  - Blind spot: Timing assertions should remain behavioral and avoid pinning internal sleep implementation.
- **Decision**: FIXED — five cases added to `supadata-budget.int.test.ts` as two `it.each` tables. `save_supadata_budget` errors and reports `claim-lost`; the second reserve pass returns `refresh_required` again, `uninitialized`, or an RPC error. Each asserts `untracked`, **no** `reservationId`, the expected reserve-pass count, and **exactly one `/v1/me` call** — the behavioral proof that the `default` arm at `supadata-budget.ts:508` stops the refresh from recursing, with no assertion on the internal sleep. That file is now 20 tests (was 15); the describe block's "every fail-open path" claim is true as written.

### F7 - Ledger tests do not complete the planned reconciliation contract

- **Severity**: WARNING
- **Impact**: MEDIUM - real tradeoff; pause to reason through it
- **Dimension**: Plan Adherence
- **Location**: `src/lib/services/supadata-ledger.int.test.ts:87`; `src/lib/services/supadata-ledger.int.test.ts:188`
- **Detail**: The plan called for a mixed batch of outcomes, the exact `record_supadata_calls` payload, and then its sum. The only summed batch is one request with two successful rows, and it asserts selected fields rather than the exact payload. Different failure outcomes are isolated in separate requests. The malformed-header test also invokes only `"non-numeric"`; `"fractional"` and `"out-of-range"` are never exercised, so removal of the int4 ceiling could discard an entire real batch without a red test.
- **Fix**: Build the planned mixed-outcome payload test with an exact row assertion and parameterize malformed headers across non-numeric, fractional, and out-of-int4-range values.
  - Strength: Protects both reconciliation semantics and the batch-loss boundary the fixture comments identify.
  - Tradeoff: Producing genuinely mixed outcomes may require a meter-level seam if one endpoint request cannot emit the intended combination naturally.
  - Confidence: HIGH - current assertions and fixture call sites were exhaustively enumerated.
  - Blind spot: The plan does not define the precise ordering of rows, so exact comparison may need order normalization.
- **Decision**: FIXED (both halves). The malformed-header test is now an `it.each` over all three fixture kinds — `non-numeric`, `fractional`, and `out-of-range` (the int4-ceiling value whose acceptance would fail the whole batch INSERT and silently discard sibling rows). The second describe was rebuilt around the plan's actual contract: the `FlushedRow` type now covers all eight columns (`youtube_id` and `resolved_via` were missing), a `byOperation` helper normalizes the undefined row order, and two batches are asserted with `toEqual` rather than field-subset `toMatchObject` — a fully-reported batch summing to 2, and a genuinely **mixed** batch (a measured `1` beside an unmeasurable `null`) summing to `null`, asserted as its own value rather than as `not.toBe(1)`.

### F8 - The second 503 does not prove missing service-role-key wiring

- **Severity**: WARNING
- **Impact**: LOW - quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Adherence
- **Location**: `src/pages/api/summaries/generate.int.test.ts:63`
- **Detail**: The plan requires the two 503 preflights to differ by message and by the missing key. The first unsets `SUPADATA_API_KEY`; the second injects `admin: null`, while the harness always mocks `createAdminClient`. It therefore proves the endpoint's null branch but not that a missing `SUPABASE_SERVICE_ROLE_KEY` flows through the env stub and real constructor to that branch.
- **Fix**: Add a harness mode that leaves `@/lib/supabase-admin` unmocked, unset `SUPABASE_SERVICE_ROLE_KEY`, and assert the second 503 body.
- **Decision**: FIXED — `loadEndpoint` gained a `realAdminModule` option that skips the `@/lib/supabase-admin` mock (and a `doUnmock` so a prior test's registration cannot leak into it, since `doMock` outlives `resetModules`). Two tests, not one: the 503 with `SUPABASE_SERVICE_ROLE_KEY` unset, running the real `astro:env/server` → `createAdminClient()` → 503 chain; **and** a companion asserting the endpoint reaches 401 instead when the key *is* set. The companion is what makes the pair non-vacuous — `admin` defaults to `null`, so a `realAdminModule` that silently did nothing would still produce the 503 and look green.

### F9 - Watch and coverage silently run the integration project

- **Severity**: WARNING
- **Impact**: LOW - quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: `package.json:17`; `package.json:19`
- **Detail**: After introducing Vitest projects, plain `vitest` and `vitest run --coverage` select both projects. The existing `test:watch` and `test:coverage` scripts therefore now require Docker/local Supabase and create/delete synthetic accounts, contradicting AGENTS.md's fast unit-watch guidance and the documented ordinary coverage workflow.
- **Fix**: Add `--project unit` to `test:watch` and `test:coverage`; add separately named integration variants only if they are actually needed.
- **Decision**: FIXED — both scripts pinned to `--project unit`; no integration variants added (none was needed). `CLAUDE.md`'s command list now records that both are unit-only and that a bare `vitest` selects both projects, so the next person to edit these scripts sees why the flag is there.

### F10 - IPv6 loopback is rejected despite being advertised

- **Severity**: OBSERVATION
- **Impact**: LOW - quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: `src/test/integration-setup.ts:47`
- **Detail**: WHATWG `new URL("http://[::1]:54321").hostname` returns `[::1]`, but the guard compares it with `::1`. Node behavior was verified during review, so the documented IPv6 loopback path always aborts.
- **Fix**: Normalize brackets or accept `[::1]`, and add that URL to the smoke-test table.
- **Decision**: FIXED — the code half was already resolved by the F1 work, which extracted `isLoopbackHostname()` (now shared with `fetch-firewall.ts`) accepting both `::1` and `[::1]`; re-verified this session that Node returns `"[::1]"`. The missing half is now done: `harness.int.test.ts`'s accept case is an `it.each` over `localhost` / `127.0.0.1` / `[::1]`, so dropping the bracketed form goes red. That matters more than at first review — the same predicate now gates the fetch firewall, where a false negative would **block** legitimate loopback Supabase traffic mid-test rather than merely refusing to start.
