<!-- IMPL-REVIEW-REPORT -->

# Implementation Review: Summary Credits Implementation Plan

- **Plan**: context/changes/summary-credits/plan.md
- **Scope**: All completed phases (1–4 of 4)
- **Date**: 2026-07-13
- **Verdict**: NEEDS ATTENTION
- **Findings**: 0 critical · 5 warnings · 3 observations

## Verdicts

| Dimension           | Verdict |
| ------------------- | ------- |
| Plan Adherence      | WARNING |
| Scope Discipline    | PASS    |
| Safety & Quality    | WARNING |
| Architecture        | PASS    |
| Pattern Consistency | WARNING |
| Success Criteria    | FAIL    |

## Verification

| Criterion                   | Result          | Evidence                                                                                                                                              |
| --------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npx supabase migration up` | PASS            | Local database is up to date.                                                                                                                         |
| `npm run lint`              | PASS            | ESLint exited 0; only the existing `astro-eslint-parser` project-service notices were printed.                                                        |
| `npm run build`             | PASS            | Astro SSR/Cloudflare production build completed successfully; sitemap emitted its existing missing-`site` warning.                                    |
| Prettier clean              | FAIL            | `npm run format` rewrote tracked files; after restoring that verification-only rewrite, `npx prettier --check .` reported 35 files with style issues. |
| Manual criteria             | PASS (recorded) | All 14 manual Progress rows are checked and SHA-stamped. Commits `b760320` and `dfa2e7f` record live/user confirmation.                               |

## Findings

### F1 — Operator refill is not atomic

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Plan Adherence
- **Location**: scripts/grant-credits.mjs:73
- **Detail**: The plan requires a database-side `balance = balance + amount` update. The script instead reads the balance, adds in JavaScript, and writes the absolute result at lines 73–94. A simultaneous spend or second grant can be overwritten, so the resulting delta can differ from the requested grant.
- **Fix**: Add an atomic database RPC that performs `balance = balance + amount returning balance`, restrict execution to `service_role`, and call it from the operator script.
  - Strength: Preserves the exact grant under concurrent spends/grants and keeps increment authority offline.
  - Tradeoff: Requires a fix-forward migration plus script/type updates.
  - Confidence: HIGH — the race follows directly from the current read/modify/write sequence.
  - Blind spot: Concurrent operator grants were not reproduced against the live cloud project.
- **Decision**: PENDING

### F2 — Table and function grants are additive, not deterministic least privilege

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: supabase/migrations/20260712175240_user_credits.sql:70
- **Detail**: `REVOKE ... FROM public` does not remove explicit role grants, and the grants migration only adds privileges. The implementation notes that local API roles already had `TRUNCATE/REFERENCES/TRIGGER/MAINTAIN`; those privileges remain after `GRANT SELECT`, so `authenticated` is not actually read-only at the table-privilege layer. Existing explicit `anon` function execution would also survive. RLS/PostgREST still block the reviewed client paths, but the migration does not reproducibly establish the boundary it documents.
- **Fix**: In a fix-forward migration, revoke existing privileges from `anon`/`authenticated` on the app tables and explicitly revoke `spend_credit()` execution from `public`, `anon`, and unnecessary roles before re-granting the exact intended privileges.
  - Strength: Makes the privilege boundary deterministic across local and hosted Supabase defaults.
  - Tradeoff: Must enumerate every privilege the app legitimately needs to avoid disrupting existing API access.
  - Confidence: HIGH — PostgreSQL `GRANT` is additive and the retained local privileges are documented in `change.md`.
  - Blind spot: Hosted-project ACLs were not queried during this review.
- **Decision**: PENDING

### F3 — Production-to-local restore now collides with the signup seed trigger

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: scripts/sync-prod-to-local.mjs:79
- **Detail**: The data-only restore includes both `auth.users` and `public.user_credits`. Restoring users fires `on_auth_user_created` and seeds credit rows; restoring the dumped credit rows then conflicts on the primary key. The single transaction prevents a partial restore, but the sync command becomes unusable once credit rows exist.
- **Fix**: Disable only `on_auth_user_created` inside the trusted single-transaction restore, stream the dump, re-enable it before commit, and verify the restored credit-row count.
  - Strength: Preserves production balances while avoiding a broad trigger/constraint bypass.
  - Tradeoff: The restore wrapper becomes more complex and must guarantee trigger re-enablement on failure.
  - Confidence: HIGH — the dump includes both schemas and the trigger runs on every `auth.users` insert.
  - Blind spot: A fresh production dump was not restored during this review.
- **Decision**: PENDING

### F4 — The repository is not Prettier-clean

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Success Criteria
- **Location**: N/A
- **Detail**: The plan marks Prettier clean in phases 2–4. Running the exact `npm run format` command changed tracked files; after restoring those verification-only edits, `npx prettier --check .` failed on 35 files, including summary-credits artifacts. The formatter command exits 0 because it writes fixes, so its prior SHA-stamped rows did not prove a clean tree.
- **Fix**: Normalize the 35 reported files in a dedicated formatting commit, then use `prettier --check` as the non-mutating verification/CI gate.
  - Strength: Makes the cleanliness claim testable and prevents silent repository-wide rewrites during reviews.
  - Tradeoff: Produces a broad mechanical diff touching historical context documents.
  - Confidence: HIGH — reproduced by both the write command and the check-only command.
  - Blind spot: Some files may intentionally preserve legacy formatting and require exclusions instead.
- **Decision**: PENDING

### F5 — Setup and lifecycle documentation contradict the implemented state

- **Severity**: ⚠️ WARNING
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Adherence
- **Location**: README.md:116
- **Detail**: README says the project needs no tables or migrations and uses only `auth.users`, contradicting the existing domain and credits migrations. `change.md:77–80` says both credits migrations are local-only while `roadmap.md` says they were pushed to cloud. The plan's Migration Notes also still describe a single migration although the approved grants migration was added.
- **Fix**: Update README, `change.md`, and the plan's Migration Notes to one consistent database/deployment state.
- **Decision**: PENDING

### F6 — A display-only credits read can take down the dashboard

- **Severity**: 🔷 OBSERVATION
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/pages/dashboard.astro:17
- **Detail**: Missing rows render as an em dash, but a PostgREST/network error thrown by `getBalance` is not caught and fails the entire protected dashboard request.
- **Fix**: Catch the display-only balance error, log it, and keep `credits = null` so the dashboard renders the documented fallback.
- **Decision**: PENDING

### F7 — ESLint config relies on a transitive `globals` dependency

- **Severity**: 🔷 OBSERVATION
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: eslint.config.js:9
- **Detail**: The config imports `globals` directly, but `package.json` does not declare it. It currently works because npm hoists ESLint's transitive dependency; a dependency-tree or package-manager change can make lint fail while every other imported config package is direct.
- **Fix**: Add `globals` as an explicit dev dependency.
- **Decision**: PENDING

### F8 — Generic signup-trigger names can replace unrelated Supabase automation

- **Severity**: 🔷 OBSERVATION
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Architecture
- **Location**: supabase/migrations/20260712175240_user_credits.sql:21
- **Detail**: `public.handle_new_user` and `on_auth_user_created` are common Supabase profile-seeding names. `create or replace function` plus `drop trigger` can overwrite unrelated out-of-band signup automation. No collision exists in repository migrations, so this is a portability risk rather than a demonstrated current failure.
- **Fix**: Use a fix-forward migration to install feature-specific names such as `handle_new_user_credits` / `on_auth_user_credits_created`, then remove only the credits-owned generic objects after verifying no external dependency.
  - Strength: Gives the feature clear ownership and avoids collisions with profile/onboarding triggers.
  - Tradeoff: Requires inspecting the deployed database before renaming shared-looking objects.
  - Confidence: MED — the names are generic, but no repository-defined collision exists.
  - Blind spot: Out-of-band hosted-database functions/triggers were not inventoried.
- **Decision**: PENDING

## Accepted residual risk

The read-gate/post-save-debit concurrency window and fail-open response after a persisted summary match the reviewed plan. The plan explicitly accepts that risk for the closed-registration, single-user MVP and requires revisiting it before registration opens or S-01 broadens generation; it is not counted again as implementation drift.
