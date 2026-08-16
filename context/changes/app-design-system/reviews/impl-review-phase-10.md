<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: App Design System — Step 4 Implementation Plan

- **Plan**: context/changes/app-design-system/plan.md
- **Scope**: Phase 10 of 10
- **Implementation**: `ca0d3b1..1c75118`
- **Date**: 2026-08-15
- **Verdict**: NEEDS ATTENTION
- **Findings**: 0 critical, 5 warnings, 2 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | FAIL |
| Scope Discipline | WARNING |
| Safety & Quality | WARNING |
| Architecture | WARNING |
| Pattern Consistency | WARNING |
| Success Criteria | WARNING |

## Verification

| Criterion | Result | Evidence |
|-----------|--------|----------|
| `npm run lint` | PASS | `npm.cmd run lint`, exit 0 |
| `npm run build` | PASS | `npm.cmd run build`, exit 0; Astro/Cloudflare server build completed |
| `npm run lint:tokens` | PASS | Exit 0; no hardcoded palette utilities found |
| Explicit palette grep | PASS | No matches under `src/` |
| Desktop and mobile browser verification | ACCEPTED | User states verification was performed on desktop and mobile browsers |
| Distinct squeeze-zone and final all-width pass | NOT RECORDED | The phase note remains “in progress” and Progress rows 10.5/10.8 are unchecked |

## Findings

### F1 — Canonical phase state was not closed out

- **Severity**: ⚠️ WARNING
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Success Criteria
- **Location**: context/changes/app-design-system/plan.md:1212; context/changes/app-design-system/change.md:12; context/foundation/roadmap.md:39
- **Detail**: Commit `1c75118` says all eleven Phase 10 findings were fixed and manually verified, the user confirms desktop/mobile browser verification, and all automated gates pass in this review. The durable state says otherwise: Progress 10.1–10.8 is entirely unchecked; the QA note still says “in progress” and describes the superseded `channel_username` contract as final; both S-06 roadmap entries still say the plan has nine phases, only P1–P3 landed, and manual verification remains open. The plan’s distinct squeeze-zone and final all-width pass are not explicitly recorded.
- **Fix**: Reconcile `plan.md`, the Phase 10 note in `change.md`, and both S-06 roadmap entries with commit `1c75118`, the automated results above, and the user’s browser evidence; record whether the desktop pass included the planned 640–960px squeeze zone.
- **Decision**: FIXED — `plan.md` Progress 10.1-10.8 checked off; `change.md`'s QA note header changed from "in progress" to "complete" and its stale `channel_username` write-up corrected to the shipped `channel_id` contract; both S-06 roadmap entries (summary table + detail section) updated to reflect all 10 phases landed and the Phase 10 review outcome. User confirmed the desktop pass included a distinct ~640-960px squeeze-zone check and a final all-width regression pass.

### F2 — RPC swaps leave no compatibility window or safe code rollback

- **Severity**: ⚠️ WARNING
- **Impact**: 🔴 HIGH — architectural stakes; think carefully before deciding
- **Dimension**: Architecture
- **Location**: supabase/migrations/20260814130000_channel_username.sql:74; supabase/migrations/20260814140000_channel_id_correction.sql:70
- **Detail**: Both migrations drop the previous `save_metadata_cache` and `persist_summary` signatures and recreate only widened signatures. During schema/Worker version skew, or after rolling the Worker back, generation reaches a missing RPC after the paid LLM step. The endpoint refunds the user on persistence failure, so the risk is provider spend and availability rather than an incorrect user debit. The back-to-back push/deploy runbook reduced the initial window but does not make rollback compatible.
- **Fix A ⭐ Recommended**: Add old-signature compatibility wrappers in a new forward migration, keep the widened functions canonical, and remove wrappers only after the rollback window closes.
  - Strength: Eliminates schema/Worker version skew and restores a safe application rollback path.
  - Tradeoff: Adds temporary RPC surface and requires verifying PostgREST overload resolution before rollout.
  - Confidence: MED — named RPC arguments and differing arity should make wrappers viable, but this exact pair has not been exercised locally.
  - Blind spot: The production rollback policy and acceptable compatibility-window duration are not recorded.
