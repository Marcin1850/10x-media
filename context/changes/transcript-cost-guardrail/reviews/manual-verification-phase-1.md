# Phase 1 — Manual verification record

- **Change**: `transcript-cost-guardrail` (S-09)
- **Phase**: 1 — lever A (`mode: "native"`) and the `unavailable` 422 split. Of 5 phases when this ran;
  the plan became 7 later the same day, and this pass is what prompted the extension (D13/D14). Phase 1's
  own number and content are unchanged by it.
- **Date**: 2026-08-01
- **Environment**: **local only** — dev server on `localhost:4321`, local Supabase stack
  (`127.0.0.1:54321`). Nothing was deployed; Phase 5 remains the single deploy gate.
- **Code under test**: branch `transcript-cost-guardrail` at `8171cf9` (implementation `1e134df`
  plus the impl-review triage fixes, which were comment-only in `src/`).
- **Account**: `verify-s07@local.test`, opening balance 3 app credits.
- **Result**: **all four rows pass (1.5–1.8)**.

## Pre-flight — a stale server was serving pre-Phase-1 code

Port 4321 was held by an `astro dev` process started **2026-07-29**, three days before Phase 1 was
implemented, returning HTTP 500. A new dev server silently fell back to 4322. Had the run been done
against 4321 every result would have described the old `mode: "auto"` code while looking valid.

The stale process was killed and the server restarted on 4321 before any test ran. **Worth repeating
as a pre-flight on future manual passes**: confirm the port you are testing is served by a process
started *after* the commit under test.

## Spend

| Point | `usedCredits` |
|---|---|
| Before | 68 / 100 |
| After | 71 / 100 |
| **Delta** | **3** |

Ledger for the same window, scored by the per-outcome formula:

| Operation | Outcome | `billable_credits` | Actually billed |
|---|---|---|---|
| `transcript` | `unavailable` | `null` | **1** |
| `transcript` | `ok` | 1 | 1 |
| `metadata` | `ok` | 1 | 1 |
| | | | **3 — exact match** |

This re-confirms S-07's hand-over item (2) independently: a `null` `billable_credits` on a 206 means
**1 credit**, not zero. A flat sum over the column would have predicted 2 and been wrong. Do not
"simplify" the per-outcome branch.

App credits: 3 → 2. Only the successful generation debited; both 422 refusals were pre-debit.

## 1.6 — Caption-less video shows the new copy (PASS)

Video `brXcsLhw84o` — "1 Minute Piano Music", 60 s. Confirmed caption-less *before* spending, by
checking the watch page for `captionTracks` (absent). Cheapest possible probe of the path.

Rendered in the UI, verbatim:

> This video has no captions, so there is nothing to summarize. We can only summarize videos that have
> a caption track — try another video.

That is `TRANSCRIPT_NO_CAPTIONS_ERROR`. **Both halves of D3 are proven by this one string**: the server
emitted the new specific copy, and the client rendered it rather than substituting its old hardcoded
`"No transcript is available for this video."` — the `GenerateSummaryForm.tsx` gap the plan found.

DB state after: `transcript_cache` row `outcome = 'unavailable'`, empty content; **one** `transcript`
ledger row; **no `metadata` row** — the 422 exits before the metadata call, confirming the envelope's
"cold video without captions = 1 credit".

## 1.6b — Cached `unavailable` branch (PASS, free)

Immediate resubmit of the same URL. Verified through the network log rather than inferred: a real
`POST /api/summaries/generate` returning **422**, with no new ledger row and no new
`transcript_fetch_attempts` row afterwards.

The unchanged attempt count is itself informative — the cache lookup sits *ahead* of
`recordTranscriptAttempt`, so a hit never reaches the rate-limit guard. Same copy, zero vendor calls.

## 1.5 — Captioned video end to end (PASS)

Video `_Ae4osPymXY` — "Deepseek Just Did it Again!", 14:01, ASR English captions.

`POST` → **200**. A coherent Polish summary rendered, correctly shaped to the *informational*
character. Summary row: `transcript_chars = 11615`, `prompt_tokens = 4074`,
`completion_tokens = 1977`, `cost_usd = 0.027918`, `resolved_via = 'inline'`,
`generation_ms = 33191`. UI showed "1 CREDIT SPENT" and the balance moved 3 → 2.

Lever A does not break the happy path.

**Incidental observation worth keeping.** The `transcript` and `metadata` ledger rows carry an
*identical* `created_at` — they flush together in `POST.finally`. This is the exact property that made
a read-then-spend breaker unable to bound anything (a request's own spend is invisible to every
concurrent one) and forced the plan review's atomic reserve/settle redesign. Now observed directly
rather than reasoned about.

## 1.7 — `'empty'` still shows the generic copy (PASS, free)

Staged by flipping the cached `brXcsLhw84o` row to `outcome = 'empty'` with a fresh `fetched_at`. A
seeded row was used deliberately: it guarantees a cache hit, so the check cannot trigger a paid call.

Rendered: **"Transcript unavailable for this video"** — `TRANSCRIPT_UNAVAILABLE_ERROR`, the generic
string, *not* the no-captions one.

This is the finding the plan flagged as easy to miss: `generate.ts:345` answers for both `'empty'` and
`'unavailable'` cache rows, so the split there is **three-way, not two-way**. Same code site, different
outcome value, different copy. `'empty'` is a vendor *success* on a wordless video and must not be
told "this video has no captions".

The row was restored to its true observed state (`unavailable`, original `fetched_at`) afterwards, so
the local DB holds no fabricated data.

## 1.8 — The window is 2 h, not 24 h (PASS, free)

The window is applied at **read** time (`get_transcript_cache`'s `p_unavailable_max_age_seconds`), so
this needs no two-hour wait: backdate `fetched_at` and call the RPC at both the new and old values.
Same technique S-07 used for the old 24 h figure (its Phase 1 row 1.10).

| Row age | Hit under 7 200 s (new) | Hit under 86 400 s (old) |
|---|---|---|
| 110 min | served | served |
| 130 min | **expired** | served |

The 130-minute line is the assertion that matters: the same row that expires under D4's constant would
still have been served under the superseded one. Nothing else varies between the two columns, so the
change is isolated. Code wiring confirmed by reading —
`TRANSCRIPT_CACHE_UNAVAILABLE_MAX_AGE_SECONDS = 7_200` (`transcript-cache.ts:53`) is what
`getCachedTranscript` passes (`:100`).

## Not verified here, deliberately

- **Anything in production.** Phase 1 stays undeployed; the shortened 2 h negative window must not ship
  ahead of the Phase 4 breaker that counterweights it (D4 and lever C are load-bearing for each other).
- **The Whisper `job` path.** Unreachable by construction under `native` — D1 closes S-07's open
  question permanently, accepted knowingly.
- **Whether lever A saves anything measurable.** This run cannot answer it and was never going to: the
  caption-less video returned `unavailable` under `native`, which is what S-07 also saw under `auto`.
  The roadmap caveat stands — A buys a contractual bound, not a demonstrated saving.
