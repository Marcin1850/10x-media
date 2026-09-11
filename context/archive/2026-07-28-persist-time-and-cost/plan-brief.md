# Persist generation time and provider cost per summary (S-07) — Plan Brief

> Full plan: `context/changes/persist-time-and-cost/plan.md`
> Regenerated 2026-07-28 after plan review triage (F1–F10). Where this brief and the plan disagree, the plan wins.

## What & Why

Every generation currently produces a summary and forgets how it was made — no timing, no provider cost, no record of the input. This change records those facts per summary and, separately, logs every Supadata API call in an append-only ledger carrying **the credits Supadata itself reported for that call**. The second consumer matters as much as the first: **S-09 cannot choose a cost-guardrail lever without knowing how often `mode: "auto"` silently falls back to Whisper**, and nobody has measured that. S-07 measures; S-09 bounds.

## Starting Point

The generate endpoint is a hardened pipeline — lease, idempotency probe, balance gate, transcript fetch, cost gate, atomic debit, LLM, metadata, transactional persist-and-settle. It records `model` and `resolved_via` per summary and, since S-08, descriptive video metadata. It records nothing about latency, cost or input. `getSummaryModel` passes no settings object, so OpenRouter usage accounting is off. Nothing counts Supadata calls, and a second summary of the same video re-fetches and pays again — a tradeoff S-01 accepted explicitly.

Two constraints shape everything below. `persist_summary` is the **only** writer of `summaries`/`videos` (grants were revoked deliberately), so any new column must be reachable through it — and widening it means a drop-and-recreate. And `@supadata/js@1.4.0` funnels every call through one `fetchUrl` that returns a parsed body and discards the `Response`, so the per-request credit header is unreachable through the SDK.

## Desired End State

Each summary carries input size, four timings (transcript / LLM / metadata / total), OpenRouter cost and token counts, and a `resolved_via` that distinguishes a paid fetch from a cache reuse. Every real Supadata call has a ledger row with its vendor-reported credit figure — including on requests that returned 422, 413, 409 or 502 and produced no summary. A transcript fetched once **and written to the cache** is reused by any user for 30 days, then re-fetched and overwritten. The cache is also a **negative** cache: a video the vendor says has no transcript answers 422 for free.

The reuse guarantee is **eventual**, holding from the first completed cache write onward — not absolute (see the concurrency risk below).

## Key Decisions Made

| Decision | Choice | Why (1 sentence) |
| --- | --- | --- |
| Scope | All four parts (F4, F5, T3, T4) **plus** reuse-on-regeneration | Measuring and not acting on the obvious saving would leave the double-fetch S-01 accepted in place. |
| Supadata credit figure | **Persist the vendor's `x-billable-requests` header verbatim**, nullable | It is the only surface that attributes spend to one call; `resolved_via` is documented as a fetch-mechanism observation, so any credit number derived from it is a biased inference. |
| Transcript transport | **Drop `@supadata/js` for the transcript path; call `/v1/transcript` directly** | The SDK discards the `Response`, so the header is unreachable through it; `metadata.ts:43` already sets this precedent, and error semantics are preserved verbatim. |
| Where spend is recorded | Append-only `supadata_calls` ledger, one row per call | Columns on `summaries` are structurally blind to a 422 — which costs a real billable credit and writes no summary. |
| Transcript storage | User-agnostic `transcript_cache` keyed by `youtube_id`, body there only | `videos` is per-user and cascades on account deletion, so one user leaving would erase a transcript others depend on. |
| Negative caching | Cache `empty` and `unavailable`; **never** `failed`/`timeout` | A billable "there is nothing here" is worth keeping; a transient failure says nothing durable about the video. |
| Cache windows | 30 days for `ok` **and `empty`**; **24 hours for `unavailable` alone** | An instrumental video is permanently wordless, but `transcript-unavailable` can stop being true — YouTube publishes auto-captions late on fresh uploads, so that window is a risk bound. |
| Transcript failure reasons | Split `TranscriptResult`'s failure arm into `unavailable \| failed \| timeout` | Five distinct situations collapsed into one reason; the endpoint must cache the permanent answer without ever caching a transient one. The user-facing 422 is unchanged. |
| Input size | `transcript_chars` on `summaries` | The cache row is overwritten on refresh, so the size of the text an older summary was built from would otherwise be lost. |
| Refresh mechanism | 30-day reuse window only — a later request re-fetches and overwrites | No user-facing control and no API parameter; nothing is ever deleted from the cache. |
| Reuse provenance | Extend the `resolved_via` CHECK with `'stored'` in **both** constrained tables | `transcript_quotes` has its own CHECK whose failure is swallowed by design — missing it would silently re-pay Supadata on the cached long-video path. |
| Latency granularity | Split transcript / LLM / metadata, plus a total | The F-02 finding that created F4 (33 s vs 254 s) was purely a transcript-branch difference a single number would have hidden. |
| `generation_ms` boundary | Start of `runGeneration` → **immediately before `persistSummaryAndSettle`** | `persist_summary` is the only writer, so the value must be frozen before the call; a response-bound figure would need a second, non-atomic write. |
| LLM cost detail | `cost_usd` + prompt/completion tokens | Tokens survive a price change or model swap, so old rows stay comparable. |
| Telemetry write path | Widen `persist_summary` (drop + create, 15 → 23 args) | Telemetry commits in the same transaction as the summary, at the cost of repeating S-08's deploy window. |
| Ledger erasure | `user_id` and `summary_id` nullable, `on delete set null` | The operator's bill does not shrink when a user leaves, but the personal link is genuinely erased. |
| Verification budget | **~6–9 live Supadata credits**, including a forced Whisper `job` run | Runs on native videos read `1` whether the header counts credits or requests; only the job path can settle the unit, and shipping a column whose unit is discovered later repeats the failure this slice exists to fix. |
| Cold-miss race | **Detect and log it; do not lock** | A cross-user single-flight lease is real distributed-state machinery for a race with no measured frequency — so the write itself reports the collision and the count decides whether a lease is ever justified. |
| History | **No backfill and no retrospective estimate** | The only costing input available was the `resolved_via` → Whisper formula this slice discredits; the ledger reports measured truth within days of rollout. |

