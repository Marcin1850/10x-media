# Phases 2 and 3 — Manual verification record

- **Change**: `transcript-cost-guardrail` (S-09)
- **Phases**: 2 — `http_status` on the transcript ledger (D13); 3 — charging for a refusal in the
  billable class (D14). Run as one pass because they share submissions: a single caption-less generation
  answers both 2.6 and 3.9, and a single captioned one answers 2.7, 2.8 and 3.14.
- **Date**: 2026-08-04
- **Environment**: **local only** — dev server on `localhost:4321`, local Supabase stack
  (`127.0.0.1:54321`). Nothing deployed; Phase 7 remains the single deploy gate.
- **Code under test**: branch `transcript-cost-guardrail` at `adb6af0` (Phase 3 implementation `6a62cf1`
  plus the impl-review triage of F1–F3, of which F1 made `requestId` required in `generateSchema`).
- **Account**: `verify-s09@local.test`, created for this pass, opening balance 5 app credits.
- **Result**: **all eleven rows pass (2.6–2.9, 3.9–3.15)**.

## Pre-flight

Port 4321 was **free** before the pass — no stale server, unlike Phase 1. The server under test was
started 14:52 local, well after `adb6af0`. The check is worth keeping: Phase 1 nearly ran its whole
pass against three-day-old code.

Migrations `20260731100000` (P2) and `20260731110000` (P3) confirmed applied to the local stack before
any submission.

## Spend

| Point | `usedCredits` |
|---|---|
| Before | 71 / 100 |
| After | 74 / 100 |
| **Delta** | **3** |

Ledger for the same window, scored by the per-outcome formula:

| Operation | Outcome | `billable_credits` | `http_status` | Scored |
|---|---|---|---|---|
| `transcript` | `ok` | 1 | **200** | 1 |
| `metadata` | `ok` | 1 | *(null)* | 1 |
| `transcript` | `unavailable` | `null` | **206** | **1** |
| `transcript` | `error` | `null` | **401** | 0 |
| | | | | **3 — exact match** |

**This is the cross-check D13 was added for, and it is the first time it could be made.** Phase 1
reconciled the same total, but its `unavailable → 1` branch rested on `outcome`, which is our own label
applied at the call site. Here the same row carries `http_status = 206` from the vendor, so the label
and the status corroborate each other rather than one standing alone. The `error`/`401` row is the
other half: also a null header, also unpriceable from the header, but correctly scored **0** — the two
nulls the plan warned must not be collapsed, now distinguishable by two independent signals.

App credits: 5 → 1. One delivered summary (1) plus **three** refusal charges (3).

## Phase 2

### 2.6 — Caption-less video records `206` / `unavailable` / null billable (PASS)

Video `brXcsLhw84o` — the same "1 Minute Piano Music" Phase 1 used, chosen because it is *known*
caption-less, so the path is reached without probing candidates at a credit each. Its Phase 1 cache row
was 2 d 22 h old, past D4's 2 h window, so this was a genuine **cold** fetch rather than a hit.

Row written: `operation = 'transcript'`, `outcome = 'unavailable'`, `billable_credits = null`,
`http_status = **206**`. Exactly the shape the reconciliation formula's `unavailable → 1` branch
assumes — now observed, not reconstructed.

No `metadata` row for this generation: the 422 exits ~200 lines before the metadata call, which is what
makes "cold video without captions = 1 credit" hold.

### 2.7 — Captioned video records `200` with `billable_credits = 1` (PASS)

Video `aircAruvnKk` — 3Blue1Brown, "But what is a neural network?". Cold (absent from
`transcript_cache`); captions confirmed on the watch page *before* spending, the same cheap pre-check
Phase 1 used. `POST` → 200, `transcriptLength = 18430` (under `LONG_TRANSCRIPT_CHARS`, so `cost = 1`),
Polish summary rendered.

Row: `transcript` / `ok` / `resolved_via = 'inline'` / `billable_credits = 1` / `http_status = **200**`.

### 2.8 — The same generation's `metadata` row has `http_status = null` (PASS)

The `metadata` row written by that same generation carries `http_status = null` while its sibling
`transcript` row carries 200. The scope boundary holds: `httpStatus` defaults to `null` on the record,
so `metadata` stays out without a special case, and nothing leaked through the shared meter.

Pre-migration rows corroborate the same thing from the other direction — the 2026-08-01 `transcript`
rows still read `null`, so the migration backfilled nothing (2.3, re-observed here for free).

### 2.9 — The failure arm carries the status too (PASS)

The half most likely to be left unplumbed, because the success path looks complete on its own.

Forced with an **invalid `SUPADATA_API_KEY`**: `.dev.vars` was backed up to the scratchpad, the key
replaced, the dev server restarted, one submission made against `8jLOx1hD3_o` (cold, absent from
`transcript_cache`), then the file restored and verified byte-identical by md5 before the pass
continued.

`POST` → **502** "The transcript service failed. Please try again." Row: `transcript` / `error` /
`billable_credits = null` / `http_status = **401**`.

That 401 can only have arrived through `httpStatusFromError` — the success path never ran. `null`
would have been indistinguishable from "not plumbed", which is precisely why this row exists.

The invalid key was rejected before any work, so this step cost **0** Supadata credits.

## Phase 3

### 3.9 — Cold caption-less: 422, balance −1, settled reservation, no summary (PASS)

The same submission as 2.6. Response: 422 with `TRANSCRIPT_NO_CAPTIONS_ERROR`, verbatim the Phase 1
copy — the charge did not disturb it (D14 ships silently).

