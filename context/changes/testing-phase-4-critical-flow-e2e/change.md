---
change_id: testing-phase-4-critical-flow-e2e
title: Critical-flow e2e — test-plan Phase 4
status: preparing
created: 2026-09-07
updated: 2026-09-07
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
Linear: MAR-22.
