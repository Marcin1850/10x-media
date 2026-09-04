<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Paid-path integration tests

- **Plan**: `context/changes/testing-phase-2-paid-path/plan.md`
- **Scope**: Phases 1-6 of 6 (full slice)
- **Date**: 2026-09-05
- **Verdict**: REJECTED
- **Findings**: 1 critical, 8 warnings, 1 observation

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | FAIL |
| Scope Discipline | FAIL |
| Safety & Quality | FAIL |
| Architecture | FAIL |
| Pattern Consistency | WARNING |
| Success Criteria | FAIL |

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
- **Decision**: PENDING

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
- **Decision**: PENDING

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
- **Decision**: PENDING

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
- **Decision**: PENDING

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
- **Decision**: PENDING

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
- **Decision**: PENDING

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
- **Decision**: PENDING

### F8 - The second 503 does not prove missing service-role-key wiring

- **Severity**: WARNING
- **Impact**: LOW - quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Adherence
- **Location**: `src/pages/api/summaries/generate.int.test.ts:63`
- **Detail**: The plan requires the two 503 preflights to differ by message and by the missing key. The first unsets `SUPADATA_API_KEY`; the second injects `admin: null`, while the harness always mocks `createAdminClient`. It therefore proves the endpoint's null branch but not that a missing `SUPABASE_SERVICE_ROLE_KEY` flows through the env stub and real constructor to that branch.
- **Fix**: Add a harness mode that leaves `@/lib/supabase-admin` unmocked, unset `SUPABASE_SERVICE_ROLE_KEY`, and assert the second 503 body.
- **Decision**: PENDING

### F9 - Watch and coverage silently run the integration project

- **Severity**: WARNING
- **Impact**: LOW - quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: `package.json:17`; `package.json:19`
- **Detail**: After introducing Vitest projects, plain `vitest` and `vitest run --coverage` select both projects. The existing `test:watch` and `test:coverage` scripts therefore now require Docker/local Supabase and create/delete synthetic accounts, contradicting AGENTS.md's fast unit-watch guidance and the documented ordinary coverage workflow.
- **Fix**: Add `--project unit` to `test:watch` and `test:coverage`; add separately named integration variants only if they are actually needed.
- **Decision**: PENDING

### F10 - IPv6 loopback is rejected despite being advertised

- **Severity**: OBSERVATION
- **Impact**: LOW - quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: `src/test/integration-setup.ts:47`
- **Detail**: WHATWG `new URL("http://[::1]:54321").hostname` returns `[::1]`, but the guard compares it with `::1`. Node behavior was verified during review, so the documented IPv6 loopback path always aborts.
- **Fix**: Normalize brackets or accept `[::1]`, and add that URL to the smoke-test table.
- **Decision**: PENDING
