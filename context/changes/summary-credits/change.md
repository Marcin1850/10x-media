---
change_id: summary-credits
title: Summary credits
status: implementing
created: 2026-07-11
updated: 2026-07-12
archived_at: null
---

## Notes

<!-- Free-form notes for this change: links, ad-hoc context, decisions that don't belong in research/frame/plan. -->

### Implementation status (2026-07-12)

All 4 phases implemented; each phase committed separately on branch `chore/summary-credits`.
Automated gates green (`npm run lint`, `npm run build`, `npx supabase migration up`, Prettier).
`status` is kept `implementing` (not `implemented`) because the user-confirmable manual
Progress rows in `plan.md` are still open — see breakdown below.

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

Still open — need a browser and/or paid API keys (Supadata/OpenRouter), so left for the user:

- P2: 2.4 live `POST /api/summaries/probe` → 402 at zero credits with **no** paid call; 2.5 success
  returns `creditsRemaining` and decrements by exactly 1; 2.6 transcript-422 / LLM error leaves
  balance unchanged; 2.7 signed-out → 401.
- P3: 3.4 dashboard shows current balance; 3.5 decrements after a generation; 3.6 no theme regression.

### Deploy / config TODO (not done here)

- Both new migrations (`20260712175240_user_credits.sql`, `20260712182527_grant_table_privileges.sql`)
  are applied **locally only** — run `npx supabase db push` to apply them to the cloud project.
- Add `SUPABASE_SERVICE_ROLE_KEY` to the local `.env` (the `service_role` key from
  `npx supabase status` / dashboard → Settings → API) before running `npm run grant-credits`.

### Roadmap / Linear sync TODO (not done here — per lessons.md)

- `context/foundation/roadmap.md`: update slice **S-05** status + Backlog Handoff once manual
  verification is confirmed.
- Linear: no S-05 issue ID was available in this session — needs the issue ID to move status +
  post a completion comment. Held deliberately (external side-effect + verification pending).
