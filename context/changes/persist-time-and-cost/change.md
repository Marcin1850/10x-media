---
change_id: persist-time-and-cost
title: Persist generation time and provider cost per summary (S-07)
status: plan_reviewed
created: 2026-07-28
updated: 2026-07-28
archived_at: null
---

## Notes

S-07 from `context/foundation/roadmap.md` (F4, F5, T3, T4). Note the roadmap originally
named this change `summary-generation-telemetry`; the change-id here is `persist-time-and-cost`.

Origin: `context/changes/transcript-llm-probe/reviews/impl-review-phase-4.md:57-75` — the
F-02 live run measured 33 s vs 254 s, a spread that exists only in that review document.

Downstream: S-09 cannot pick a lever without knowing how often `mode: "auto"` silently
falls back to Whisper. This slice measures; S-09 bounds.

## Plan-review triage (2026-07-28)

Six findings triaged; four fixed, one accepted, one moot. Three decisions changed the plan's
shape beyond the findings themselves:

- **Supadata spend is measured, not inferred.** The ledger persists `x-billable-requests`
  per call (`docs/supadata-billable-requests.md`). The transcript path leaves `@supadata/js`
  for a direct `fetch` — the SDK drops response headers and binds `fetch` at module load —
  following the precedent `metadata.ts:43` already set.
- **The retrospective spend estimate was cut.** Its only costing input was the discredited
  `resolved_via` → Whisper formula. Spend before the ledger stays unpriced.
- **Phase 5 now spends 6–9 credits, not 2–3**, and verifies the Whisper `job` path live —
  the one run that can tell whether `x-billable-requests` counts credits or requests. A
  native video reads `1` under either reading and proves nothing.

Accepted risk: the `persist_summary` drop-and-recreate window between `db push` and
`wrangler deploy`, unchanged from S-08.