- **Fix B**: Keep the intentional drop/recreate strategy and document rollback as a new forward deployment rather than an old-Worker rollback.
  - Strength: Preserves the repo’s established single-signature RPC pattern and avoids overload ambiguity.
  - Tradeoff: Accepts generation downtime/provider waste if schema and Worker versions diverge.
  - Confidence: HIGH — this is the behavior the migrations themselves document.
  - Blind spot: Operational response time during a failed deployment is unknown.
- **Decision**: FIXED via Fix B — `change.md`'s Finding 2 write-up now documents the rollback policy explicitly: drop/recreate is intentional, old-Worker rollback is unsupported, recovery is a new forward deployment following the same `db push`/`wrangler deploy` back-to-back discipline as prior signature changes.

### F3 — Warm metadata-cache rows delay channel links for up to 30 days

- **Severity**: ⚠️ WARNING
- **Impact**: 🟡 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: src/lib/services/metadata-cache.ts:54; supabase/migrations/20260814140000_channel_id_correction.sql:23
- **Detail**: The migrations add/rename a nullable cache column without invalidating existing rows. `getCachedMetadata` accepts any fresh cache row as complete, so a video cached before deployment returns `channelId: null`, skips the vendor fetch, and persists no link on a new summary until the 30-day cache window expires. This contradicts the Phase 10 note’s claim that all generations “from this point forward” receive the identifier. Treating every null as a miss is also unsafe because legitimate vendor-null results would refetch forever.
- **Fix A ⭐ Recommended**: Accept the gradual rollout and document that pre-deployment warm rows may omit channel links until their normal cache expiry.
  - Strength: Preserves the shared paid cache and matches the existing no-backfill/cost-control decision.
  - Tradeoff: Some newly generated summaries lack a channel link for up to 30 days.
  - Confidence: HIGH — it matches the current code exactly.
  - Blind spot: The number and remaining age of affected cache rows is unknown.
- **Fix B**: Invalidate only cache rows known to predate the schema deployment, causing one fresh metadata call when each affected video is next generated.
  - Strength: Makes the feature correct on the next generation without creating a permanent null-refetch loop.
  - Tradeoff: Spends one vendor credit per affected video and weakens the cost-saving cache temporarily.
  - Confidence: MED — the policy is straightforward, but the deployment cutoff and affected-row count must be verified first.
  - Blind spot: No production cache-age distribution was inspected in this review.
- **Decision**: FIXED via Fix A — `change.md`'s Finding 2 write-up now documents that warm pre-deployment cache rows delay channel links until their normal 30-day expiry, as an accepted extension of the existing no-backfill decision. No code change.

### F4 — “Full” Markdown coverage drops footnote semantics

- **Severity**: ⚠️ WARNING
- **Impact**: 🟡 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: src/components/summaries/SummaryMarkdown.tsx:22
- **Detail**: The Phase 10 expansion claims every reachable CommonMark/GFM element is covered, while keeping attacker-controlled external links excluded. A render probe with `Text[^1]` and a footnote definition produces plain `Text1`, an orphaned “Footnotes” section, and `↩` text: `sup`, `section`, and `a` are absent from the allowlist, so reference/back-reference semantics and keyboard navigation are stripped. The external-link security boundary remains intact, but the new “full coverage” claim is false and real content degrades silently.
- **Fix**: Add and style `sup`/`section`, admit `a`, and use `allowElement` plus a custom link renderer to preserve only generated same-document footnote anchors (`#user-content-fn…` / backrefs) while continuing to unwrap all external or transcript-controlled links.
  - Strength: Completes footnote semantics without reopening external navigation or image-fetch risks.
  - Tradeoff: Adds non-trivial allowlist logic and needs focused render fixtures for internal and external links.
  - Confidence: HIGH — the broken output was reproduced against the installed renderer.
  - Blind spot: Exact generated footnote href/id shapes should be locked to the installed `react-markdown` version in fixtures.
