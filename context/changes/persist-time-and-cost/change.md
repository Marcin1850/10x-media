---
change_id: persist-time-and-cost
title: Persist generation time and provider cost per summary (S-07)
status: implementing
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

## Follow-up plan-review triage (2026-07-28)

Four further findings, all fixed. None changed the work's shape — they closed gaps between
what the plan promised and what its own design delivers:

- **`generation_ms` stops at persistence, not at the response.** `persist_summary` is the
  only writer, so the value must be frozen before the call; the exclusions (persist round
  trip, quote cleanup, response construction) are now stated, and the post-persist second
  write is explicitly rejected to keep telemetry atomic with the summary.
- **The cache promise is eventual, not absolute.** Concurrent cold misses for the same video
  can each pay — the existing lease is per-user and cannot coordinate two users on one video.
  A single-flight lease was declined as premature, but the race is **measured, not assumed
  rare**: `save_transcript_cache` returns `true` when it overwrote a row younger than the
  caller's own fetch, and the endpoint logs `[duplicate-transcript-fetch]`. Skew-immune (one
  Postgres clock plus a Worker-measured duration), no extra round trip, and readable today via
  Workers observability — a Sentry-style reporter would later upgrade that one call site.
- **`empty` takes the 30-day window, not the 24-hour one.** The short window exists only
  because `transcript-unavailable` can stop being true; an instrumental video is permanently
  wordless, so expiring it daily would re-pay for the same nothing. Constant renamed
  `TRANSCRIPT_CACHE_UNAVAILABLE_MAX_AGE_SECONDS` to name the outcome rather than "negative".
- **`plan-brief.md` regenerated** from the current plan, last, so it absorbed all three edits
  above in one pass.

Plan review verdict: **SOUND**. Two things stay open by design — the unit of
`x-billable-requests` (Phase 5 run 3 settles it, rename ready) and the real frequency of
concurrent cold misses (the ledger will show it).
