<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Browse Summary List (S-02)

- **Plan**: `context/changes/browse-summary-list/plan.md`
- **Scope**: Phase 3 of 4
- **Date**: 2026-08-09
- **Verdict**: NEEDS ATTENTION
- **Findings**: 0 critical, 2 warnings, 2 observations
- **Manual gate**: Pending by design; Progress items 3.3–3.9 remain unchecked
- **Triage**: Complete — 2026-08-09. All four findings fixed (F1–F3 in code, F4 in `plan.md`). `npm run lint` and `npm run build` re-run after the fixes: both PASS.

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | WARNING — 2 findings |
| Scope Discipline | PASS |
| Safety & Quality | WARNING — 1 finding |
| Architecture | WARNING — 1 finding |
| Pattern Consistency | PASS |
| Success Criteria | WARNING — automated checks pass; manual verification remains pending |

## Verification

- `npm.cmd run lint` — PASS. ESLint exited 0; only the existing `astro-eslint-parser` project-service notices were emitted.
- `npm.cmd run build` — PASS. Astro SSR/Cloudflare build exited 0 outside the managed sandbox; the sandboxed attempts could not start Wrangler's Workers runtime because its config/process access was restricted. The successful build emitted only the existing sitemap warning that `site` is not configured.
- Manual criteria 3.3–3.9 — PENDING. They are intentionally unchecked and were not treated as implementation defects.

## Findings

### F1 — A stale success clears newer form edits

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: `src/components/summaries/DashboardSummaries.tsx:47`
- **Detail**: The hook correctly applies a paid success even after the user edits the form, but its success callback unconditionally clears the current `url` and `allowLong`. Because those inputs remain editable while a request is running, success for request A can erase a newer URL or consent choice entered for request B. The pre-refactor form preserved edited inputs on a stale success, so this is a regression in the phase's “no behavior changes” guarantee.
- **Fix**: Track the submitted form revision/attempt identity and reset URL/allow-long only when the current inputs still belong to the successful attempt.
  - Strength: Preserves the paid-success invariant without discarding newer user input.
  - Tradeoff: Requires coordinating the controlled fields with an attempt/revision identity rather than using unconditional setters.
  - Confidence: HIGH — the hook explicitly accepts stale successes and the inputs are visibly editable during loading.
  - Blind spot: The stale-success edit path has not yet been manually exercised.
- **Decision**: FIXED — `onSuccess` now clears the URL through a functional update that only resets it when the field still holds the successful attempt's URL; `allowLong` stays unconditionally cleared as the safe direction.

### F2 — A discarded stale response leaves an orphan attempt

- **Severity**: ⚠️ WARNING
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Architecture
- **Location**: `src/components/hooks/useGenerateSummary.ts:243`
- **Detail**: When an input change makes a non-success HTTP response stale, the hook clears `loading` and returns but leaves `attempt` populated with no `error` or `confirm`. Phase 4 is contracted to derive a pending card from `attempt` plus generating/confirmation/failure status, so this creates an attempt with no representable status and can leave the next phase with a stuck or silently omitted entry.
- **Fix**: Clear `attempt` in the stale non-success branch because the input change deliberately abandoned that advisory response.
- **Decision**: FIXED — added an `attemptSeq` ref recording which request owns the current `attempt`, and retract it in both stale branches (non-success HTTP and network error) only when the abandoning request still owns it. An unguarded clear, as originally written, would have erased a newer submit's attempt when a stale response landed after it.

### F3 — `lastSuccess.summaryId` weakens the planned contract

- **Severity**: 👁️ OBSERVATION
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Adherence
- **Location**: `src/components/hooks/useGenerateSummary.ts:47`
- **Detail**: Phase 3 specifies `lastSuccess.summaryId: string` so Phase 4 can confirm that the refreshed list contains the committed row. The implementation exposes `string | null` and silently converts a missing or malformed successful response field to `null`. Both normal and replay success responses currently include `summaryId`, so the weaker type masks a broken endpoint contract rather than modeling a supported response.
- **Fix**: Keep `summaryId` non-null in `LastSuccess` and handle a malformed successful payload explicitly while preserving the already-paid result and balance update.
- **Decision**: FIXED — `LastSuccess.summaryId` is now `string`. A successful payload without one still applies the paid result and the refreshed balance, then returns without raising the success event.

### F4 — Character persistence is undocumented plan drift

- **Severity**: 👁️ OBSERVATION
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Adherence
- **Location**: `src/components/summaries/DashboardSummaries.tsx:47`
- **Detail**: The plan says the controlled inputs are cleared after a successful generation so the next summary starts clean. The implementation clears URL and allow-long but deliberately retains `character` as a preference. This is a reasonable UX choice, but it differs from the reviewed clearing contract.
- **Fix**: Amend the Phase 3 clearing policy to state that URL and per-video long-video consent reset on success while the character preference persists.
- **Decision**: FIXED — `plan.md` Phase 3 clearing policy now spells out the per-input behaviour: conditional URL reset (per F1), unconditional `allowLong` reset, persistent `character`.

## Review Summary

The structural lift matches the plan and preserves all three paid-path invariants: the idempotency key survives only ambiguous network failures, `requestSeq` advances on submit and every quote-relevant input change, and paid successes are applied before stale-response filtering. The dialog is accessible, the form is presentational, the list has one owner, the endpoint change is comment-only, and the small unplanned empty-state copy update is a necessary consequence of moving generation into “New summary,” not scope creep. No security, XSS, auth, endpoint, or data-loss critical issue was found. Phase 3 still needs attention on two state-coordination edges before its intentionally deferred manual gate is closed.
