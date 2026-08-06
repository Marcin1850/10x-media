# Phase 7 — Deploy and live verification record

- **Change**: `transcript-cost-guardrail` (S-09)
- **Phase**: 7 — the single deploy gate for all six preceding phases, plus the live credit pass.
- **Date**: 2026-08-06
- **Environment**: **production** — Supabase project `ukbptccdffiigkdekzcn`, Worker
  `10x-media` at `https://10x-media.nightshiftlab.workers.dev`. This is the first deployment of any
  part of the slice; Phases 1–6 had all been verified locally and held back for this gate.
- **Code under test**: branch `transcript-cost-guardrail` at `6d4c203`.
- **Deployed Worker version**: `393417a8-dedc-4a02-906e-f09e5c443637`.
- **Account**: the operator's own production account (identifiers deliberately omitted — this is a
  public repository, and every earlier record in this slice used synthetic local accounts because
  those passes were local; this one could not).
- **Result**: **all six rows pass (7.1–7.6)**. Spend **4 credits** against a ~4-credit budget,
  reconciled exactly against the per-outcome ledger total.

## Deploy

`npx supabase db push --linked` and `npx wrangler deploy` were issued **back to back in a single
shell command**, so the `persist_summary` swap window was never open across a human decision. Between
them the live Worker would have been calling a 23-argument signature that no longer exists, failing
every generation *after* the LLM had been paid for; the two commands are the whole reason this phase
exists as its own gate.

**Six migrations were pending, not the four the plan's contract and criterion 7.1 name.** The
plan's own Phase 5 note already records the renumbering, so this is documented drift rather than a
surprise, but the count in criterion 7.1 was never corrected. Actual set, all applied:

| Migration | Phase | Character |
|---|---|---|
| `20260731100000_supadata_call_http_status` | P2 | additive |
| `20260731110000_charge_failed_transcript` | P3 | additive |
| `20260731120000_metadata_cache` | P4 | **drops + recreates `persist_summary`** |
| `20260731130000_summaries_single_writer` | P4 follow-up | additive |
| `20260731140000_metadata_via_fetch_failed` | P4 follow-up | additive |
| `20260731150000_supadata_budget` | P5 | additive |

`npx supabase migration list --linked` afterwards shows all six with matching local and remote
versions and nothing outstanding. No new Worker secrets were needed — the breaker reuses
`SUPADATA_API_KEY`, and all five secrets were already set (confirmed with `wrangler secret list`
before the push, since a missing `SUPABASE_SERVICE_ROLE_KEY` would have answered 503 on every
generation rather than failing loudly).

Pre-flight: `npm run lint` and `npm run build` both clean on the deployed commit.

## Spend

| Point | `usedCredits` |
|---|---|
| Before | 81 / 100 |
| After | **85 / 100** |
| **Delta** | **4** |

Exactly the ~4-credit budget, with no metadata retry firing. Ledger for the same window, scored by
the per-outcome formula from Critical Implementation Details:

| Step | Operation | Outcome | `http_status` | `billable_credits` | Scored |
|---|---|---|---|---|---|
| 1 | `transcript` | `ok` | **200** | 1 | 1 |
| 1 | `metadata` | `ok` | *(null)* | 1 | 1 |
| 3 | `transcript` | `unavailable` | **206** | *(null)* | **1** |
| 4 | `metadata` | `ok` | *(null)* | 1 | 1 |
| | | | | | **4 — exact match** |

**Step 2 contributes no row at all**, which is the headline: a fully warm generation touches the
vendor zero times.

**D13's payoff, stated plainly.** The `unavailable → 1` branch is the one place the formula asserts a
charge the vendor never reports, and until Phase 2 it rested on `outcome` — our own label, applied at
our own call site. Here the same row carries the vendor's `http_status = 206`, and the two agree. Had
they disagreed, the delta of 4 would have been the thing that said so.

## The four steps

### 7.4 / Step 1 — cold captioned video (PASS, +2)

`aircAruvnKk` (3Blue1Brown, 18 430 chars, so `summaryCost` 1). Summary delivered in Polish; UI
reported `1 CREDIT SPENT`, balance 8 → 7.

