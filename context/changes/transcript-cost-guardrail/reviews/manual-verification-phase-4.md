# Phase 4 — Manual verification record

- **Change**: `transcript-cost-guardrail` (S-09)
- **Phase**: 4 — `metadata_cache` (D6/D8/D9) and the `metadata_via` hit marker (D10), plus the
  `persist_summary` 23 → 24 argument swap.
- **Date**: 2026-08-04
- **Environment**: **local only** — dev server on `localhost:4321`, local Supabase stack
  (`127.0.0.1:54321`). Nothing deployed; Phase 7 remains the single deploy gate, and this is the
  migration that makes that gate matter.
- **Accounts**: `verify-s09@local.test` (A) and `verify-s09b@local.test` (B, created for this pass).
  Two accounts deliberately — see 4.8.
- **Result**: **all four rows pass (4.6–4.9)**.

## Pre-flight

The dev server was restarted onto the Phase 4 code before any submission — not relied on HMR. Port
4321 was confirmed clear first, then re-confirmed listening. This is Phase 1's lesson applied: a
server started before the commit under test invalidates every result while still looking valid.

## Spend

| Point | `usedCredits` |
|---|---|
| Before | 74 / 100 |
| After | 78 / 100 |
| **Delta** | **4** |

Per-outcome ledger total for the window: **4 — exact match**, four rows, every one reporting a real
`x-billable-requests` value.

| Step | Transcript | Metadata | Total |
|---|---|---|---|
| Livestream 413 (unplanned, see below) | 1 | — | 1 |
| 4.6 cold video | 1 | 1 | 2 |
| 4.7 / 4.8 warm video, second account | **0** | **0** | **0** |
| 4.9 aged metadata row | 0 | 1 | 1 |

**The 0-credit row is the slice's headline claim, observed locally for the first time.** S-07 got a
repeat generation down to 1 credit by caching the transcript; this pass got it to 0 by caching the
metadata too. The vendor's own counter did not move for a complete, successful generation.

## An unplanned 413 that was worth its credit

The first attempt at 4.6 used `8jLOx1hD3_o`, chosen because Phase 2's forced-error step had left it
absent from `transcript_cache`. It returned **413** — the transcript is **1 696 642 characters**, a
24/7 livestream rather than a video.

Not a Phase 4 failure, and it cost 1 credit rather than 2 precisely because the design works: the 413
exits before the metadata call, so no `metadata_cache` row and no `metadata` ledger row were written.
It also incidentally re-confirmed two things nothing in this phase was testing — S-07's F6 `too_long`
caching (the row stores `content_chars = 1696642` with an empty body, so a resubmit answers 413 for
free) and Phase 2's `http_status = 200` on that path. Recorded because the *next* pass over this repo
will otherwise re-pick the same video: **`8jLOx1hD3_o` is not a usable test video.**

Retried with `kJQP7kiw5Fk` (4:41, 2 990 characters).

## 4.6 — Cold generation: `fetched`, ledger row, cache row (PASS)

`POST` → 200, `cost = 1`. Summary row: `metadata_via = 'fetched'`, `metadata_ms = 2912`,
`resolved_via = 'inline'`. Ledger: one `transcript` row and one `metadata` row, both
`billable_credits = 1`.

`metadata_cache` row written with all five fields populated — title, thumbnail, channel, duration
(282 s) and published date. Not a partially-filled row, which is what a mismatch between the DTO's
vendor spelling (`thumbnailUrl`) and the table's `videos` spelling (`thumbnail_url_reported`) would
have produced.

## 4.7 — Warm generation: `stored`, no ledger row, near-zero `metadata_ms` (PASS)

Second account, same video, other character. `POST` → 200.

Summary row: `metadata_via = 'stored'`, **`metadata_ms = 7`**, `transcript_ms = 17`,
`resolved_via = 'stored'`. The `metadata` ledger row count for the video stayed at **one** — the row
from 4.6 — so no vendor call was made.

