# Delete Account + All Data (GDPR) — Plan Brief

> Full plan: `context/changes/delete-account/plan.md`

## What & Why

Give a signed-in user a way to **permanently delete their account and all associated data** (videos, summaries, and — later — credits), satisfying the GDPR right to erasure. This is roadmap slice **S-04** / Linear **MAR-10**, a compliance guardrail that sits outside the core summary loop.

## Starting Point

The domain tables (`videos`, `summaries`) already declare `on delete cascade` FKs to `auth.users`, so deleting the auth user auto-purges all data. But the app has no way to delete the `auth.users` record: every Supabase client is the RLS-scoped anon SSR client, and no service-role key is configured. The only authenticated page is `/dashboard` (sign-out only); there is no account/settings page.

## Desired End State

From a new `/account` page's "Danger zone", the user types their email to confirm, and their account plus every `videos`/`summaries` row is irreversibly deleted; their session is cleared and they land on `/?deleted=1` with a confirmation notice. Old credentials no longer sign in, and no orphaned rows remain.

## Key Decisions Made

| Decision                     | Choice                                             | Why (1 sentence)                                                              | Source |
| ---------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------- | ------ |
| Auth-user deletion mechanism | Service-role admin call (`auth.admin.deleteUser`)  | Official Supabase path — revokes sessions, cascades data, no auth-schema SQL. | Plan   |
| Deletion semantics           | Immediate hard delete                              | Cleanest GDPR erasure; no scheduler exists to run a purge window.             | Plan   |
| Confirmation UX              | Type-to-confirm modal (React island)               | Guards a permanent action against accidental clicks; matches island convention. | Plan   |
| Post-delete flow             | Clear session → redirect `/?deleted=1` with notice | Clean teardown mirroring `signout.ts` + clear user feedback.                  | Plan   |
| Control placement            | New protected `/account` page                      | Proper home for account actions; scales past a single control.               | Plan   |
| Failure behavior             | Fail-safe — keep session, surface error            | No half-deleted state; user can retry; mirrors probe.ts's 503 guard.         | Plan   |

## Scope

**In scope:** `SUPABASE_SERVICE_ROLE_KEY` env field + admin-client factory; `POST /api/account/delete`; protected `/account` page; type-to-confirm island; `/?deleted=1` home notice; dashboard link.

**Out of scope:** soft-delete/purge window/scheduler; password re-auth; audit log; admin-initiated deletion; deletion-confirmation email; credits handling (S-05 table doesn't exist yet — cascade covers it later).

## Architecture / Approach

Backend-first. A server-only admin client (service-role key, no cookie binding) performs `auth.admin.deleteUser(context.locals.user.id)` — deleting only the caller's own id, resolved server-side. The existing cascade FKs purge all domain rows. On success the SSR client clears the session; on any failure nothing is signed out. The UI is a hand-styled React island gating the POST behind a type-your-email check, then redirecting home.

## Phases at a Glance

| Phase                                   | What it delivers                                             | Key risk                                                        |
| --------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------- |
| 1. Backend — admin client + endpoint    | Env secret, admin-client factory, fail-safe delete endpoint | Service-role key must stay server-only (bypasses RLS)          |
| 2. Frontend — `/account` + confirm + UX | Protected page, type-to-confirm island, post-delete notice  | Confirmation must reliably prevent accidental irreversible delete |

**Prerequisites:** F-01 done (cascade FKs exist); `SUPABASE_SERVICE_ROLE_KEY` obtained and set locally + as a Workers Secret.
**Estimated effort:** ~1–2 sessions across 2 phases.

## Open Risks & Assumptions

- Service-role key must be added as a Workers Secret (and optionally a CI secret); the env field is optional so builds tolerate its absence, but the feature returns 503 until it's set.
- Assumes Supabase's `auth.admin.deleteUser` reliably cascades through the domain FKs (verified by the orphan-check step).
- No recovery path — an accidental confirmed deletion is permanent; the type-to-confirm gate is the only safeguard.

## Success Criteria (Summary)

- A user can delete their account from `/account`; afterward old credentials fail to sign in.
- Zero `videos`/`summaries` rows remain for the deleted `user_id` (no orphans).
- A failed/unconfigured delete leaves the account and session fully intact (fail-safe).