- **Decision**: FIXED — `SummaryMarkdown.tsx` now admits `sup`/`section`/`a`, gated by `allowElement` to hrefs starting with `#user-content-fn` (both the forward ref and backref remark-gfm generates). The `sr-only` footnote-label `h2` is now honoured instead of rendered as a visible heading. Verified with a temporary `renderToStaticMarkup` probe (installed `tsx`, deleted after use): a footnote renders full sup/a/section/backref structure; an external link, a bare-URL autolink, and an image all still render as plain text or nothing, exactly as before. `npm run lint` and `npm run build` both pass.

### F5 — Post-auth redirect is an undocumented behavior change

- **Severity**: ⚠️ WARNING
- **Impact**: 🟡 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Scope Discipline
- **Location**: src/pages/api/auth/signin.ts:19; src/pages/auth/callback.ts:31
- **Detail**: Phase 10 is a visual/structural QA sweep whose fixes are expected to remain presentational unless special scrutiny is recorded. Redirecting successful sign-in and email confirmation from `/` to `/summaries` changes auth-flow behavior. The change note says the user approved it and the destinations are safe fixed internal paths, but the plan has no addendum and no focused evidence for both success flows.
- **Fix**: Add a Phase 10 plan addendum recording the user-approved post-auth destination decision and the focused sign-in plus confirmation-link regression evidence.
  - Strength: Preserves the chosen UX while restoring plan traceability around an auth behavior change.
  - Tradeoff: The plan gains a post-implementation addendum.
  - Confidence: HIGH — the two changed call sites and intended destination are explicit.
  - Blind spot: This review did not execute a fresh email-confirmation flow.
- **Decision**: FIXED — `plan.md`'s Phase 10 section now carries an addendum recording the user-approved redirect decision and stating plainly that verification was limited to the general sweep (no dedicated sign-in/confirmation-link regression test was run).

### F6 — Relative-date rendering can mismatch at UTC midnight

- **Severity**: 👁 OBSERVATION
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/lib/format.ts:89; src/components/summaries/SummaryCard.tsx:84
- **Detail**: `daysSince()` reads the real clock independently during SSR and hydration. If those renders straddle UTC midnight, the suffix differs and React may regenerate the subtree; the comment’s “harmless single-frame correction” is not guaranteed. The occurrence window is very small and no user-visible regression was reported.
- **Fix**: Anchor the initial relative-date calculation to a server-provided UTC date/timestamp, or render the relative suffix only after hydration.
- **Decision**: FIXED — added `useHasMounted` (`src/components/hooks/useHasMounted.ts`, via `useSyncExternalStore` so the mount flip doesn't trip `react-hooks/set-state-in-effect`) and used it in `SummaryCard.tsx` to hold the relative-date suffix back until after mount, guaranteeing the first client render matches SSR exactly rather than merely narrowing the mismatch window. `daysSince` still recomputes on every render once mounted, so the suffix keeps advancing live. `npm run lint` and `npm run build` both pass.

### F7 — Changed API route still misses the repository’s SSR marker

- **Severity**: 👁 OBSERVATION
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: src/pages/api/auth/signin.ts:1
- **Detail**: Repository instructions require every API route to export `export const prerender = false;`. The changed sign-in endpoint still lacks it, while the changed auth callback carries it. The omission predates Phase 10 and the other auth API handlers share the debt, so this is a touched-file convention mismatch rather than a newly introduced runtime failure.
- **Fix**: Add `export const prerender = false;` to `signin.ts`; track `signup.ts` and `signout.ts` as the same small consistency follow-up.
- **Decision**: FIXED — `export const prerender = false;` added to all three auth API routes (`signin.ts`, `signup.ts`, `signout.ts`), matching `callback.ts`'s placement. `npm run lint` and `npm run build` both pass.
