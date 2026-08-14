<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: App Design System — Step 4 Implementation Plan

- **Plan**: `context/changes/app-design-system/plan.md`
- **Scope**: Phase 9 of 10
- **Date**: 2026-08-14
- **Verdict**: REJECTED
- **Findings**: 1 critical, 2 warnings, 3 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | WARNING |
| Scope Discipline | PASS |
| Safety & Quality | FAIL |
| Architecture | PASS |
| Pattern Consistency | WARNING |
| Success Criteria | WARNING |

## Findings

### F1 — Ambiguous billing failure is reported as definitely not charged

- **Severity**: ⛔ CRITICAL
- **Impact**: 🔬 HIGH — architectural stakes; think carefully before deciding
- **Dimension**: Safety & Quality
- **Location**: `src/pages/api/summaries/generate.ts:288`; `src/lib/services/credits.ts:246`; `src/components/hooks/useGenerateSummary.ts:243`
- **Detail**: `refuseAndCharge` maps every result other than `charged` or `replay` to `charged: false`. That includes `notCharged`, which `chargeFailedTranscript` also returns when its RPC promise rejects or its response is missing/malformed. A transport failure can occur after PostgreSQL commits the debit but before the caller receives the response, so this outcome is not proof that no credit was taken. The endpoint can therefore make a false statement about the user's balance. Because the hook clears `pendingRequest` on every HTTP response before inspecting the body, the next submit uses a new request ID and can debit the same operation again.
- **Fix A ⭐ Recommended**: Model an explicit ambiguous/unknown billing outcome end-to-end; omit the `charged` assertion for it and preserve the same request ID for a safe idempotent retry.
  - Strength: Removes the false money statement and preserves the ledger's existing idempotency guarantee even when the charge response is lost.
  - Tradeoff: Changes the service result union, endpoint response mapping, and client request-key lifecycle; the first ambiguous response must remain silent about money until retried/resolved.
  - Confidence: HIGH — the current service deliberately catches transport rejection, while the ledger is already keyed by `requestId` for safe replay.
  - Blind spot: The ambiguous commit-then-response-loss path has not yet been fault-injected against local Supabase.
- **Fix B**: Add a tri-state ledger lookup after an ambiguous RPC result and report true/false only when that lookup proves the row state; preserve the request ID and stay silent if the lookup is also inconclusive.
  - Strength: Can resolve some ambiguous calls immediately without requiring a user retry.
  - Tradeoff: Adds another database round trip and a more complex tri-state contract on the paid failure path.
  - Confidence: MEDIUM — it is sound if the lookup distinguishes “no row” from “lookup failed,” which the current nullable lookup does not.
  - Blind spot: Database visibility and timing immediately after a dropped RPC response have not been exercised.
- **Decision**: PENDING

### F2 — Replay copy says this attempt took the credit

- **Severity**: ⚠️ WARNING
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Adherence
- **Location**: `src/lib/copy/pl.ts:146`
- **Detail**: The plan and the adjacent comment require wording about the operation so a replay does not imply that the retry caused a second debit. `Za tę próbę pobrano kredyt.` means “A credit was charged for this attempt,” directly contradicting that contract and manual criterion 9.6.
- **Fix**: Change the charged line to `Za tę operację pobrano kredyt.` and use the same operation-level noun in the no-charge line for symmetry.
- **Decision**: PENDING

### F3 — The new charge outcome is outside the alert region

- **Severity**: ⚠️ WARNING
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: `src/components/summaries/PendingSummaryCard.tsx:190`
- **Detail**: The async failure message has `role="alert"`, but the newly added charged/not-charged statement is a sibling outside that live region. Assistive technology may announce the error while omitting the financial outcome, which is the load-bearing information introduced by this phase.
- **Fix**: Put the failure text and conditional money line inside one `role="alert"` container, without nesting another live region.
- **Decision**: PENDING

### F4 — Token guard's stated invariant is broader than its detection

- **Severity**: 👁️ OBSERVATION
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Success Criteria
- **Location**: `scripts/check-tokens.mjs:4`; `scripts/check-tokens.mjs:52`
- **Detail**: The implemented regexes match the three exact families named by the phase contract and correctly catch the current sweep violations. However, the script describes itself as proof that every colour outside `global.css` is tokenized while it does not detect raw CSS/inline declarations, non-hex arbitrary colours such as `bg-[rgb(...)]`, or other Tailwind colour families such as `divide-*`, `outline-*`, and `accent-*`. The current check is useful, but the broader guarantee is not mechanically proven.
- **Fix A ⭐ Recommended**: Narrow the script/plan claim to the utility families it actually enforces and add small fixture tests that lock those families down.
  - Strength: Makes the guarantee precise without turning a grep-shaped guard into a CSS parser.
  - Tradeoff: Explicitly accepts that some hardcoded-colour syntaxes remain outside the guard.
  - Confidence: HIGH — the present patterns match their narrower documented contract and the injected probe passes.
  - Blind spot: Future code may use an unguarded colour syntax unless linting or review catches it.
