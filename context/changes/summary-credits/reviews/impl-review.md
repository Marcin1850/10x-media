<!-- IMPL-REVIEW-REPORT -->

# Implementation Review: Summary Credits Implementation Plan

- **Plan**: context/changes/summary-credits/plan.md
- **Scope**: All completed phases (1–4 of 4)
- **Date**: 2026-07-13 (triage completed 2026-07-14)
- **Verdict**: NEEDS ATTENTION → **all findings triaged and fixed** (2026-07-14)
- **Findings**: 0 critical · 5 warnings · 3 observations — 8 fixed, 0 skipped, 0 outstanding

## Verdicts

Left column is the verdict as reviewed on 2026-07-13; right column is the state after triage.

| Dimension           | At review | After triage (2026-07-14)                                          |
| ------------------- | --------- | ------------------------------------------------------------------ |
| Plan Adherence      | WARNING   | PASS — F1 atomicity restored; F5 docs reconciled to one state       |
| Scope Discipline    | PASS      | PASS — F2/F8 scope overruns recorded and accepted deliberately      |
| Safety & Quality    | WARNING   | PASS — F2, F3, F6 fixed and verified against the live local DB      |
| Architecture        | PASS      | PASS — F8 gives the signup seed feature-specific ownership          |
| Pattern Consistency | WARNING   | PASS — F7 `globals` declared explicitly                             |
| Success Criteria    | FAIL      | PASS — F4 makes `prettier --check .` a real, passing gate           |

