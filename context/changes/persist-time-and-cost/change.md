---
change_id: persist-time-and-cost
title: Persist generation time and provider cost per summary (S-07)
status: impl_reviewed
created: 2026-07-28
updated: 2026-07-30
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

## Local verification pass, Phases 2–4 (2026-07-29)

All eleven manual Progress rows (2.4–4.9) verified against the local stack: five generations
plus DB inspection. Every row passed as written; no implementation defect surfaced. The
`transcript_quotes` `'stored'` write (4.9) was confirmed by querying the table directly — the
one check whose failure would have been invisible from the client.

To reach a genuine vendor `transcript-unavailable` for rows 4.6/4.7, `mode` was temporarily
flipped to `native` for two runs and reverted (`git diff` clean). Necessary because `auto`
falls back silently, so an ordinary caption-less video never returns that error.

**Phase 5 run 3 is cancelled — its question was answered early and its premise was false.**
Amended in `plan.md` §Phase 5 and recorded in `docs/supadata-billable-requests.md` §Measured:

- **`x-billable-requests` reports credits, not a request count.** One `mode=generate` request
  reported `2` and moved `usedCredits` by exactly 2. `billable_credits` keeps its name; the
  conditional rename that Phase 5 mandated is void. Six measurements agreed.
- **A `206 transcript-unavailable` is billed 1 credit and carries no header at all** — observed
  three times. So the ledger records `null` for a known-billable call by design, and any
  reconciliation must add 1 per `unavailable` row. The documented "included in every API
  response" is false as written.
- **`mode=generate` did not generate**, in either direction: it returned inline captions on a
  captioned video (2 credits) and `206` on a caption-less one (1 credit). Five submit attempts
  across three videos produced no `202`, so the `job` path stayed unreachable and is now left to
  real traffic rather than a paid run. Cause not established — plan tier or unobtainable audio.

That last point lands on **S-09**, whose headline lever is switching `mode`. It must
re-establish what the modes actually do before planning around them.

Deliberately not treated as a defect: YouTube auto-captions an instrumental as the single token
`"you"`, which passes the whitespace guard and is summarized as an ordinary transcript. Owner's
call — a 3-character transcript is a real transcript, and summarizing it is the user's choice.
