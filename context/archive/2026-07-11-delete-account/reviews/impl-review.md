<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Delete Account + All Data (GDPR)

- **Plan**: context/changes/delete-account/plan.md
- **Scope**: Phases 1–2 of 2
- **Date**: 2026-07-12
- **Verdict**: NEEDS ATTENTION
- **Findings**: 0 critical, 2 warnings, 3 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | PASS |
| Scope Discipline | WARNING |
| Safety & Quality | WARNING |
| Architecture | PASS |
| Pattern Consistency | WARNING |
| Success Criteria | FAIL |

## Findings

### F1 — Confirmation is not enforced at the destructive boundary

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: src/pages/api/account/delete.ts:16
- **Detail**: The email confirmation exists only in React state (`DeleteAccountDialog.tsx:16,25-30`). Any authenticated same-origin POST reaches the service-role `deleteUser` call without presenting confirmation. Astro's origin check blocks cross-origin form CSRF and the server-derived user ID prevents deleting another user, but the irreversible endpoint does not enforce the product's accidental-deletion guard against a direct or future same-origin caller. This is plan-conformant, but the plan's no-body contract is the dangerous decision.
- **Fix**: Send a zod-validated confirmation value and compare it with `context.locals.user.email` before creating or using the admin client.
  - Strength: Enforces the stated confirmation invariant at the only boundary capable of irreversible deletion.
  - Tradeoff: Changes the endpoint contract and UI request; it does not defend against fully compromised same-origin JavaScript that can read the email.
  - Confidence: HIGH — both the authenticated user email and the repository's zod API pattern already exist.
  - Blind spot: No recent-auth/password requirement is in product scope, so this remains an accidental-deletion guard rather than identity re-verification.
- **Decision**: FIXED — endpoint now zod-validates `confirmation` and compares it to `context.locals.user.email` before creating the admin client; UI sends the typed value in the JSON body.

### F2 — Checked-off repository verification does not reproduce

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Success Criteria
- **Location**: context/changes/delete-account/plan.md:236
- **Detail**: On current HEAD `546e8f0`, `npm run lint` fails with 41 errors in pre-existing `scripts/sync-prod-to-local.mjs` (introduced by `e756e38`, before the feature commits). `npm run build` passes. A non-mutating `prettier --check .` reports 36 files, including change documentation and the same script; the exact `npm run format` command was not executed because it is a write command and would alter unrelated files during review. Focused ESLint and Prettier checks over all nine planned implementation files pass. The feature code is clean, but the repository-wide success criteria marked `[x]` are not reproducible from this branch.
- **Fix**: Reconcile the baseline lint/format drift, add a non-mutating `format:check` script for verification, then rerun and record the repository-wide checks.
  - Strength: Restores CI-grade reproducibility while preserving the evidence that the delete-account files themselves pass focused checks.
  - Tradeoff: Touches files outside this change and may require bringing in the existing script-lint fix from the parallel work.
  - Confidence: HIGH — the failing commands and focused passing commands were rerun on the reviewed HEAD.
  - Blind spot: The broad Prettier list includes line-ending/documentation drift that may be branch-specific.