## Scope

**In scope:** two new tables (shared transcript cache, Supadata call ledger); eight telemetry columns on `summaries`; two widened `resolved_via` CHECKs; a widened `persist_summary`; OpenRouter usage accounting; a direct-`fetch` transport for the transcript path; call metering in the transcript and metadata services; cache reuse (positive and negative) in the generate endpoint; a live verification pass that settles the header's unit.

**Out of scope:** any UI (S-02/S-06 own it); a user-facing or API refresh parameter; cache pruning or eviction; **any inferred credit figure, anywhere**; a retrospective spend estimate; backfilling or pricing existing rows; changes to what a summary costs the user; retiring `transcript_quotes`; **a single-flight lock on the cache**.

## Architecture / Approach

Facts are recorded where they are observed; nothing derived is stored. Timings bracket each external call in the endpoint. Cost comes from the OpenRouter response the SDK already parses. Supadata cost comes from the `x-billable-requests` header on each response, read by an in-memory meter threaded into `transcript.ts` and `metadata.ts` and flushed once in a `finally` — which is what lets a 422 leave a trace that per-summary columns cannot.

The cache sits between the `allowLong` quote check and the rate limiter, so a hit consumes no rate-limit token, and is written immediately after the fetch resolves — before the long-video 409 — so even an abandoned confirmation keeps the transcript it paid for. The whitespace-rejection guard is hoisted below the whole acquisition if/else: `summaryCost(0)` returns `1`, so an empty transcript reaching the main path would clear both cost gates, debit a credit and send nothing to the LLM.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Schema | Two tables, eight columns, two widened CHECKs, widened RPC, three cache/ledger RPCs | The RPC swap makes local DB and deployed Worker incompatible until Phase 5 |
| 2. OpenRouter instrumentation | `usage: { include: true }`; cost and tokens returned from `summarize()` | Fields are optional in the provider type — must read defensively, never fail a paid generation |
| 3. Supadata instrumentation | Cache service, meter + ledger writer, transport swap, failure-reason split | The transport swap must reproduce `SupadataError` semantics exactly; the meter must never throw |
| 4. Endpoint wiring | Cache reuse, hoisted guard, four timings, flush on every exit, telemetry into the RPC | Three orderings are load-bearing (cache read before rate limit, cache write before the 409, flush in `finally`) |
| 5. Rollout + live verification | Back-to-back push/deploy, 6–9 credit live pass incl. the Whisper run, tracker sync | The deploy window loses OpenRouter spend for any generation caught in it |

**Prerequisites:** S-01 and S-08 both live in production (they are). Local Supabase running; Supadata and OpenRouter keys present. Branch `persist-time-and-cost` is created.
**Estimated effort:** ~3–4 sessions across 5 phases; phases 2 and 3 are independent of each other.

## Open Risks & Assumptions

- **The header's unit is not yet settled.** `x-billable-requests` is documented as request-level credit tracking, but requests and credits diverge on the Whisper path. Phase 5 run 3 decides it, and the column is renamed **before** rows accumulate if it turns out to be a request count.
- **Concurrent cold misses can still double-pay.** Two users requesting the same uncached video within the same few seconds both miss, both fetch, both upsert; the existing lease is per-user and cannot coordinate them. Accepted for MVP but **instrumented, not assumed rare**: `save_transcript_cache` returns `true` when it overwrote a row younger than the caller's own fetch, and the endpoint logs one `[duplicate-transcript-fetch]` warning per occurrence. Workers observability is already enabled, so the count is available from day one and is the data behind any later decision to add a video-scoped lease.
- **The deploy window is knowingly re-opened.** Between `db push` and `wrangler deploy` the live Worker calls a missing signature; the user is refunded but the OpenRouter spend is lost. Same trade S-08 accepted.
- **A stale `unavailable` row can lock a video out for up to 24 hours** if captions arrive in that window — the bound chosen over the full 30 days precisely because recent videos are a core use case.
- **A stale transcript can serve a summary for up to 30 days**, including entries fetched under the pre-F9 language policy. The window is the only mechanism that clears them.
- **Cache growth is unbounded** — one row per video, up to 200k chars, never pruned. Accepted at MVP scale.
- **Cross-user reuse creates a small timing side channel**: a fast generation implies someone already summarised that video. Negligible here; the content is public.
- **Spend before the ledger exists stays unmeasured**, by decision, rather than estimated from a formula this slice discredits.
- **Not verified live** (cost): the metadata retry and the 24-hour `unavailable` expiry — both exercised locally, the expiry by backdating `fetched_at`. The Whisper `job` path **is** verified live, reversing an earlier position, because it is the only run that can settle the header's unit.

## Success Criteria (Summary)

- Generating the same video twice produces a second summary marked `'stored'`, with near-zero `transcript_ms` and **no new transcript ledger row** (a metadata row is still expected — only the transcript is cached).
- A request that fails with 422 still leaves a billable ledger row, and a `transcript_cache` row; repeating it returns 422 with **zero** new ledger rows.
- `sum(billable_credits)` reconciles against the `GET /v1/me` `usedCredits` delta, with any gap attributed to specific null-valued rows rather than left unexplained.
- Run 3 settles whether the header reports credits or requests, and whether `resolved_via = 'job'` is a usable Whisper proxy — the measurement S-09 needs to pick a lever.