Balance 4 → 3. One `credit_reservations` row for that `request_id`: `amount = 1`, `status = 'settled'`,
`refusal_reason = 'unavailable'`. Asserted **as a left join against `summaries`**, not as a null check
on the reservation — the FK points from `summaries.reservation_id`, so "no summary" is a `not exists`.
Result: `has_summary = f`.

### 3.10 — Cache-hit resubmit, new `requestId`: charged again, no vendor call (PASS)

Immediate resubmit, fresh `requestId`. Balance 3 → 2, a second settled row with
`refusal_reason = 'unavailable'`, and the ledger row count for the window **unchanged at 3** — no
Supadata call was made.

**This is the deliberate asymmetry, observed rather than argued**: the user paid 1 credit for a request
that cost the operator nothing. Accepted so the same action does not cost differently depending on
cache state the user cannot see.

`transcript_fetch_attempts` also stayed at 2 — the cache lookup sits ahead of `recordTranscriptAttempt`,
so a hit never touches the rate-limit window. Same observation Phase 1 made, still true with the charge
in front of it.

### 3.11 — Same `requestId`: no second charge **and the same 422** (PASS)

Third submission of the same video reusing 3.10's `requestId`. Response: **422 with the identical
copy** — not a 409 "start a new generation". Balance held at 2, exactly one reservation row for the key,
ledger count still 3.

**Why this is a replay and not a coincidental re-run of the cached-`unavailable` path.** Both would
print the same 422, so the response alone does not discriminate. Row 3.12 below is the control: an
identically shaped row differing **only** in `refusal_reason` answers 409. Since `begin_generation`
classifies a settled, summary-less reservation as `'unavailable'` either way, the 422 here can only
have come from `lookupRefusalReplay` finding a reason. The pair is the assertion; neither row proves it
alone.

### 3.12 — An operator-settle key still answers 409 (PASS)

A settled, summary-less `credit_reservations` row was written directly with `refusal_reason = null`, as
an operator settle would leave it. Submitting that `requestId` returned **409** "This request was
already processed. Start a new generation."

The new column is what separates "we refused this video and charged for it" from "an operator closed
this key". Collapsing them would either hide an operator action behind a transcript message or tell a
user to start over after a refusal that will refuse identically.

**Incidental, and worth knowing before Phase 7**: the first attempt at this row used a hand-typed
`11111111-2222-…` key and was rejected **400 "Invalid UUID"**. `z.uuid()` in zod v4 validates the
version and variant nibbles, not merely the 8-4-4-4-12 shape. Only reachable now that F1 made
`requestId` required — a client generating keys by any means other than `crypto.randomUUID()` would be
rejected at the boundary.

### 3.13 — A seeded `'empty'` row charges; a transient failure does not (PASS)

*Charges.* `brXcsLhw84o`'s cache row was flipped to `outcome = 'empty'` (Phase 1's technique: a seeded
row guarantees a hit, so the check cannot trigger a paid call). Response: 422 with
**`TRANSCRIPT_UNAVAILABLE_ERROR`**, the generic string — the D3 split survives D14 untouched, because
charging and copy are separate axes. Balance 2 → 1, row written with `refusal_reason = 'empty'`. The
row was restored to `unavailable` immediately afterwards.

*Does not charge.* The forced 401 of 2.9: **no** `credit_reservations` row for that `requestId`, balance
unchanged. The exemption holds — a null header on an `error` means the cost is *unknown*, and the
ambiguity is not resolved against the user.

### 3.14 — A successful generation still costs exactly `summaryCost` (PASS)

The 2.7 generation: `creditsRemaining = 4`, `cost = 1`, balance 5 → 4. Exactly **one** reservation for
that `request_id`, `refusal_reason = null`, with a matching `summaries` row. The refusal charge does not
stack onto the happy path.

### 3.15 — At balance 0 the 402 gate answers first (PASS)

Balance set to 0, then a caption-less submission — the path that *would* charge at any positive balance.
Response: **402** "You have no summary credits left". No reservation row, and the ledger row count for
the window unchanged.

The gate is upstream of every paid call and of the charge, so a zero-balance user cannot be driven into
either. `'insufficient'` inside `charge_failed_transcript` therefore stays what the plan intends: a
mid-request balance change, not a normal path.

## Local state afterwards

Restored to hold no fabricated data, following Phase 1's precedent:

- `transcript_cache` for `brXcsLhw84o` back to `outcome = 'unavailable'` with its real `fetched_at`
  (12:55:28, written by this pass's genuine cold fetch).
- The 3.12 seeded reservation deleted.
- `verify-s09@local.test` balance set back to **1** — the figure the four real charges produce (5 − 1
  summary − 3 refusals). The 0 used for 3.15 was a test action, not an observation.
- `.dev.vars` restored and md5-verified against the pre-pass backup.

What remains is real: four settled reservations (one summary, three refusals), four ledger rows, one
summary row, and the `brXcsLhw84o` / `aircAruvnKk` cache rows.

## Not verified here, deliberately

- **Anything in production.** Both migrations stay local; Phase 7 is the single deploy gate.
- **`metadata`'s HTTP status.** Out of scope by the user's call (P2 scope boundary) — 2.8 asserts the
  boundary holds rather than that the value is useful.
- **The UI rendering of these paths.** Driven through the API with an authenticated cookie session
  instead, because 3.10–3.12 turn on controlling `requestId` and the client generates its own. The 422
  copy reaching the user through `GenerateSummaryForm.tsx` was proved in Phase 1 (row 1.6) and neither
  phase touched the client.
- **Concurrency on the charge.** Already proved in two psql sessions at implementation time (recorded
  in `change.md`, 2026-08-02): one `'charged'`, one `'replay'`, one row, one decrement.
