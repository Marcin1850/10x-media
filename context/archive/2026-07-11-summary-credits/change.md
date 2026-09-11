---
change_id: summary-credits
title: Summary credits
status: archived
created: 2026-07-11
updated: 2026-09-11
archived_at: 2026-09-11T00:06:49Z
---

## Notes

<!-- Free-form notes for this change: links, ad-hoc context, decisions that don't belong in research/frame/plan. -->

### Implementation status (2026-07-12)

All 4 phases implemented; each phase committed separately on branch `chore/summary-credits`.
Automated gates green (`npm run lint`, `npm run build`, `npx supabase migration up`, Prettier).
`status` was kept `implementing` (not `implemented`) **at this date** because the user-confirmable
manual Progress rows in `plan.md` were still open — see breakdown below. It has since advanced to
`impl_reviewed` (frontmatter is authoritative).

Commits:

- `6dd72c0` chore(lint): make scripts/\*.mjs lintable + fix pre-existing red `sync-prod-to-local.mjs` (prereq so the lint gate is green).
- `414ac92` P1 data layer — `user_credits` table, owner-only SELECT RLS, seed trigger + backfill, atomic `spend_credit()`.
- `b6e1601` P2 credits service + 402 read-gate / spend-on-success in `probe.ts` + `AppDatabase` types.
- `a61d781` P3 dashboard balance readout.
- `49250e6` P4 `scripts/grant-credits.mjs` operator script + npm task + `.env.example` + README.
- `60b8f3e` fix — grants migration (`20260712182527_grant_table_privileges.sql`); see Decisions.
- `2b5910a` chore — recorded P4 SHAs into plan Progress.

### Decision: grants migration added (approved 2026-07-12)

Discovered during verification: the local Supabase stack grants API roles (anon/authenticated/
service_role) only `Dxtm` (TRUNCATE/REFERENCES/TRIGGER) — **no SELECT/INSERT/UPDATE/DELETE** — on
`postgres`-created tables, so RLS-scoped PostgREST reads/writes returned 403 on **all** app tables
(`videos`/`summaries` too, not just `user_credits`). User approved adding an idempotent grants
migration covering all three app tables: `authenticated` = CRUD on videos/summaries, SELECT-only on
`user_credits` (balance stays unforgeable); `service_role` = full access. Harmless where prod already
grants. This also unblocked the pre-existing F-02 flow locally.

### Manual verification — P1/P4 confirmed, P2/P3 still open

Re-verified live over the real DB/PostgREST path on 2026-07-12 (balances restored to 5 afterward) and
**user-confirmed** — `plan.md` Progress rows now ticked:

- P1: 1.4 seed trigger (new `auth.users` insert → row at 5), 1.5 backfill (2 users, 0 missing), 1.6
  spend 5→4→3→2→1→0→−1 sentinel (never negative), 1.7 RLS own-row-only read (1 visible row) + direct
  UPDATE rejected (permission denied — `authenticated` has no UPDATE grant). ✅ confirmed
- P4: 4.3 grant-credits happy path (5→7, then restored), 4.4 non-positive amount + unknown email fail
  cleanly (exit 1), 4.5 missing `SUPABASE_SERVICE_ROLE_KEY` fails fast (exit 1). ✅ confirmed

**P2/P3 now confirmed (2026-07-13)** — user-run over the live dev server; `plan.md` rows ticked and
SHA-stamped `dfa2e7f`:

- P2: 2.4 live `POST /api/summaries/probe` → 402 at zero credits with **no** paid call; 2.5 success
  returns `creditsRemaining` and decrements by exactly 1; 2.6 transcript-422 leaves balance unchanged;
  2.7 signed-out → 401 (verified live via curl.exe). ✅ confirmed
- P3: 3.4 dashboard shows current balance; 3.5 decrements after a generation; 3.6 no theme
  regression. ✅ confirmed

All 4 phases now fully verified (automated + manual). `status: implemented`.

### Blocker found + fixed during P2/P3 verification: cross-fetch CJS in workerd dev (`ea9ce1c`)

First live `POST /api/summaries/probe` in `astro dev` returned 500 `exports is not defined` at
route-module load — a **pre-existing F-02** bug: `@supadata/js` pulls in `cross-fetch` (CommonJS),
which the `@astrojs/cloudflare` workerd dev module runner can't evaluate. `npm run build` masked it
(the prod bundler handles CJS interop). Not caused by summary-credits — `dashboard.astro` (uses the
new `credits.ts`) loads fine; the fault is isolated to the transcript chain, identical on `master`.

Fixed in `ea9ce1c` (committed as `fix(dev):` F-02 scope, per user): alias `cross-fetch` → a
native-fetch ESM shim (`src/lib/shims/cross-fetch.mjs`) + `ssr.optimizeDeps.exclude` `@supadata/js`
in `astro.config.mjs`. Behaviour-preserving (workerd has global `fetch`; supadata only used it as a
fallback); lint/build/prettier green. **2.7 (signed-out → 401) verified via curl** post-fix; 2.4–2.6
+ P3 still need the user's live/browser run (restart the dev server first to load the config change).

### Deploy / config status — corrected 2026-07-14 against the live cloud project