- `summaries`: `metadata_via = 'fetched'`, `resolved_via = 'inline'`, `metadata_ms = 2893`.
- Ledger: one `transcript` row (`200`, billed 1) and one `metadata` row (billed 1).
- `metadata_cache` row written for `aircAruvnKk` (`3Blue1Brown`, 1120 s).
- `supadata_reservations`: **two** rows — transcript reserved **1**, settled 1; metadata reserved
  **2**, settled **1**. The reserve-the-maximum rule observed against real traffic: the breaker
  cannot gate the retry that happens inside `fetchVideoMetadata`, so it holds both requests' worth
  and gives one back at settle.

**This request also initialized the breaker**, and that is worth recording separately because it can
only ever be observed once per deployment. `supadata_budget` was seeded by the P5 migration with
`max_credits`, `used_credits` and `read_at` all null. The first pass returned `refresh_required` and
reserved nothing, the caller fetched `/v1/me`, saved `max=100 / used=81` at `13:27:24`, waited the
1.2 s vendor spacing, and the **second** pass made the real decision — the reservation is stamped
`13:27:26`, strictly newer than the reading that authorized it, which is the property
`save_supadata_budget`'s retention rule depends on. This is the production counterpart of Phase 6's
row 6.8 and of Phase 5's SQL row 5.9, and it is what distinguishes an uninitialized deployment from a
permanently disabled one.

### 7.5 / Step 2 — immediate repeat (PASS, **+0**)

Same video, `educational` character (a second character rather than a second account — sufficient
here because the assertion is about spend, not about the `videos` upsert that row 4.8 covers).

- `usedCredits` **did not move**: 83 before, 83 after.
- `summaries`: `metadata_via = 'stored'`, `resolved_via = 'stored'`.
- **Zero** new `supadata_calls` rows and **zero** new `supadata_reservations` rows. The second fact
  is the D5 reshape observed live: the breaker gates *spend*, not the request, so a request that will
  not spend never reaches a check point at all.
- `metadata_ms = 66` against 2893 on the cold run. This is exactly the semantics change the plan
  flagged — the column brackets a DB read on a hit and an HTTP call including its retry sleep on a
  miss — and `metadata_via` is what lets a query tell the two apart. Any comparison across rows must
  filter on it.

S-07 got a repeat down to 1 credit by caching the transcript. This gets it to **0** by caching the
metadata too, now confirmed at the vendor's own billing level rather than locally.

### 7.6 / Step 3 — caption-less video (PASS, +1)

`brXcsLhw84o`.

- **The new D3 copy reached the user**: *"This video has no captions, so there is nothing to
  summarize. We can only summarize videos that have a caption track — try another video."* This is
  the server's 422 string, not the client's `"No transcript is available for this video."` fallback —
  the Phase 1 client fix holds in production, which is the half that would have silently swallowed
  the whole of D3.
- Ledger row: `transcript` / `unavailable` / `http_status = 206` / `billable_credits = null`. The
  exact shape the reconciliation formula assumes, now observed in production.
- **The charge landed**: balance 6 → 5, one `credit_reservations` row `amount = 1`,
  `status = 'settled'`, `refusal_reason = 'unavailable'`, and **no `summaries` row** for it (still 2
  summaries at that point). D14 is live for real users.
- `supadata_reservations`: credits 1, **`actual_credits = null`**, settled. A 206 is billed 1 and
  reports no header, so `billedSince` correctly returned `null` rather than 0 — "unknown is
  contagious", and the RPC keeps counting the row at its reserved maximum instead of forgiving it.
- No `metadata` call was made: the 422 exits ~200 lines ahead of `fetchVideoMetadata`, and
  `metadata_cache` still held only `aircAruvnKk` afterwards.

The UI's credit counter still read `6` on the refusal screen. That is **not** a defect — D14's
explicit call was to ship the charge silently, with the 422 body unchanged and no balance in the
response. Recorded here because it is the first time a real user-facing surface has shown it, and it
is the thing to revisit first if support questions appear.

### Step 4 — warm transcript, cold metadata (PASS, +1)

`nWzXyjXCoCE` (16 257 chars). Its transcript had been cached in production since 2026-07-30, well
inside the 30-day window; `metadata_cache` was empty for it because the table was created minutes
earlier.

- `summaries`: `resolved_via = 'stored'` with `metadata_via = 'fetched'` — the warm-transcript /
  cold-metadata shape.
- One `metadata` ledger row (billed 1), **no** `transcript` row.
- `supadata_reservations`: exactly **one** new row, credits **2**, settled 1 — and no transcript
  reservation at all, because no transcript call happened.

