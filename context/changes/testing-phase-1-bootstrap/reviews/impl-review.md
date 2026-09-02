<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Test Rollout Phase 1: Bootstrap + Cost/Credit Rules

- **Plan**: `context/changes/testing-phase-1-bootstrap/plan.md`
- **Scope**: Phases 1–5 of 5 (full plan)
- **Date**: 2026-08-31
- **Verdict**: NEEDS ATTENTION
- **Findings**: 0 critical, 2 warnings, 2 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | WARNING |
| Scope Discipline | WARNING |
| Safety & Quality | WARNING |
| Architecture | PASS |
| Pattern Consistency | WARNING |
| Success Criteria | PASS |

## Findings

### F1 — Non-web URL schemes pass the shared YouTube trust boundary

- **Severity**: ⚠️ WARNING
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: `src/lib/services/summaries.ts:161`
- **Detail**: `extractYoutubeId` validates hostname, path, and video-id shape but never validates `URL.protocol`. As a result, inputs such as `ftp://youtube.com/watch?v=dQw4w9WgXcQ` pass `generateSchema` and the original URL can reach the paid transcript-provider boundary. The plan explicitly requires `http:` and `https:` support, not arbitrary schemes, and the repository's analogous trusted-URL check in `src/components/summaries/VideoThumbnail.tsx:35` validates both protocol and hostname.
- **Fix**: Require `parsed.protocol` to be `http:` or `https:` in `extractYoutubeId`, and add parameterized rejection rows for representative non-web schemes.
- **Decision**: FIXED — `YOUTUBE_PROTOCOLS` guard added in `src/lib/services/summaries.ts`; one rejection row (`ftp://www.youtube.com/watch?v=…`) added, verified red without the guard. Candidate `javascript:`/`file:` rows were dropped: both already fail on the empty hostname, so they would be redundant copies rather than new regressions. 87 tests pass, lint clean.

### F2 — The Linear closing comment cannot contain the promised review verdict yet

- **Severity**: ⚠️ WARNING
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Adherence
- **Location**: `context/changes/testing-phase-1-bootstrap/change.md:69`
- **Detail**: The plan requires MAR-19's closing comment to summarize both what landed and the implementation-review verdict. `change.md` records that the issue was moved to Done before `/10x-impl-review`, so the comment explicitly left the verdict outstanding. The deviation is documented, but the planned tracker hand-off remains incomplete until the final verdict is posted.
- **Fix**: After triage, add a follow-up MAR-19 comment with the final verdict and the saved review path before archiving the change.
- **Decision**: FIXED — follow-up comment posted on MAR-19 (2026-09-02) carrying the NEEDS ATTENTION verdict, the per-dimension table, the four dispositions and the report path. The tracker hand-off the plan asked for is now complete.

### F3 — New test guidance contains stale line references and an incorrect alias claim

- **Severity**: 👁️ OBSERVATION
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: `src/lib/services/summaries.test.ts:26`, `src/lib/schemas/generate-summary.test.ts:110`, `context/foundation/test-plan.md:117`
- **Detail**: The comments point to `generate.ts:743` as the whitespace guard (currently line 730) and `generate.ts:804` as the atomic debit (currently line 791). The cookbook also says the `@` alias is declared in `vitest.config.ts` “and nowhere else”, although its canonical application mapping exists in `tsconfig.json`; Vitest must mirror it because plain Vite does not inherit it here. These do not weaken the tests, but they make a reference-heavy cookbook misleading.
- **Fix**: Correct the two pointers and describe `vitest.config.ts` as explicitly mirroring the canonical `tsconfig.json` alias for the test runner.
- **Decision**: FIXED — pointers now read `generate.ts:730` (whitespace guard), `:734-735` (pricing hazard) and `:791` (atomic debit), each anchored by the symbol at that line so later drift is recoverable. §6.1 now states that `tsconfig.json` `paths` is canonical and `vitest.config.ts` mirrors it because the plain `vitest/config` setup does not inherit tsconfig paths.

### F4 — Roadmap changed despite the plan's explicit “untouched” guardrail

- **Severity**: 👁️ OBSERVATION
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Scope Discipline
- **Location**: `context/foundation/roadmap.md:4`
- **Detail**: Commit `650fa33` landed after the plan was created and added a pointer from the roadmap to the test-rollout register, while `plan.md` says `roadmap.md` is untouched because no roadmap item carries this Change ID. The addition is benign and intentionally avoids duplicating status, but it is still an undocumented exception to an explicit scope guardrail.
- **Fix**: Keep the useful pointer and record `650fa33` as a deliberate, non-status addendum in the change notes so the plan and implementation history agree.
- **Decision**: FIXED — the pointer stays; `change.md` now carries an addendum explaining that the guardrail was about not writing rollout *status* into a product-slice register, which `650fa33` does not do.

## Verification

| Check | Result |
|-------|--------|
| `npm.cmd test` | PASS — 3 files, 86 tests |
| `npm.cmd run lint` | PASS — no lint errors |
| `npm.cmd run test:coverage` | PASS — v8 report generated, no thresholds |
| `npm.cmd run build` | PASS — Cloudflare server build completed |
| `npx.cmd stryker run --mutate "src/lib/services/credits.ts"` | PASS — 98 killed, 26 survived, 25 no coverage, 0 errors/timeouts |

## Triage (2026-09-02)

All four findings fixed; none skipped, dismissed or accepted as risk. Code changes: the `http:`/`https:` guard in `src/lib/services/summaries.ts` plus its rejection row (F1). Documentation changes: two test-header pointers and `test-plan.md` §6.1 (F3), and the `650fa33` addendum in `change.md` (F4). Post-fix gates: `npm test` 87 passing, `npm run lint` clean. Stryker was not re-run — no mutated module changed.

Manual criteria were checked against the committed progress evidence and change notes. Paid provider flows were not repeated during review. The recorded CI run is `32650782239`; this review did not independently query the external CI or Linear systems.
