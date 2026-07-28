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