**Open items are deployment, not code**: all five migrations remain local-only, so `npx supabase db push` is the gate before merge. The push is also the first end-to-end replay of the migration chain and the point at which F3's latent sync collision activates (already fixed in `sync-prod-to-local.mjs`, not yet exercised against a real dump).

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
- **Decision**: FIXED — added `supabase/migrations/20260714094500_grant_credits_rpc.sql` (`grant_credits(uuid, integer)`, SECURITY DEFINER, `revoke all` from public/anon/authenticated, `grant execute` to `service_role` only) and replaced the read/modify/write in `scripts/grant-credits.mjs` with a single atomic RPC call. Verified locally: migration applied; happy path `2 -> 5` reports the correct delta; unknown email and non-positive amount still fail cleanly; the anon key gets `permission denied for function grant_credits`. Test balance restored to 2. `AppDatabase` intentionally left untouched — the RPC is operator-only and must not be advertised to the Worker client.

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
- **Evidence correction (2026-07-14)**: The live local ACLs confirmed the table half of this finding — `anon` and `authenticated` held `TRUNCATE,REFERENCES,TRIGGER` on all three app tables, so `authenticated` was not read-only on `user_credits` at the privilege layer. The **function half does not hold**: `spend_credit` ACL was already exactly `postgres=X` + `authenticated=X` with no surviving `anon` grant. Reachability was assessed rather than assumed: PostgREST emits no TRUNCATE verb and no function in `public` builds dynamic SQL (0 rows matching `EXECUTE`), so the privilege was **not exploitable today** — this was defense-in-depth (capping the blast radius of any future injection surface at the caller's own rows), not a live hole. `rolcanlogin=f` is *not* the protection: PostgREST reaches these roles via `SET ROLE`, not login.
- **Decision**: FIXED — added `supabase/migrations/20260714101500_assert_least_privilege.sql` using revoke-then-grant (assert the end state, don't assume the start). Post-migration ACLs verified: `anon` now holds nothing on the app tables, `authenticated` = CRUD on videos/summaries + SELECT-only on `user_credits`, `service_role` untouched. Behaviour verified under a simulated PostgREST session (`set role authenticated` + jwt claims): own-balance read returns exactly 1 row (RLS intact), `UPDATE` denied, `TRUNCATE` now denied (previously permitted), and `spend_credit()` still succeeds (2→1, balance restored). `npm run lint` and `npm run build` both exit 0. Note: this migration also touches `videos`/`summaries`, i.e. slightly beyond the summary-credits boundary — accepted deliberately, since the additive-GRANT defect is shared across all three tables. Hosted ACLs remain unverified; both new migrations are still local-only pending `npx supabase db push`.

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
- **Evidence correction (2026-07-14)**: The mechanism was **reproduced locally**: inserting into `auth.users` seeds 1 credits row, and the simulated dumped row then fails with `duplicate key value violates unique constraint "user_credits_pkey"`. Two corrections to the original finding: (1) the recommended fix is **not implementable** — `auth.users` is owned by `supabase_auth_admin`, so `alter table auth.users disable trigger on_auth_user_created` fails as `postgres` with `must be owner of table users`; (2) the breakage is **latent, not current** — prod has no `user_credits` table yet (migrations are local-only), so the dump omits it today. It breaks the moment `npx supabase db push` runs.
- **Decision**: FIXED via the option-A variant (user-selected). `scripts/sync-prod-to-local.mjs` now wraps the piped restore with `set session_replication_role = replica` / `= origin` — the only trigger-suppression available to `postgres`, and what `pg_restore --disable-triggers` does for data-only restores anyway. Also extended the post-restore row-count check to include `public.user_credits`, so a silent balance-reseed can't pass unnoticed. Verified locally in a throwaway transaction: with suppression the trigger seeds 0 rows, the simulated prod balance of 42 lands verbatim, and `session_replication_role` returns to `origin`; test user deleted and cascade confirmed (DB back to 2 users / balances 5 and 2). `npm run lint` exits 0. Accepted tradeoff: this also suspends FK constraint triggers for the restore, so the dump's self-consistency is trusted — documented in the code comment. Still unverified against a real prod dump (blind spot stands, and cannot close until `db push`).

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
- **Evidence correction (2026-07-14)**: Re-reproduced at 36 files, but the scope is narrower than the finding implies: **every** offending file is a markdown process document under `context/`, plus `.mcp.json` and `idea-notes.md`. Nothing under `src/`, `scripts/`, or `supabase/` is affected — the feature's product source was always Prettier-clean, so this was never a code-quality defect. Root cause identified: the repo has **no `.prettierignore`**, while lint-staged already runs `prettier --write` on `*.md` at commit time — hence docs touched by commits are clean and historical agent-generated docs drifted. The "35 files including summary-credits artifacts" phrasing was accurate but misleading: those artifacts are review/plan markdown, not shipped code.
- **Decision**: FIXED via the exclusion variant (user-selected, over the blanket-reformat option). Added `.prettierignore` excluding `context/**` — those are skill-generated process docs whose formatting churn adds diff noise to every review write without improving the code — and formatted the two genuinely in-scope files (`.mcp.json`, `idea-notes.md`, 5 lines total). `npx prettier --check .` now reports "All matched files use Prettier code style!", so it is usable as a non-mutating verification/CI gate covering `src/`, `scripts/`, `supabase/`, and root docs. This deliberately avoids the 36-file mechanical rewrite across historical plans/PRD/reviews. Note the plan's phases 2–4 "Prettier clean" rows were never a real gate (`npm run format` writes fixes and exits 0); F5's documentation pass should reflect that.

### F5 — Setup and lifecycle documentation contradict the implemented state

- **Severity**: ⚠️ WARNING
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Adherence
- **Location**: README.md:116
- **Detail**: README says the project needs no tables or migrations and uses only `auth.users`, contradicting the existing domain and credits migrations. `change.md:77–80` says both credits migrations are local-only while `roadmap.md` says they were pushed to cloud. The plan's Migration Notes also still describe a single migration although the approved grants migration was added.
- **Fix**: Update README, `change.md`, and the plan's Migration Notes to one consistent database/deployment state.
- **Evidence correction (2026-07-14)**: All three contradictions verified, and the finding under-counted. `roadmap.md:172` is the actively-wrong one — it claimed "DB migrations pushed to cloud" while F3's evidence proved prod has no `user_credits` table; `change.md` was right and the roadmap was wrong. `change.md`'s list was itself stale by two, since F1 and F2 each added a migration (4 total, not 2). Excluded from scope: `roadmap.md:56` also says "no migrations", but it is an explicitly dated `2026-06-11` baseline snapshot — legitimately historical, so it was left untouched rather than "corrected" into a lie about when the state changed.
- **Decision**: FIXED — reconciled all four documents to one state (4 migrations, local-only, `db push` pending). `README.md`: replaced the false "no tables or migrations are required" line with an `npx supabase migration up` step, renumbered as step 5 so it precedes the teardown step rather than following it; kept deliberately general (no table enumeration) per user direction, so it won't re-drift as tables are added. `roadmap.md:172`: corrected to local-only and added `db push` to the remaining-work list. `change.md`: enumerated all four migrations with their origins, and recorded that prod having no `user_credits` table is *why* F3's collision is latent rather than live. `plan.md:261`: kept the original single-migration intent as the plan of record and appended an "as built" table showing the four, including the F2 migration's accepted scope overrun into `videos`/`summaries`.

### F6 — A display-only credits read can take down the dashboard

- **Severity**: 🔷 OBSERVATION
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/pages/dashboard.astro:17
- **Detail**: Missing rows render as an em dash, but a PostgREST/network error thrown by `getBalance` is not caught and fails the entire protected dashboard request.
- **Fix**: Catch the display-only balance error, log it, and keep `credits = null` so the dashboard renders the documented fallback.
- **Decision**: FIXED — wrapped the `getBalance` call in `dashboard.astro` with `try`/`catch`, logging via `console.error` and leaving `credits = null` so the page renders the documented `—`. Corrected the stale comment above it, which claimed `null` covered a failed read when in fact it only covered the missing-row and unconfigured-Supabase cases (the latter via the `if (supabase)` guard). Scope was deliberately held to the dashboard: `probe.ts:49` calls the same `getBalance` as the **enforcement gate**, where throwing is the correct behaviour — catching there would fail-open and let generation run without a credit check. That asymmetry is now recorded in the code comment so a future reader doesn't "consistency-fix" the gate. Matched the existing logging convention at `probe.ts:82` (explicit `eslint-disable-next-line no-console` at the log site) rather than leaving the repo's first standing `no-console` warning. `npm run lint` 0 errors/0 warnings, `npm run build` and `npx prettier --check .` both green. Not runtime-exercised: the error path was reasoned from `credits.ts:17` (`throw` on any PostgREST error), not reproduced by forcing a live DB failure.

### F7 — ESLint config relies on a transitive `globals` dependency

- **Severity**: 🔷 OBSERVATION
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: eslint.config.js:9
- **Detail**: The config imports `globals` directly, but `package.json` does not declare it. It currently works because npm hoists ESLint's transitive dependency; a dependency-tree or package-manager change can make lint fail while every other imported config package is direct.
- **Fix**: Add `globals` as an explicit dev dependency.
- **Evidence correction (2026-07-14)**: Confirmed, and worse than described — the risk was already realised, not merely hypothetical. Two copies exist in the tree (`eslint-plugin-astro@1.7.0 → globals@16.5.0`, `eslint@9.39.4 → @eslint/eslintrc@3.3.5 → globals@14.0.0`), and the **hoisted top-level copy that `eslint.config.js:9` actually imported was 14.0.0** — two majors behind, selected by npm hoisting order rather than any decision. It worked only because `globals.node` (the sole usage, in `scriptsConfig`) exists in both majors.
- **Decision**: FIXED — declared `globals@^16.5.0` as an explicit devDependency (user-selected over pinning the incumbent `^14.0.0`). Top-level resolution moved 14.0.0 → 16.5.0 and now dedupes with `eslint-plugin-astro`; `@eslint/eslintrc` keeps its own nested 14.0.0, which is correct and none of our concern. The v14→v16 bump is the one real risk here (v15 pruned entries from `globals.node`), and it is covered: `scriptsConfig` is the only consumer, so a clean `no-undef` pass over `scripts/*.mjs` is direct evidence nothing the scripts use was dropped. `npm run lint` exits 0 with no warnings, `npm run build` green.

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
- **Evidence correction (2026-07-14)**: Confirmed, with two facts that make the fix cheaper than the finding assumed. (1) Local `auth.users` carries exactly one non-internal trigger — ours — so there is no collision to untangle. (2) **Nothing has been pushed to cloud**, so the stated tradeoff ("requires inspecting the deployed database before renaming shared-looking objects") does not apply: there is no deployed generic-named object. Renaming is free at this moment and stops being free after the first `npx supabase db push`, which makes this the right time to act on an OBSERVATION-severity finding.
- **Decision**: FIXED — added `supabase/migrations/20260714113000_rename_credits_signup_trigger.sql` (fix-forward, user-selected over editing the never-pushed original in place; keeps the local test users the F1–F3 verifications depend on and stays consistent with how F1/F2 were handled). Installs `handle_new_user_credits()` / `on_auth_user_credits_created`, then drops the generic pair with **RESTRICT semantics deliberately** (`drop function if exists public.handle_new_user()` without `cascade`) so that if anything unexpected still depends on the generic function the migration fails loudly instead of silently deleting another feature's automation — the exact failure mode this finding is about. Verified locally: migration applied; end state is exactly `handle_new_user_credits` + `on_auth_user_credits_created` with both generic names gone; and the rename is behaviour-preserving — a throwaway `auth.users` insert still seeds `balance = 5`, with the transaction rolled back (DB back to 2 users, balances untouched). Triggers fire in name order, so a future `on_auth_user_profiles_created` can now coexist rather than collide.
  - **Residual blind spot**: the full migration chain has not been replayed from scratch — `npx supabase db reset` would prove it but wipes the local test users, so it was not run unilaterally. The first `db push` will be the first end-to-end replay. Reasoning holds (the rename only depends on `public.user_credits` from `20260712175240` and on `auth.users`, both ordered correctly), but it is reasoning, not observation. Hosted out-of-band functions/triggers also remain un-inventoried; if prod *did* carry an unrelated `handle_new_user`, migration `20260712175240` would clobber it on push before this one drops it. Low risk for a project whose roadmap records auth-only cloud state, but unverified.

## Post-triage correction (2026-07-14) — F3/F5 evidence was wrong about prod

Discovered while running `npx supabase db push`. **Two of the five migrations were already live on the
cloud project** (`20260712175240_user_credits`, `20260712182527_grant_table_privileges`, pushed
2026-07-12). Verified with `npx supabase migration list` and `npx supabase db dump` against project
`ukbptccdffiigkdekzcn`: prod has `user_credits`, `spend_credit()`, and `handle_new_user()`.

**The error chain**: F3's evidence correction asserted "prod has no `user_credits` table yet" from
local evidence alone, never querying prod. F5 then treated that as ground truth and "reconciled"
`roadmap.md:172` — which had correctly said the migrations were pushed — into the false claim. The
2026-07-14 sync commit `27e93d9` spread it to `roadmap.md:160`, `change.md`, and Linear MAR-11. The
review's own habit of demanding observed evidence was applied to every local claim and skipped for the
one remote claim.

Corrections to the findings above (the fixes all stand; only the evidence changes):

- **F3** — the collision is **live, not latent**. Prod has `user_credits`, so its dump includes the
  table and `npm run db:sync-from-prod` has been broken since 2026-07-12. The
  `session_replication_role` fix handles it; the "activates on the first push" framing was wrong.
- **F2** — the "function half does not hold" conclusion is **local-only and false on prod**. Cloud
  default privileges granted `ALL` on all three app tables to **both** `anon` and `authenticated`,
  plus `GRANT ALL ON FUNCTION public.spend_credit() TO anon`. Still not exploitable — RLS exposes no
  UPDATE policy, and `spend_credit()` as `anon` resolves `auth.uid()` to null and updates no row — but
  the prod privilege surface is wider than reviewed, which strengthens rather than weakens the fix.
  Revoke-then-grant asserts the end state, so the migration is correct against the differing start.
- **F8** — the "hosted out-of-band triggers un-inventoried" blind spot is **closed**: prod's
  `public.handle_new_user()` body is ours (seeds `user_credits`), so the 2026-07-12 push clobbered
  nothing.
- **F5** — the "one consistent state" it established was the wrong state. Documents re-reconciled to
  2 pushed / 3 pending.

Rule worth carrying: a claim about a remote system requires remote evidence. `migration list` costs
seconds and would have caught this at F3.

### The false evidence had already cost a real fix (found 2026-07-14, post-push)

F2's stated fix was to revoke `spend_credit()` execution from `public`/`anon` **and** tighten the table
grants. Only the table half shipped — the function half was dropped during implementation *because*
the local ACL check showed no `anon` grant to revoke. Post-push verification against prod found
`GRANT ALL ON FUNCTION public.spend_credit() TO anon` still standing after `assert_least_privilege`
had supposedly asserted least privilege. Not exploitable (`auth.uid()` is null for `anon`, so the call
decrements nothing), but it is the exact defense-in-depth gap F2 was raised to close, left open by
reasoning from the wrong environment.

Closed by `20260714140000_assert_least_privilege_functions.sql`: `spend_credit()` is now
`authenticated`-only, `handle_new_user_credits()` is trigger-only, and the cloud
`ALTER DEFAULT PRIVILEGES ... GRANT ALL ... TO anon` entries that produced the grant in the first
place are revoked, so the assertion no longer decays as the schema grows. Verified locally before the
push (trigger still seeds 5; `authenticated` still spends 5→4; `anon` gets `permission denied for
function spend_credit`) and on prod after it (`db dump` shows no `anon` grant on any app object and no
`TO anon` default-privilege line remaining).

Second-order lesson: when evidence turns out to be wrong, re-check what was **decided** on it, not just
what was **written** about it. The F3/F5 correction fixed the documents; the scoped-down F2 fix was the
thing that actually mattered.

## Accepted residual risk

The read-gate/post-save-debit concurrency window and fail-open response after a persisted summary match the reviewed plan. The plan explicitly accepts that risk for the closed-registration, single-user MVP and requires revisiting it before registration opens or S-01 broadens generation; it is not counted again as implementation drift.
