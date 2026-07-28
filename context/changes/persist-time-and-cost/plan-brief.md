# Persist generation time and provider cost per summary (S-07) — Plan Brief

> Full plan: `context/changes/persist-time-and-cost/plan.md`

## What & Why

Every generation currently produces a summary and forgets how it was made — no timing, no provider cost, no record of the input. This change records those facts per summary and, separately, logs every Supadata API call in an append-only ledger. The second consumer matters as much as the first: **S-09 cannot choose a cost-guardrail lever without knowing how often `mode: "auto"` silently falls back to Whisper**, and nobody has measured that. S-07 measures; S-09 bounds.

## Starting Point

The generate endpoint is a hardened pipeline — lease, idempotency probe, balance gate, transcript fetch, cost gate, atomic debit, LLM, metadata, transactional persist-and-settle. It records `model` and `resolved_via` per summary and, since S-08, descriptive video metadata. It records nothing about latency, cost or input. `getSummaryModel` passes no settings object, so OpenRouter usage accounting is off. Nothing counts Supadata calls, and a second summary of the same video re-fetches and pays again — a tradeoff S-01 accepted explicitly.

## Desired End State

Each summary carries input size, four timings (transcript / LLM / metadata / total), OpenRouter cost and token counts, and a `resolved_via` that distinguishes a paid fetch from a cache reuse. Every real Supadata call has a ledger row — including on requests that returned 422, 413 or 409 and produced no summary. A transcript fetched once is reused by any user for 30 days, then re-fetched and overwritten.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) |
| --- | --- | --- |
| Scope | All four parts (F4, F5, T3, T4) **plus** reuse-on-regeneration | Measuring and not acting on the obvious saving would leave the double-fetch S-01 accepted in place. |
| Supadata credit figure | Count calls exactly; derive credits at query time | `resolved_via` is documented as a fetch-mechanism observation, not a native-vs-Whisper claim, so a persisted credit number would outlive the caveat explaining it. |
| Where spend is recorded | Append-only `supadata_calls` ledger, one row per call | Columns on `summaries` are structurally blind to a 422 — which costs a real billable credit and writes no summary. |
| Transcript storage | User-agnostic `transcript_cache` keyed by `youtube_id`, body there only | `videos` is per-user and cascades on account deletion, so one user leaving would erase a transcript others depend on. |
| Input size | `transcript_chars` on `summaries` | The cache row is overwritten on refresh, so the size of the text an older summary was built from would otherwise be lost. |
| Refresh mechanism | 30-day reuse window only — a later request re-fetches and overwrites | No user-facing control and no API parameter; nothing is ever deleted from the cache. |
| Reuse provenance | Extend `resolved_via` CHECK with `'stored'` | Keeps anyone pricing from `summaries` alone from attributing a paid fetch that never happened, and measures the cache hit rate directly. |
| Latency granularity | Split transcript / LLM / metadata, plus a total | The F-02 finding that created F4 (33 s vs 254 s) was purely a transcript-branch difference a single number would have hidden. |
| LLM cost detail | `cost_usd` + prompt/completion tokens | Tokens survive a price change or model swap, so old rows stay comparable. |
| Telemetry write path | Widen `persist_summary` (drop + create) | Telemetry commits in the same transaction as the summary, at the cost of repeating S-08's deploy window. |
| Ledger erasure | `user_id` and `summary_id` nullable, `on delete set null` | The operator's bill does not shrink when a user leaves, but the personal link is genuinely erased. |
| Verification budget | Retrospective SQL estimate first, then a ~2–3 credit live pass | Sizes the problem before a column is written and still proves the numbers are real. |

## Scope

**In scope:** two new tables (shared transcript cache, Supadata call ledger); eight telemetry columns on `summaries`; a widened `resolved_via` CHECK; a widened `persist_summary`; OpenRouter usage accounting; call metering in the transcript and metadata services; cache reuse in the generate endpoint; a retrospective spend estimate and a live verification pass.

**Out of scope:** any UI (S-02/S-06 own it); a user-facing or API refresh parameter; cache pruning; a persisted credit figure; changes to what a summary costs the user; retiring `transcript_quotes`; backfilling existing rows.

## Architecture / Approach

Facts are recorded where they are observed; nothing derived is stored. Timings bracket each external call in the endpoint. Cost comes from the OpenRouter response the SDK already parses. Supadata calls are recorded by an in-memory meter threaded into `transcript.ts` and `metadata.ts`, then flushed once in a `finally` — which is what lets a 422 leave a trace that per-summary columns cannot. The cache sits between the `allowLong` quote check and the rate limiter, so a hit consumes no rate-limit token, and is written immediately after a successful fetch so even an abandoned 409 keeps the transcript it paid for.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Retrospective baseline + schema | Zero-cost spend estimate, then two tables, eight columns, widened CHECK, widened RPC | The RPC swap makes local DB and deployed Worker incompatible until Phase 5 |
| 2. OpenRouter instrumentation | `usage: { include: true }`; cost and tokens returned from `summarize()` | Fields are optional in the provider type — must read defensively, never fail a paid generation |
| 3. Supadata instrumentation | Cache service, meter + ledger writer, metering in both call sites | Meter must never throw; it runs inside the catches that make those services total |
| 4. Endpoint wiring | Cache reuse, four timings, flush on every exit, telemetry into the RPC | Three orderings are load-bearing (cache read before rate limit, cache write before the 409, flush in `finally`) |
| 5. Rollout + live verification | Back-to-back push/deploy, ~2–3 credit live pass, tracker sync | The deploy window loses OpenRouter spend for any generation caught in it |

**Prerequisites:** S-01 and S-08 both live in production (they are). Local Supabase running; Supadata and OpenRouter keys present. Branch `persist-time-and-cost` is created.
**Estimated effort:** ~3–4 sessions across 5 phases; phases 2 and 3 are independent of each other.

## Open Risks & Assumptions

- **The deploy window is knowingly re-opened.** Between `db push` and `wrangler deploy` the live Worker calls a missing signature; the user is refunded but the OpenRouter spend is lost. Same trade S-08 accepted.
- **Derived credits rest on an inference the code disclaims.** `resolved_via = 'job'` is treated as the Whisper path for estimation, while `src/types.ts:3` explicitly says it is not that claim. Phase 5 tests it against measured data rather than assuming it.
- **Cache growth is unbounded** — one row per video, up to 200k chars, never pruned. Accepted at MVP scale.
- **Cross-user reuse creates a small timing side channel**: a fast generation implies someone already summarised that video. Negligible here; the content is public.
- **A stale transcript can serve a summary for up to 30 days**, including entries fetched under the pre-F9 language policy. The window is the only mechanism that clears them.
- **The Whisper path and the metadata retry stay unverified live** — too expensive to exercise deliberately. Verified by reasoning and DB inspection, and the limitation is stated in the record rather than glossed.

## Success Criteria (Summary)

- Generating the same video twice produces a second summary marked `'stored'`, with near-zero `transcript_ms` and **no new transcript ledger row** — reuse is provably working.
- A request that fails with 422 still leaves a billable ledger row, so wasted spend is visible.
- The `usedCredits` delta from `GET /v1/me` reconciles against the ledger's billable rows, and S-09 can read the Whisper fallback rate off real data instead of guessing.