**This is the traffic Phase 6's second check point exists for, and the step demonstrates why it is
not redundant**: the metadata call here *is* the first and only paid call of the request. A breaker
sitting only in front of the transcript fetch would have been bypassed completely — on exactly the
traffic Phase 4's cache is designed to create.

## Cross-cutting observations

**The reading anchored while the reservations tracked.** `supadata_budget.used_credits` stayed at 81
for the whole pass and `read_at` never moved past `13:27:24` — the 900 s reading TTL had not elapsed.
So across steps 2–4 the breaker was evaluating against a reading that was already 4 credits stale,
and it was still correct, because the outstanding reservations carried the difference. That is the
D5 design working as specified rather than as a claim: `/v1/me` anchors, reservations track spend
since the anchor, and neither source is sufficient alone.

**No reservation was stranded.** All four `supadata_reservations` rows ended `settled = true` with a
`settled_at` stamp, across a success, a warm no-op, a 206 refusal and a metadata-only run. The sweep
never had to act — which is what makes it a backstop rather than the primary mechanism.

**No metadata retry fired**, so the pass exercised the *typical* 2-credit cold cost rather than the
3-credit ceiling. Both metadata reservations were taken at 2 and settled at 1. Phase 6's row 6.16 has
the only live sighting of the retry so far; nothing in this slice can say how often it fires, and
that remains the open question the ceiling was derived against.

**Clock note.** Timestamps in this record come from two clocks: `read_at` is the Worker's pre-call
stamp and `created_at` / `settled_at` are PostgreSQL's `now()`, while the `/v1/me` readings were
taken from the operator's Windows machine, which was running ~35 s behind both. Only the *deltas*
were used for any assertion; no conclusion here rests on comparing the two clocks.

## What was NOT verified live, and why

- **The stop threshold was never reached.** Tripping it for real requires driving the plan to within
  `BUDGET_STOP_RESERVE` (3) of exhaustion, i.e. spending ~95 credits. Phase 6 verified it locally by
  temporarily raising the constant (rows 6.8–6.11), and row 6.17's evidence that the override was
  reverted is an empty `git status`, not a reading of the constant. The breaker's *refusal* path is
  therefore proved locally and unproved in production, by choice.
- **The warn threshold delivers nowhere** (D5b). `reportBudgetThreshold` logs; the receiver lands
  later, tracked outside this roadmap. Until then budget exhaustion surfaces through the stop
  threshold — users seeing an error, which is the channel lever C exists to avoid.
- **The Whisper job path will never be verified**, in production or anywhere else. Under D1's
  `mode: "native"`, `resolved_via = 'job'` cannot occur by construction, so S-07's hand-over question
  about the Whisper fallback rate is now permanently unanswerable. Accepted when D1 was locked; the
  consequence is that lever A's saving stays **contractual** rather than measured.
- **The fail-open paths** (unreadable budget state, hung or malformed `/v1/me`) were not re-exercised
  against production — they need a broken vendor endpoint or an invalid key, both of which would mean
  deliberately breaking the live service. Phase 6 rows 6.13 and 6.14 cover them locally, and 6.14's
  load-bearing assertion is that a malformed body left `max_credits` still null rather than poisoning
  the anchor with `NaN`.

## Operational notes

- **The test account was topped up to run this pass.** The operator's account held **0** app
  credits in production, so generation was disabled outright. 8 credits were granted through the
  documented operator path (`scripts/grant-credits.mjs` pointed at the production project); the pass
  consumed 4, leaving **4**. Reverting this is a judgement call rather than a cleanup step — the
  account started at 0 by ordinary use, not by design.
- **The refusal charge is now live for real users**, and it is the only change in the slice that
  takes something from a user rather than saving the operator money. Per the plan's deploy note, the
  thing to watch in the first day is `credit_reservations` filtered on a non-null `refusal_reason`;
  Phase 3's classification makes that a one-column filter rather than an anti-join against
  `summaries`. Its rate broken down by reason is the first evidence of whether the friction is
  proportionate.
- **Production data created by this pass**: 3 `summaries`, 2 `videos`, 2 `metadata_cache` rows, 1
  `transcript_cache` row (`aircAruvnKk`), 4 `supadata_calls` rows, 4 `credit_reservations` rows and 4
  `supadata_reservations` rows. All ordinary application data; nothing needs cleaning up.