- **Decision**: SKIPPED — root cause is the pre-existing `scripts/sync-prod-to-local.mjs`, already fixed on a parallel branch; it is the sole ESLint failure and the only *code* Prettier hit. The remaining 37 Prettier warnings are non-code (context/**.md docs, .mcp.json, generated supabase/.temp/linked-project.json) and are not gated by CI (`npm run lint` + build). Feature code passes focused lint/format. Resolves on branch merge; no action in this change.

### F3 — Admin deletion failures have an unstable error contract

- **Severity**: 👁️ OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/pages/api/account/delete.ts:26
- **Detail**: A rejected `deleteUser` promise bypasses the endpoint's structured JSON response, while a resolved Supabase error returns its raw provider message to the browser. Deletion remains fail-safe because session teardown happens later, and the UI tolerates non-JSON, but this differs from the stable, masked upstream-error pattern in `src/pages/api/summaries/probe.ts`.
- **Fix**: Wrap `deleteUser` in `try/catch`, keep diagnostic details server-side, and return a stable generic 500 JSON message on every pre-delete failure.
- **Decision**: FIXED — `deleteUser` now wrapped in try/catch so a resolved Supabase error and a rejected promise both return the same masked generic 500 JSON. Dropped the proposed server-side `console.error` to match the repo (no src file logs to console; `no-console` is enforced; `probe.ts` masks without logging).

### F4 — Custom modal omits expected keyboard and focus behavior

- **Severity**: 👁️ OBSERVATION
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Pattern Consistency
- **Location**: src/components/account/DeleteAccountDialog.tsx:61
- **Detail**: The hand-built `role="dialog"` provides labels and `aria-modal`, but it does not place or trap focus, close on Escape, or restore focus to the trigger. Keyboard and screen-reader users can remain on or tab into background content during an irreversible workflow.
- **Fix**: Replace the modal shell with the repo-approved shadcn Dialog primitive while retaining the existing content and submission state.
  - Strength: Supplies focus placement, trapping, Escape handling, and restoration through a maintained accessible primitive explicitly allowed by the plan.
  - Tradeoff: Adds a UI component dependency and requires checking that dismiss actions remain disabled while deletion is in flight.
  - Confidence: HIGH — the missing behaviors are directly observable in the component.
  - Blind spot: No browser-based keyboard test was run during this review.
- **Decision**: FIXED — added shadcn Dialog primitive (`npx shadcn add dialog`, radix-ui ^1.6.2) and rebuilt the modal on it, gaining focus placement/trap, Escape handling, and focus restore. Preserved the dark styling, typed-email confirm, and in-flight dismiss guard (`onOpenChange`/`onEscapeKeyDown`/`onInteractOutside` no-op while submitting; close button hidden via `showCloseButton={!submitting}`). Formatted the generated dialog.tsx to the repo Prettier config; lint + build pass.

### F5 — Lifecycle status is not synchronized across project trackers

- **Severity**: 👁️ OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Scope Discipline
- **Location**: context/foundation/roadmap.md:37
- **Detail**: This review stamps the change `impl_reviewed`, but the roadmap's at-a-glance row, S-04 detail, and Backlog Handoff still say `implementing` / impl-review pending (`roadmap.md:37,144,171`). That violates the accepted lessons requiring roadmap and Linear synchronization at every status transition. Linear MAR-10 was documented as In Progress; its live state was not independently checked because no Linear connector is available in this review context.
- **Fix**: Update all three roadmap surfaces to the reviewed state and synchronize MAR-10's status/comment before treating the lifecycle transition as complete.
- **Decision**: FIXED — roadmap status fields were already `impl_reviewed` (commit `1eee53a`); refreshed the stale "triage pending" narrative on both the S-04 detail and Backlog Handoff to record the triage outcome. Linear MAR-10 synced: description status line updated and a triage-outcome comment added; kept In Progress (no In-Review lane; branch not yet merged) — moves to Done after PR merge + `/10x-archive`.

## Verification Evidence

- `npm run lint` — **FAIL**: 41 errors and 6 warnings in pre-existing `scripts/sync-prod-to-local.mjs`.
- `npm run build` — **PASS**: Astro SSR/Cloudflare build completed successfully after allowing Astro access to its user-level telemetry config.
- `npm run format` — **NOT RUN**: the script is `prettier --write .` and would mutate unrelated files during a review.
- `prettier --check .` — **FAIL**: 36 files reported.
- Focused ESLint over the nine planned implementation files — **PASS**.
- Focused Prettier check over the nine planned implementation files — **PASS**.
- Manual checks 1.4–1.7 and 2.4–2.8 — recorded complete in commit `546e8f0`; external Supabase/browser evidence was not reproducible from the repository alone.

## Plan Comparison

All nine planned implementation files match their contracts. No planned work is missing, no implementation drift was found, and all explicit "What We're NOT Doing" guardrails were respected. The later `user_credits` migration also references `auth.users(id) ON DELETE CASCADE`, so parallel credits work does not weaken deletion completeness.
