---
change_id: testing-phase-3-data-boundary
title: Test rollout phase 3 — data-boundary authorization
status: planned
created: 2026-09-05
updated: 2026-09-05
archived_at: null
---

## Notes

Open a change folder for rollout Phase 3 of context/foundation/test-plan.md: "Data-boundary authorization".
Risks covered: #4 — one account's summaries or transcripts become reachable by another (PRD *Success Criteria → Guardrails*, *Access Control*, NFR; roadmap S-05 note on default privileges for new tables; hot-spot dir `supabase/migrations/` — 28 commits/30d). Test types planned: integration against the local Supabase stack with two seeded accounts.
Risk response intent: prove that a request authenticated as one account cannot read another's rows, and that a newly added table does not inherit blanket access. Challenge the assumption that per-user policies on the two original domain tables cover the user-agnostic shared tables added later by S-07 and S-09. Anti-pattern to avoid: testing the service function instead of the policy — the service is not the trust boundary.
Linear: MAR-21 (already moved to In Progress).