- **Fix B**: Broaden the guard and its fixtures to cover CSS/style declarations, arbitrary colour functions/names, and the remaining Tailwind colour utility families.
  - Strength: Brings enforcement closer to the stated “every colour” invariant.
  - Tradeoff: Regex false positives and parser edge cases grow quickly; a proper Tailwind/CSS-aware lint rule may be more maintainable.
  - Confidence: MEDIUM — the missing syntaxes are identifiable, but robust parsing is wider than the phase's grep-shaped design.
  - Blind spot: Generated strings and unusual Tailwind variants can still evade regex-only scanning.
- **Decision**: PENDING

### F5 — Paid-path comment contradicts the implementation

- **Severity**: 👁️ OBSERVATION
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: `src/pages/api/summaries/generate.ts:257`
- **Detail**: The comment says the charge outcome is ignored for response purposes and that the response is unchanged, while phase 9 now reads the outcome and adds `charged` to the body. The later paragraph says the opposite. Contradictory documentation is risky beside load-bearing billing code.
- **Fix**: Rewrite the stale paragraph to say billing failure never changes the refusal status/error copy, while the outcome controls only the `charged` signal.
- **Decision**: PENDING

### F6 — Phase 9 names a nonexistent forwarding file

- **Severity**: 👁️ OBSERVATION
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Adherence
- **Location**: `context/changes/app-design-system/plan.md:881`
- **Detail**: The phase file list names `src/components/summaries/SummariesSurface.tsx`, which does not exist. The contract later correctly points to `DashboardSummaries.tsx`, where the `SummariesSurface` component is exported and `charged` is forwarded. The implementation is present; only the plan pathname is stale.
- **Fix**: Replace the nonexistent pathname with `src/components/summaries/DashboardSummaries.tsx` in `plan.md` and mirror the correction in `plan-brief.md` if that path appears there.
- **Decision**: PENDING

## Verification Evidence

### Automated

| Criterion | Command | Result |
|-----------|---------|--------|
| 9.1 token guard | `npm.cmd run lint:tokens` | PASS — no hardcoded palette utilities reported |
| 9.2 injected violation | Temporary `src/__token_guard_review_probe__.tsx` containing `bg-purple-600`, then `npm.cmd run lint:tokens` | PASS — exited 1 and named `src/__token_guard_review_probe__.tsx:1`; probe removed and clean guard rerun passed |
| 9.3 lint | `npm.cmd run lint` | PASS — ESLint completed with only the existing `astro-eslint-parser` projectService notices |
| 9.3 build | `npm.cmd run build` | PASS — Astro/Cloudflare server build completed; four font files copied |
| 9.4 CI wiring | `Select-String .github/workflows/ci.yml "npm run lint:tokens"` | PASS — step present after lint at line 21 |

### Manual

Manual criteria 9.5–9.9 are intentionally unchecked and pending, exactly as requested. They were not treated as rubber-stamped or as defects merely because they are pending. Static review already shows that criterion 9.6 would fail with the current attempt-level wording.

## Review Notes

- The supplied path `context/changes/app-system-design` does not exist. The review resolved to `context/changes/app-design-system`, the only matching active change.
- Git scope is commit `d94e0b1` plus progress-only write-back `bcfea5c`. The worktree was clean before review.
- The three otherwise-unplanned primitive edits are justified by the phase contract: at `d94e0b1^`, `badge.tsx` and `button.tsx` contained `text-white`, and `dialog.tsx` contained `bg-black/50`; these were the exact remaining violations caught when the new whole-tree guard was introduced. Replacing them with semantic tokens is not scope creep.
- All current 422 construction paths were inspected. The chargeable paths flow through `refusalResponse`; the known refusal replay reports true; the transient raw 422 reports false. Missing/non-boolean client fields narrow to `null`, stale responses return before assignment, and both new attempts and attempt-bound clearing reset the charge state.
- No new injection/XSS, secret exposure, auth/authz bypass, unsafe database mutation, unbounded work, N+1 query, resource leak, architecture-boundary violation, or platform-portability issue was found.
