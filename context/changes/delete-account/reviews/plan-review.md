<!-- PLAN-REVIEW-REPORT -->
# Plan Review: Delete Account + All Data (GDPR)

- **Plan**: context/changes/delete-account/plan.md
- **Mode**: Deep
- **Date**: 2026-07-11
- **Verdict**: SOUND
- **Findings**: 0 critical, 1 warning, 2 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| End-State Alignment | PASS |
| Lean Execution | PASS |
| Architectural Fitness | PASS |
| Blind Spots | WARNING |
| Plan Completeness | PASS |

## Grounding

12/12 paths ✓, 6/6 symbols ✓ (cascade FKs, `PROTECTED_ROUTES`, env schema, `@supabase/supabase-js` ^2.99.1, probe.ts pattern, signout.ts pattern), brief↔plan ✓. Progress↔Phase contract valid (1 Progress block, phase headings match, all 15 success criteria mirrored as 1.1–1.7 / 2.1–2.8). Nits (not findings): cascade FK is at migration line 6, not 5; `src/components/hooks/` doesn't exist yet (plan calls it "currently empty").

## Findings

### F1 — "Fail-safe" story breaks after the point of no return

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Blind Spots
- **Location**: Phase 1 — Delete-account endpoint (flow step 4) + Implementation Approach ("on any failure it leaves the account and session untouched")
- **Detail**: The failure story only covers failures before `deleteUser`. Step 4 is "on success: clear the session via the SSR client ... then return 200", but after `admin.deleteUser` succeeds, the SSR client's `signOut()` calls Supabase's logout endpoint with a JWT whose user no longer exists — it can legitimately return an error (`admin.deleteUser` already revoked the sessions). If the implementer treats that error like the others and returns 500, the island shows "delete failed — retry" for an account that IS deleted, and a retry then hits 401/500 confusingly. The "fail-safe" framing can't hold past the point of no return, and the plan doesn't say which way to fall.
- **Fix**: Amend step 4's contract: after `deleteUser` succeeds, session teardown is best-effort — ignore/log `signOut` errors and ALWAYS return `200 { ok: true }`. Note that stale cookies are harmless: middleware's `supabase.auth.getUser()` fails for a deleted user, so `locals.user` resolves to null on the next request either way.
- **Decision**: FIXED — plan.md amended (endpoint flow step 4 + "Order: delete, then tear down" bullet in Critical Implementation Details)

### F2 — CSRF on a destructive cookie-auth endpoint rests on an implicit Astro default

- **Severity**: ℹ️ OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Blind Spots
- **Location**: Phase 1 — Delete-account endpoint
- **Detail**: `POST /api/account/delete` is authenticated purely by session cookies and reads no body, so a cross-site form POST is the classic CSRF shape for it — and unlike signout, the blast is irreversible account deletion. What protects it today is Astro's `security.checkOrigin`, ON by default in Astro 5+/6, which blocks cross-origin form-content-type POSTs. `astro.config.mjs` sets no `security` block, so the default holds — but the plan never names this dependency, and a future config tweak disabling it would silently expose the endpoint.
- **Fix**: Add one line to Critical Implementation Details: CSRF is covered by Astro's default `security.checkOrigin` — do not disable it; the endpoint intentionally reads no body.
- **Decision**: FIXED — CSRF bullet added to Critical Implementation Details in plan.md

### F3 — No roadmap/Linear sync step (recurring lessons.md rule)

- **Severity**: ℹ️ OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Whole plan (no lifecycle-sync mention)
- **Detail**: Three accepted lessons.md rules ("sync roadmap.md and Linear on every status transition", "update Linear status + comment at each lifecycle step", "sync Backlog Handoff") apply to this change (S-04 / MAR-10), and this exact drift has bitten twice before. The plan never mentions MAR-10, roadmap status flips, or the Backlog Handoff. `/10x-implement` should honor lessons.md anyway, but a one-line reminder in the plan makes it deterministic.
- **Fix**: Add a note (e.g. under Migration Notes or each phase's Implementation Note): on start/finish of each phase, sync roadmap.md S-04 status + Backlog Handoff and post a MAR-10 Linear comment per lessons.md.
- **Decision**: ACCEPTED — will be handled during implementation via lessons.md (no plan edit)
