# Transcript Cost Guardrail — Plan Brief

> Full plan: `context/changes/transcript-cost-guardrail/plan.md`
> Locked design: `context/foundation/roadmap.md` §S-09, Decisions D1–D12 (2026-07-31)

## What & Why

The app prices generation in characters, *after* the fetch, capped at 2 user credits. Supadata bills in
minutes, *during* the fetch, uncapped. So one ~50-minute video on the Whisper path drains a whole
100-credit month, and `HARD_MAX_TRANSCRIPT_CHARS` cannot help because it runs after the money is spent.
This slice bounds the spend per generation and across the fleet, and tells the user when a video cannot
be summarized cheaply instead of absorbing the cost invisibly.

## Starting Point

`fetchTranscript` requests `mode=auto` (`transcript.ts:255`), which falls back to Whisper silently.
S-07's `transcript_cache` and `supadata_calls` ledger are live, so transcript reuse already works and
spend is already measured — but `fetchVideoMetadata` (`generate.ts:568`) is called unconditionally with
no lookup, making it 100% of a repeat generation's cost. Nothing anywhere reads the org's remaining
budget.

## Desired End State

A generation costs at most **2** Supadata credits, and **0** on a warm video — a bound known before any
work starts rather than discovered afterwards. A caption-less video gets its own message saying so. When
the monthly plan is nearly exhausted, paid work is refused before it starts and a structured event is
emitted through a seam a monitoring tool can later receive.

## Key Decisions Made

| Decision | Choice | Why | Source |
| --- | --- | --- | --- |
| Which levers | A (`mode: "native"`) + C (budget breaker) | A bounds the video, C bounds the fleet; B and D rejected | Roadmap |
| `mode` configurability | Hard-coded constant, no env var | A secret toggle re-enables the expensive path with no trace in code | Roadmap D2 |
| Negative-cache window | 24 h → 2 h | A day is too long to wait for a freshly published video's captions | Roadmap D4 |
| Metadata cache shape | Full `metadata_cache` keyed by `youtube_id` | `videos` is per-user and cascades — one deletion would evict shared data | Roadmap D6 |
| Metadata fetch placement | Lookup hoisted early, fetch unmoved | A hit removes the request; the miss path's two other reasons still hold | Roadmap D7 |
| Notification | One swappable function, no receiver yet | Monitoring tool lands later; warn is decorative until then | Roadmap D5b |
| **Cache-hit marker** | **`summaries.metadata_via` column** | Literal symmetry with S-07's `resolved_via`; costs a `persist_summary` swap | **Plan** |
| **Breaker at the metadata call** | **Gate it too — skip metadata, keep the summary** | On a warm transcript the metadata call *is* the first paid call; refusing post-debit to protect a thumbnail is worse | **Plan** |
| **Stop threshold** | **`remaining < 2`** | Derived from the worst-case envelope, not picked — needs no retuning | **Plan** |
| **Unreadable budget state** | **Fail open, and report it** | A `/v1/me` outage must not break a product whose transcript API is fine | **Plan** |
| **Verification budget** | **~4 credits, live** | Proves the envelope against the vendor's own billing, as S-07 did | **Plan** |

## Scope

**In scope:** `mode: "native"`; a dedicated 422 for caption-less videos (server *and* client); the 2 h
negative-cache window; `metadata_cache` + `metadata_via`; the budget breaker and its notification seam.

**Out of scope:** what a summary costs the *user* in app credits (S-05); upgrading the Supadata plan;
delivering the notification anywhere (D5b); backfilling the cache (D11); negative-caching metadata
failures (D9); injection screening (S-10).

## Architecture / Approach

Three guards on the existing pipeline, no restructuring:

```
request → transcript quote → transcript_cache ─┐
                             metadata_cache ───┤ (both free; hits skip everything below)
                                               ↓
                          [breaker] → transcript fetch (1 credit)
                                               ↓
                             debit → LLM → [breaker] → metadata fetch (1 credit)
                                               ↓
                                  persist_summary (+ metadata_via)
```

Both breaker points sit on **miss** paths only: a cache hit costs nothing, so blocking it would break
the product for no saving.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Lever A + 422 split | The cost bound itself; caption-less videos get their own copy | The client discards the server's 422 string — miss it and the copy never ships |
| 2. `metadata_cache` + marker | Repeat generations stop paying for metadata | `persist_summary` drop+recreate at 24 params; a stale overload if done with `create or replace` |
| 3. Budget breaker | Fleet-level bound + notification seam | The ledger delta must branch on `outcome`; a flat sum under-counts the billable 206 |
| 4. Deploy + verify | Live, reconciled against `GET /v1/me` | The push/deploy window: between the two commands, every generation fails after the LLM is paid for |

**Prerequisites:** S-01, S-07, S-08 — all shipped. No new Worker secrets.
**Estimated effort:** ~4 sessions, one per phase, with a manual gate between each.

## Open Risks & Assumptions

- **Lever A may save nothing measurable.** S-07 could not force the Whisper path at all — five submits
  across three videos, never a `202`. If it is unreachable on this plan, `auto` never cost 2
  credits/minute and A buys a *contractual* bound, not a proven saving.
- **A + C do not remove the fleet ceiling.** The envelope still allows only ~50 cold videos/month on
  the Free plan. C bounds the overrun; it does not raise the ceiling.
- **The warn threshold has no receiver** (D5b). Until a monitoring tool lands, budget exhaustion
  surfaces via the stop threshold — users seeing an error, the exact channel C exists to avoid.
- **D4 and lever C are load-bearing for each other.** The 2 h window spends operator credits to buy
  user-visible correctness; C is its counterweight. If C is ever dropped, revisit D4 in the same breath.
- **D1 is permanent.** Under `native`, `resolved_via = 'job'` can never appear, so S-07's "is the job
  path reachable?" hand-over becomes unanswerable. Accepted knowingly.

## Success Criteria (Summary)

- A repeat generation of the same video moves `usedCredits` by **0**, verified against the vendor.
- A cold generation costs at most 2 credits, and the ledger reconciles exactly with `GET /v1/me`.
- A user submitting a caption-less video is told *that*, not a generic failure.