The 7 ms is the point of the whole marker. It is a database read, not a broken measurement of an HTTP
call, and without `metadata_via` on the same row a cost query would read it as a suspiciously fast
vendor response. 2912 ms → 7 ms across two rows for the same video is the difference the column
exists to explain.

## 4.8 — D12: a cache hit still populates the per-user `videos` row (PASS)

**Verified with a SECOND ACCOUNT rather than a second character, and the distinction is the whole
test.** A second character on account A would have upserted onto a `videos` row that 4.6 already
filled, so `coalesce` would have hidden a regression completely. Account B had no row for this video
at all, so its row could only be built from what the cache supplied.

Account B's `videos` row after the hit:

| Column | Value |
|---|---|
| `title` | Luis Fonsi - Despacito ft. Daddy Yankee |
| `thumbnail_url_reported` | `https://i.ytimg.com/vi_webp/kJQP7kiw5Fk/maxresdefault.webp` |
| `channel_name` | LuisFonsiVEVO |
| `duration_seconds` | 282 |
| `published_at` | 2017-01-12 |

Not nulls. The cache **feeds** `persist_summary`'s coalescing upsert rather than replacing it, which
is what keeps S-02's list rendering for a user who never paid for the metadata. "Hit → skip the
write" is the natural regression here and it would have shipped invisibly on account A.

## 4.9 — A row aged past 30 days produces a fresh fetch (PASS)

`fetched_at` backdated 31 days, then the same video generated again. Applied at **read** time by
`get_metadata_cache`'s `p_max_age_seconds`, so this needs no month-long wait — the same technique
Phase 1 used for the 2 h transcript window.

Result: `metadata_via = 'fetched'`, `metadata_ms = 1061` (a real HTTP call), a **second** `metadata`
ledger row, and the cache row refreshed to a current `fetched_at`. The window expires; it does not
merely fail to be checked.

Worth noting what this row also is: `resolved_via = 'stored'` with `metadata_via = 'fetched'` — a
**warm transcript with cold metadata**, where the metadata call is the *first* paid call of the
request. That is exactly the traffic Phase 6's second breaker check point exists for, and Phase 4 is
what creates it. A breaker sitting only in front of the transcript fetch would be bypassed here.

## Automated criteria (4.1–4.5), re-stated

- Migration applied cleanly to the local stack.
- **Exactly one `persist_summary` overload afterwards** — `pg_proc` shows a single 24-argument
  signature, no stale 23-argument version. This is the one that would have failed silently: a leftover
  overload is only detectable by asking the catalogue.
- `metadata_cache` grants match `transcript_cache` **byte for byte** (`service_role=Dxtm/postgres`,
  no `arwd`), so the table is reachable only through the two definer RPCs; both RPCs and
  `persist_summary` are `service_role`-executable only. `summaries_metadata_via_check` admits exactly
  `fetched` / `stored` / `skipped_budget`.
- `npm run lint` and `npm run build` both clean.
- `metadata_via` distribution afterwards: 9 null, 2 `fetched`, 1 `stored`. The nulls are the
  pre-migration rows — nothing was backfilled, per D11's rule.

## Local state afterwards

No fabricated data. The backdated `fetched_at` of 4.9 was overwritten by 4.9's own real fetch, so the
single `metadata_cache` row holds genuine vendor values with a genuine timestamp. Summaries, videos
and ledger rows are all real. Balances reflect real charges only (A: 5 → 3, B: 5 → 4).

## Not verified here, deliberately

- **The deploy window.** Phase 4's `persist_summary` swap is the only migration in this slice that
  opens one, and it is closed by Phase 7 running `db push` and `wrangler deploy` back to back. Nothing
  local can exercise it.
- **`'skipped_budget'`.** Declared in the constraint by this migration so it is never altered twice,
  but nothing writes it until Phase 6.
- **Cache behaviour under concurrent cold misses.** `save_metadata_cache` deliberately has no advisory
  lock and returns no duplicate-fetch signal — unlike `save_transcript_cache`, where the duplicate was
  expensive enough to measure. A duplicate metadata fetch costs 1 credit and is already visible as a
  second ledger row.