**Verified via `npx supabase migration list` + `npx supabase db dump` against project
`ukbptccdffiigkdekzcn`.** The first two migrations were pushed on 2026-07-12, the remaining four on
2026-07-14 — nothing is pending:

| Migration                                          | Origin                                          | Cloud state           |
| -------------------------------------------------- | ----------------------------------------------- | --------------------- |
| `20260712175240_user_credits.sql`                  | table, RLS, `spend_credit()`, trigger, backfill | **pushed** 2026-07-12 |
| `20260712182527_grant_table_privileges.sql`        | table grants                                    | **pushed** 2026-07-12 |
| `20260714094500_grant_credits_rpc.sql`             | atomic operator `grant_credits()` RPC (F1)      | **pushed** 2026-07-14 |
| `20260714101500_assert_least_privilege.sql`        | revoke-then-grant least privilege, tables (F2)  | **pushed** 2026-07-14 |
| `20260714113000_rename_credits_signup_trigger.sql` | feature-specific trigger/function names (F8)    | **pushed** 2026-07-14 |
| `20260714140000_assert_least_privilege_functions.sql` | function grants + default privileges (F2 gap) | **pushed** 2026-07-14 |

**All 6 migrations are live on cloud as of 2026-07-14** — local and remote histories match
(`npx supabase migration list`). Post-push state verified by `db dump`: `anon` holds nothing on the
app tables or their functions; `authenticated` is SELECT-only on `user_credits` and CRUD on
`videos`/`summaries`; `grant_credits()` is `service_role`-only; `handle_new_user_credits` /
`on_auth_user_credits_created` are the only signup objects.

**Correction to an error chain that ran through F3 → F5 → the 2026-07-14 roadmap/Linear sync.** This
file, `roadmap.md`, and Linear MAR-11 all previously claimed the migrations were local-only and that
prod had no `user_credits` table. That was **false**, and the original roadmap line ("DB migrations
pushed to the cloud project") was right all along. The error originated in impl-review **F3's**
evidence correction, which asserted prod had no table **without querying prod**; **F5** then
"reconciled" the documents to that false state, and the sync commit `27e93d9` propagated it further.
Root cause: an assertion about a remote system was accepted from local evidence alone.

Consequences of the correction:

- **F3's collision is live, not latent.** Prod has `user_credits`, so a prod dump includes it and
  `npm run db:sync-from-prod` has been broken since 2026-07-12. The `session_replication_role` fix in
  `10f91f4` handles it; only the "latent, activates on first push" framing was wrong.
- **F2's evidence correction was local-only and does not hold on prod.** Cloud default privileges
  granted `ALL` on all three app tables to **both** `anon` and `authenticated`, plus
  `GRANT ALL ON FUNCTION public.spend_credit() TO anon` — so the "function half does not hold; no
  surviving `anon` grant" conclusion is true locally and false on prod. Not exploitable (RLS has no
  UPDATE policy; `spend_credit()` as `anon` resolves `auth.uid()` to null and touches no row), but the
  defense-in-depth case is stronger on prod than the review believed. `assert_least_privilege` is
  revoke-then-grant, so it asserted the correct **table** end state regardless of the differing start.
  Its **function** half had been dropped during implementation *because of* the false local evidence,
  so `anon` kept EXECUTE on `spend_credit()` on prod even after that migration —
  caught by post-push verification and closed by `20260714140000` (which also revokes the cloud
  default privileges that granted it, so future tables/functions no longer re-grant `anon`).
- **F8's clobber blind spot is closed.** Prod's `public.handle_new_user()` body is ours (it seeds
  `user_credits`), so migration `20260712175240` did not overwrite unrelated automation on push.

- Add `SUPABASE_SERVICE_ROLE_KEY` to the local `.env` (the `service_role` key from
  `npx supabase status` / dashboard → Settings → API) before running `npm run grant-credits`.

### Impl-review triage complete (2026-07-14)

All 8 findings (5 warnings, 3 observations; 0 critical) triaged and fixed in `10f91f4` — see
`reviews/impl-review.md` for per-finding decisions and evidence. Every review dimension is now PASS.
Three of the fixes added migrations (F1 `grant_credits()` RPC, F2 least-privilege assertion, F8
signup-trigger rename), taking the change's migration count to 5 at that point. A sixth
(`20260714140000_assert_least_privilege_functions.sql`) followed in `b2f3900` to close the F2
function-grant gap, for **6 in total** — see the Deploy / config status section above.

### Roadmap / Linear sync (done 2026-07-14, corrected same day)

- `context/foundation/roadmap.md`: S-05 Status + Backlog Handoff synced to triage-complete.
  The first pass (`27e93d9`) wrongly rewrote both lines to "local-only" on the strength of F5's
  reconciliation; corrected against the live project — all 6 migrations are pushed, see the
  Deploy / config status section above.
- Linear **MAR-11**: description synced + completion comment posted. The first pass also removed the
  description's "pushed to cloud" line as false — but that line was **correct**, and it has since been
  restored. Status was left **In Progress** pending `db push` and the merge to `master`; both landed
  2026-07-14 (`482b686`), and MAR-11 is now **Done**.
