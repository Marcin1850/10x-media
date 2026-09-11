# Phase 5 — Live verification record

- **Change**: `persist-time-and-cost` (S-07)
- **Date**: 2026-07-30
- **Environment**: production — Worker `10x-media` (version `d6fd806d-4029-4f31-ba13-7ea2d7cfaba7`), Supabase `ukbptccdffiigkdekzcn`
- **Budget**: 2–3 Supadata credits (runs 1 and 2 only; run 3 cancelled 2026-07-29)
- **Actual spend**: **3 credits**

## Rollout

`npx supabase db push --linked --yes` followed immediately by `npx wrangler deploy`, run as one shell operation with nothing in between, per the plan's RPC-swap window mitigation. Both migrations applied (`20260728120000_generation_telemetry`, `20260729120000_transcript_cache_too_long`); `migration list --linked` shows all 24 local/remote pairs in sync.

**Pre-flight check worth repeating on future rollouts**: the Phase 1 impl-review triage applied its two fixes (`pg_advisory_xact_lock` in `save_transcript_cache`, `supadata_calls_summary_idx`) to the *local* database as targeted DDL. Both were confirmed present in the migration files before pushing — had they only existed locally, production would have received the unfixed versions silently.

## Credit ledger (`GET /v1/me`)

| Point | `usedCredits` | Delta |
|---|---|---|
| Baseline | 63 | — |
| After run 1 | 65 | +2 |
| After run 2 | 66 | **+1** |
| **Total** | | **+3** |

Video: `nWzXyjXCoCE` (short, native captions, 16,257-char transcript).

## Run 1 — informational character

Cold cache. Wrote `transcript` + `metadata` ledger rows and a `transcript_cache` row; all eight telemetry columns populated.

- `resolved_via = 'inline'`, `transcript_ms = 1583`, `llm_ms = 30263`, `metadata_ms = 16859`, `generation_ms = 49004`
- `transcript_chars = 16257`, `prompt_tokens = 5250`, `completion_tokens = 2186`, `cost_usd = 0.03236`
- Cache row written at 14:05:59, **before** the summary at 14:06:47 — confirming the write happens straight after the fetch rather than after the gates.

## Run 2 — educational character, same video

**The slice's core claim, confirmed at the vendor's billing level.** The delta was exactly 1 credit: the transcript came from the shared cache for free, and only the metadata call was paid.

- `resolved_via = 'stored'`, `transcript_ms = 60` (vs 1583 cold — near-zero as specified)
- **No new `transcript` ledger row**; one new `metadata` row, as the plan predicted
- `transcript_chars = 16257` — identical to run 1 and to the cache row's `body_chars`

Both runs produced correct-looking summaries in the app (owner-confirmed 2026-07-30) — the DB rows above describe generations that actually succeeded end to end, not just rows that landed.

## Timing spans are internally consistent

The three measured spans sum to just under `generation_ms` in both runs, leaving 0.4–0.6 % for the credit reservation and DB work:

| | Run 1 | Run 2 |
|---|---|---|
| `transcript_ms` | 1 583 (3.2 %) | 60 (0.2 %) |
| `llm_ms` | 30 263 (61.8 %) | 38 532 (97.3 %) |
| `metadata_ms` | 16 859 (34.4 %) | 867 (2.2 %) |
| sum of three | 48 705 | 39 459 |
| `generation_ms` | 49 004 | 39 614 |
| remainder | 299 (0.6 %) | 155 (0.4 %) |

Overlapping or over-wide spans would push the sum past the whole; they don't. This independently confirms the F5 fix from the phases 2–4 review, where `transcript_ms` wrongly enclosed the cache-write RPC.

`llm_ms` dominates both runs, though not equally: overwhelmingly on run 2 (97 %), clearly but less so on run 1 (62 %), where the metadata retry consumed a third of the wall clock. The 16 859 vs 867 ms gap on the same operation for the same video is independent corroboration that run 1 really made two metadata requests with a timeout and sleep between them.

## Reconciliation

```
raw_sum = 3,  unavailable_rows = 0,  expected_delta = 3
measured usedCredits delta = 3        ✅ exact
```

No gap to attribute. The `+1 per unavailable row` correction was not exercised (no `unavailable` rows in this session).

## `cost_usd` is exact, not merely plausible

Both figures reproduce to the last digit from their token counts at Claude Sonnet 5's **introductory** rate ($2.00 / $10.00 per MTok, running through 2026-08-31):

```
Run 1:  5250 × $2/1M + 2186 × $10/1M = $0.032360   (DB: 0.03236)
Run 2:  5201 × $2/1M + 2755 × $10/1M = $0.037952   (DB: 0.037952)
```

**Plan criterion 5.4 expected "~1–2 ¢" and is stale** — that figure came from an earlier probe on a shorter transcript. These runs summarized 16,257 characters. The criterion is satisfied in substance (the values are provably correct, and `llm_ms` dominates on both runs); the stated range is not.

**Cost roughly doubles on 2026-09-01** when introductory pricing ends: the same two runs would cost $0.0569 and $0.0324 at the standard $3.00 / $15.00 rate. S-09 should budget against standard pricing, not the figures recorded here.

## Findings for S-09

**1. The metadata retry fired, and the failed attempt was not billed.** Run 1 produced three ledger rows, not two: `transcript`/ok (1), `metadata`/**error** (null), `metadata`/ok (1). This is exactly the second billable request the plan said a per-generation "1 metadata call" assumption would miss (`plan.md` §Phase 3.4) — except it turned out to be *free*. Since the reconciliation closes exactly at 3, the errored call cost 0 credits. `metadata_ms = 16859` corroborates the path: ~10 s timeout + ~1.2 s sleep + ~5.6 s successful retry.

Consequence: **`billable_credits = null` has two distinct meanings**, both now observed —

| Case | Actually billed | Header |
|---|---|---|
| `206 transcript-unavailable` | 1 credit | absent |
| Failed metadata call (this run) | 0 credits | absent |

They are indistinguishable from `billable_credits` alone. Reconciliation must branch on `outcome`, which is why the formula is per-outcome rather than a flat sum. Do not "simplify" it.

**2. `created_at` is flush time, not call time.** All three run-1 rows carry the identical timestamp `14:06:47.221822` because `record_supadata_calls` batch-inserts them in one statement — the deliberate one-round-trip-per-request design. The ledger therefore cannot order calls *within* a single request. Not a defect; recorded so nobody reads inter-row timing out of it.

**3. The `job` / Whisper path remains unobserved.** Both runs resolved `inline`. Per the amended Phase 5, this stays open and unbudgeted — it is answered by watching real traffic for `resolved_via = 'job'` or `operation = 'transcript_poll'` rows, not by a paid run. An empty result after the first weeks of use is itself the finding: S-09 must treat "the job path may be unreachable on this plan" as an open question in either direction, and re-establish what the `mode` values actually do before planning around them.

## Coverage limits

Deliberately not verified live, per the plan's cost boundary:

- The `unavailable` cache's 24-hour expiry (verified locally by backdating `fetched_at`, Phase 1 row 1.10)
- The `'too_long'` path and `content_chars` (null here, as expected — it is populated only on the over-cap branch)
- The duplicate-fetch `[duplicate-transcript-fetch]` warning (verified locally at the RPC level, Phase 1 row 1.11; the concurrent case was never staged)
- The Whisper `job` path (unforceable — see finding 3)
