---
change_id: testing-phase-4-critical-flow-e2e
title: Critical-flow e2e — test-plan Phase 4
status: implementing
created: 2026-09-07
updated: 2026-09-08
archived_at: null
---

## Notes

Open a change folder for rollout Phase 4 of context/foundation/test-plan.md: "Critical-flow e2e".
Risks covered: #6 — a UI refactor silently misreports paid work, a card that does not match what was actually charged or saved (roadmap S-02 Phase 3 "no behaviour change by design"; S-06 shipped a `charged` signal on three 422 bodies while scoped as presentational; hot-spot dir `src/components/summaries/` — 46 commits/30d) — plus cross-cutting flow coverage. Test types planned: e2e (Playwright).
Scope note: Phase 4's gate half (typecheck in CI, husky pre-commit/pre-push) shipped early and out of phase order on 2026-09-04. **What remains is the e2e half only** (test-plan.md:69).
Risk response intent: prove the flow works end to end — what a card claims about charge and outcome matches what the request actually did. Challenge the assumption that "no behaviour change by design" means no behaviour changed. Anti-pattern to avoid: snapshot tests — they break on every design tweak and catch none of this.
Scope decisions taken at research scoping: layer scope deferred to research (research recommends **e2e only** — see research.md Finding 1); all four flows in scope (generate→see summary, auth + credit balance, long-video confirmation, charged refusal exits); vendor faking to assume cache pre-seeding works and research the LLM gap (assumption **verified**, holds — Finding 2b).

**Scope addition — Phase 0, decided 2026-09-07 (user).** Research surfaced a defect that would otherwise be normalised by the tests written on top of it: after a charged 422 refusal the header credit balance stays stale until reload, because the refusal body carries no balance and `setCredits` runs only on the success path. This is the unfinished half of S-06 Phase 9's supersession of roadmap D14 consequence (2) — the qualitative `charged` signal shipped, the quantitative balance never did. **The plan opens with a non-e2e Phase 0** that passes `chargeFailedTranscript`'s already-computed balance through the 422 body as `creditsRemaining`, updates the hook, and narrows README:261 (which still claims the UI shows the ambiguous case). Covered by unit + integration per §1's cost×signal rule, not e2e. No e2e phase asserting a balance may start before it lands.

Rulings taken during research (2026-09-07, user): English refusal copy is **intentional** (roadmap S-06; e2e asserts the English server string). `ambiguousCharge` rendering nothing is **intentional** (spec asserts absence of both charge lines). Logging without alerting — no Sentry, Cloudflare Workers Logs only — is **acceptable for now**.

**Two rulings revised during Phase 0 implementation, 2026-09-08 (user), after reviewing the phase's own manual pass.**

1. **The English refusal copy ruling is REVERSED — refusal copy is now Polish.** Seeing `This video has no captions…` in a Polish UI, the user reopened the 2026-09-07 decision. The client used to prefer the server's English `error` over its per-status Polish table for a real reason (one status, several causes; the table had one entry per status), so the fix is a **cause code**, not a translation: the endpoint sends `code` beside `error`, and `copy.errors.codes` localises it — which keeps every distinction the English string carried. Applied to the transcript/credit refusals: the three 422 refusal reasons, the transient 422, and both 402s. **Consequence for later phases: specs assert the POLISH string, not the English server one** — the opposite of what Phases 2–4 were written against.
2. **The header credit balance now syncs client-side** (`src/lib/credits-events.ts`). Phase 0 made the form's gate truthful while the server-rendered topbar kept its pre-request number, so one page could read `Kredyty 1` beside "Nie masz już kredytów". The plan had scoped this out on the grounds that the header never syncs on *any* path; the user's call is that a page contradicting itself is worse than one uniformly stale, so the seam was built. It fixes the success path too. **Consequence for later phases: a header assertion no longer requires a navigation** — the plan's "every header assertion follows a reload" rule is now obsolete.

Not reopened, and worth restating because they look similar: the `Za tę operację pobrano kredyt.` line stays (it is S-06's shipped signal, README §Summary credits, and the ledger confirms the charge is real); `ambiguousCharge` still renders nothing.

**Extended the same day, on the user's follow-up**, to every remaining generate-endpoint exit — 400, 429, 500, 503 and the "already processed" 409 — so nothing the card can render is English. Codes are shared where several `return`s say the same thing to a user and kept separate where they do not; the two 502s and the 401 carry no code because their per-status Polish message is already correct.

3. **Signed-in users are redirected away from `/auth/signin` and `/auth/signup`** (`SIGNED_OUT_ONLY_ROUTES` in `src/middleware.ts`). Noticed during the same manual pass and reported as a suspected credit leak: the sign-in form rendered under a signed-in user's own topbar and balance. Verified it was **not** a leak — a genuinely signed-out session shows "Zaloguj się / Zarejestruj się" and zero balance nodes — but the page invited the reading, so the redirect closes it. `/auth/callback` and `/auth/confirm-email` are deliberately excluded; see the constant's doc comment.
Linear: MAR-22.
