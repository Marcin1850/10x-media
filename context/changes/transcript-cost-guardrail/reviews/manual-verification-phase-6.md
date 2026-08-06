# Phase 6 — Manual verification record

- **Change**: `transcript-cost-guardrail` (S-09)
- **Phase**: 6 — wiring the breaker (lever C, D5) into the endpoint at two check points, plus the
  client's 503 handling.
- **Date**: 2026-08-06
- **Environment**: **local only** — dev server on `localhost:4321`, local Supabase stack
  (`127.0.0.1:54321`). Nothing deployed; Phase 7 remains the single deploy gate.
- **Code under test**: branch `transcript-cost-guardrail` at `e3161f0` (Phase 6 implementation
  `01b0f34` plus the impl-review triage of F1–F3).
- **Accounts**: `verify-s09@local.test` (A) and `verify-s09b@local.test` (B), both from earlier phases.
- **Result**: **all ten rows pass (6.8–6.17)**.

## Pre-flight

Port 4321 was **free** before the pass — Phase 1's lesson applied for the third time. The server under
test was started 15:46 local, well after `e3161f0`, and was restarted (not HMR-reloaded) whenever
`.dev.vars` changed. Local Supabase was already up; `supadata_budget` held its seeded row with
`read_at is null` and `supadata_reservations` was empty — exactly the state Phase 5's 5.14 walk left
behind, so this pass began from a genuinely uninitialized breaker.

## Spend

| Point | `usedCredits` |
|---|---|
| Before | 78 / 100 |
| After | 81 / 100 |
| **Delta** | **3** |

Under the ~4-credit budget approved for the pass. Ledger for the same window, scored by the
per-outcome formula:

| Operation | Outcome | `http_status` | `billable_credits` | Scored |
|---|---|---|---|---|
| `transcript` | `error` | 401 | *(null)* | 0 |
| `transcript` | `error` | 401 | *(null)* | 0 |
| `transcript` | `error` | 401 | *(null)* | 0 |
| `transcript` | `ok` | 200 | 1 | 1 |
| `metadata` | `error` | *(null)* | *(null)* | 0 |
| `metadata` | `ok` | *(null)* | 1 | 1 |
| `metadata` | `ok` | *(null)* | 1 | 1 |
| `transcript` | `error` | 404 | *(null)* | 0 |
| | | | | **3 — exact match** |

**Seven of the eleven submissions in this pass cost nothing at all**, which is the point worth
carrying: a breaker is mostly verifiable on paths where no vendor call happens, and the pass was
designed around that rather than around repeating Phase 4's cold generations.

## Overrides used, and how they were reverted

| Override | Value under test | Rows it served |
|---|---|---|
| `BUDGET_STOP_RESERVE` | `1000` | 6.8, 6.9, 6.10, 6.11 |
| `BUDGET_WARN_FRACTION` | `0.01` | 6.15 |
| `SUPADATA_BASE_URL` (`supadata-budget.ts`) | local stub `/hang`, `/bad` | 6.14 |
| `SUPADATA_BASE_URL` (`transcript.ts`) | local stub `/dead` | 6.12 |
| `SUPADATA_API_KEY` in `.dev.vars` | an invalid key | 6.13, 6.14 |

Every one carried a `TEMP-P6-MANUAL` marker naming its real value and the row that reverts it, so a
half-finished pass could not leave a plausible-looking constant behind. **6.17's evidence is that
`git status --porcelain` is empty and `grep -rn "TEMP-P6-MANUAL" src/` returns nothing** — the tree is
byte-identical to `e3161f0`, not merely "looks right". `npm run lint` and `npm run build` were re-run
on the reverted tree and both exit 0.

Two fixtures were used in place of overrides and are worth naming because neither is a code change:
`supadata_budget.read_at` was backdated 20 minutes to force staleness (the same technique 4.9 used on
`metadata_cache.fetched_at`), and 20 rows were inserted into `transcript_fetch_attempts` to exhaust
both accounts' rate-limit windows. The seeded attempt rows were **not deleted** — they age out of the
600 s window on their own, which is how the pass waited for them rather than destroying local data.

## 6.8 — Cold video refused before any Supadata call, with the breaker's own 503 copy (PASS)

Video `9bZkp7q19f0`, cold on both caches, account A. The UI rendered, verbatim:

> We've reached our transcript service limit for now, so new videos can't be processed. Please try
> again in a while.

That is `BUDGET_EXHAUSTED_ERROR` (`generate.ts:104-105`), **not** the client's
`"Summary generation isn't configured."` fallback — so the `case 503` change in
`GenerateSummaryForm.tsx` is doing its job. This is the same trap Phase 1 fixed for 422, in the second
place the plan predicted it.

Refused *before* any spend, on four independent signals: `usedCredits` unchanged at 78,
`supadata_calls` unchanged at 17 rows, `supadata_reservations` still empty (a refusal inserts none),
and the app-credit balance unchanged at 3.

One event was emitted, at **error** severity:

```
[supadata-budget] {"threshold":"stop","maxCredits":100,"usedCredits":78,"outstanding":0,"readingAgeSeconds":3}
```

`readingAgeSeconds: 3` is the detail that makes this more than a log line: the decision rested on a
reading this same request had taken 3 seconds earlier. The breaker was uninitialized when the request
arrived, so the first pass returned `refresh_required`, `/v1/me` was fetched and saved, and the
**second** pass made the refusal. The budget row went from all-null to `100/78` with a stamped
`read_at` and a cleared claim — **a clean deployment initialized itself on its first real request**,
which is the app-level counterpart of Phase 5's SQL row 5.9.

## 6.9 — A budget refusal consumes no transcript rate-limit attempt (PASS)

Three refusals in a row. `transcript_fetch_attempts` for account A stayed at **2** across all three,
and `supadata_calls` stayed at 17.

This is the ordering the plan insists on — reserve **before** `recordTranscriptAttempt` — and getting
it backwards would be invisible in every other row of this phase. A run of refusals makes no Supadata
call, so charging them against a ten-attempt window would burn a user's allowance for work that never
happened, and they would then meet a 429 they never earned.

The other half was closed later in the pass: after those refusals, the cold generation of 6.16 ran
normally and took `attempts` 3 → 4. The allowance was intact.

Also observed, and not in the criterion: the second and third refusals returned in a fraction of the
first one's time and emitted no further `/v1/me` traffic — the reading was fresh, so only the first
request paid the refresh.

## 6.10 — A warm video still generates under the same override (PASS)

`kJQP7kiw5Fk`, warm on both caches, account A, educational character. **200, summary delivered, 1
credit spent**, while the identical override was refusing cold videos moments earlier.

This is the D5 reshape that matters most and it is the one a careless implementation breaks: the
breaker gates **spend, not the request**. Summary row: `metadata_via = 'stored'`,
`resolved_via = 'stored'`, `metadata_ms = 33`, `transcript_ms = 66`. `usedCredits` unchanged at 78,
`supadata_calls` unchanged at 17, **no reservation inserted at all** — a fully warm generation never
reaches either check point, so there is nothing to reserve, refuse or settle.

## 6.11 — Warm transcript + cold metadata: `skipped_budget` (PASS)

`aircAruvnKk` — transcript cached from Phase 2, never in `metadata_cache`. Account A, same override.

Summary **produced** (balance 2 → 1), with `metadata_via = 'skipped_budget'`,
`resolved_via = 'stored'`, `metadata_ms = 40`. No new `metadata` ledger row, `metadata_cache` still one
row, no reservation inserted.

Two things this row establishes that the transcript check point cannot. First, the **second check
point is reachable and is not redundant**: on a warm transcript the metadata call is the first paid
call of the request, which is precisely the traffic Phase 4's cache is designed to create. Second, a
trip here **does not refuse the generation** — the user has already been debited and the LLM already
paid for, so the summary ships without a thumbnail and the row explains itself instead of looking like
a vendor failure. `metadata_ms = 40` is the refused reserve (a DB round trip), which is one more reason
`metadata_via` is the mandatory filter on any query comparing that column.

## 6.12 — No unsettled reservation survives, on the completed path or the throwing one (PASS)

**Completed generation** (6.16's cold run): two reservations written — `credits = 1` for the
transcript, `credits = 2` for the metadata — both settled with timestamps, **0 unsettled**.

**Mid-fetch throw**: with `transcript.ts`'s base URL pointed at a dead local route, account B's request
reserved 1, passed the rate limiter, and the fetch threw (`404` → `BilledSupadataError`) → **502**. The
reservation was **settled from the `finally`**, leaving 0 unsettled. Balance B unchanged at 4.

The settled figures are the interesting part, and both are `null` rather than a number:

- the metadata reservation settled at `actual_credits = null` because `billedSince` found two
  `metadata` rows since its checkpoint — one `error` with no header and one `ok` billed 1. **Unknown is
  contagious**: summing the null as zero would have settled a genuine charge as free. The retry the
  reserve-2 exists for actually fired here, unprompted, which is the first live sighting of it in this
  slice (`metadata_ms = 13608` spans the failed attempt, the 1.2 s spacing and the successful retry).
- the throwing transcript reservation likewise settled `null`, so it keeps counting at its reserved
  maximum instead of being forgiven.

Phase 5 proved the sweep works; this proves the sweep is a **backstop** rather than the primary
mechanism — no path in this pass needed it.

## 6.13 — Unreadable budget state: generation proceeds, and says so (PASS)

Budget row reset to uninitialized, an invalid `SUPADATA_API_KEY`, real `/v1/me` host.

```
[supadata-budget] {"threshold":"untracked","maxCredits":null,"usedCredits":null,"outstanding":null,"readingAgeSeconds":null,"reason":"GET /v1/me failed, timed out, or returned an unusable body"}
```

Reported at **error** severity — a guard that cannot evaluate is not a near-miss. The generation then
**proceeded**: a `transcript` ledger row with `outcome = 'error'`, `http_status = 401`. The paid call
was attempted, which is what fail-open means, and **no reservation was inserted** — `untracked` has no
id, which is exactly why it must not be collapsed into `reserved`.

`refresh_claimed_at` was left **stamped rather than cleared**, deliberately: clearing it would send the
next request straight back into a refresh that is currently failing, once per request.

## 6.14 — A hung and a malformed `/v1/me` both fail open (PASS)

Run against a local stub, so both failure modes are deterministic rather than hoped for.

**Hung** (`/hang/me`, never answers): the stub log confirms the request arrived and was never
responded to; the app reported `untracked` with the same reason string and proceeded.
`AbortSignal.timeout(BUDGET_READ_TIMEOUT_MS)` is what ended it — nothing else bounds a Cloudflare
subrequest.

**Malformed** (`/bad/me`, HTTP 200 with `maxCredits: "one hundred"`, `usedCredits: null`): rejected at
the boundary. The assertion that matters is not the log line but the database: `supadata_budget` still
read `max_credits = null, read_at = null` afterwards. **A shape we do not recognise never reaches the
anchor.** Had it been destructured on faith, `max - used - outstanding` would have gone `NaN` and the
breaker would have silently never tripped again — a guard that is off while looking on.

Neither case stranded a reservation.

## 6.15 — Warn fires at most once per TTL, including for two simultaneous stale readers (PASS)

With `BUDGET_WARN_FRACTION` at 0.01 so the threshold is always crossed, three warn events fired across
the whole pass — **one per refresh, never one per reserve**.

*Within one request* (6.16's generation): the transcript reserve refreshed and warned; the metadata
reserve **1.5 s later in the same request** read the fresh row, returned `reserved` on its first pass,
and emitted nothing. Two reserves, one warn.

*Across two concurrent requests*: the reading was backdated 20 minutes and two generations were fired
in parallel from separate sessions (A and B), both reaching the transcript check point.

| | HTTP | Wall time | Refresh | Warn |
|---|---|---|---|---|
| A | 429 | **1.68 s** | claimed | **1** |
| B | 429 | **0.26 s** | — | 0 |

Exactly one warn:

```
[supadata-budget] {"threshold":"warn","maxCredits":100,"usedCredits":81,"outstanding":0,"readingAgeSeconds":1}
```

**The 6× wall-time gap is the evidence, not the log count.** A paid the `/v1/me` round trip plus the
1.2 s `RETRY_DELAY_MS` barrier; B fell through to a decision against the reading it already had and
returned immediately. `read_at` moved exactly once. That is the refresh claim doing under load what
5.11 proved in SQL — and it is why no `warned_at` column is needed: one incident cannot emit thousands
of events because only one caller per TTL is ever in a position to emit one.

**How this pair cost 0 credits, recorded because it changes what the row proves.** Both accounts'
rate-limit windows were pre-filled, so each request reserved, was refused by `recordTranscriptAttempt`,
and returned 429 **without any Supadata call**. The warn is emitted inside `reserveBudget`, before the
rate limiter is consulted, so the event and its payload are identical to a real generation's. What the
429 additionally exercised is a path the plan's criteria never name: `releaseUnspentTranscriptBudget`
settled each reservation at a **known 0**, and A's row was then retired by `reserve_supadata_credits`'s
zero-sweep — whose own comment cites this exact scenario. The gap between reserving and the rate
limiter is covered.

## 6.16 — A refresh-triggering generation still succeeds (PASS)

`9bZkp7q19f0` cold, account A, against a deliberately uninitialized budget row so the refresh was
forced. **200, summary delivered.** Full sequence in one request: `refresh_required` → `/v1/me` →
`save_supadata_budget` → 1.2 s barrier → `reserved` + warn → transcript fetch (`200`, billed 1) →
settle → metadata reserve → fetch (retry, billed 1) → settle → persist.

The paid call that followed `/v1/me` came back **`200`, not `limit-exceeded`** — the barrier is doing
its job. This is the one place the module would otherwise contradict `generate.ts:552-556`, which keeps
the pipeline's two Supadata requests seconds apart on a plan allowing 1 req/s. Whether `/v1/me` shares
that bucket at all is still **unverified** (the vendor docs do not say); this pass is consistent with
the conservative assumption but cannot distinguish it from the barrier being unnecessary.

Summary row: `metadata_via = 'fetched'`, `resolved_via = 'inline'`, `metadata_ms = 13608`.

## 6.17 — Overrides reverted (PASS)

`git status --porcelain` empty, no `TEMP-P6-MANUAL` marker anywhere under `src/`, `.dev.vars`'s
`SUPADATA_API_KEY` byte-equal to `.env`'s. `npm run lint` and `npm run build` both clean on the
reverted tree.

## Incidental findings

- **`TVA738-ERqg` is a long video** (69 989 transcript characters) and answers the 409 confirmation
  gate before either check point. It was picked for a concurrency attempt that it therefore could not
  serve. Recorded next to Phase 4's note that `8jLOx1hD3_o` is unusable: **the useful warm-transcript,
  cold-metadata videos in this repo are `aircAruvnKk`, `_Ae4osPymXY` and `dFY97xFO_mY`.**
- **The retention rule was observed working live**, unprompted. Reservations settled at or before a
  refresh's claim disappeared at the next `save_supadata_budget`, and rows settled at a known 0 were
  retired by the next reserve's zero-sweep. The table never held more than two rows during the pass and
  ended holding one.

## Local state afterwards

No fabricated summaries, videos or ledger rows — every one is the product of a real request.
`supadata_budget` holds a genuine vendor reading (`100/81`). `supadata_reservations` holds one settled
row with `actual_credits = null`, which is correct and will be pruned by the next refresh. The 20
seeded `transcript_fetch_attempts` rows are outside the 600 s window and inert. Balances: A 4, B 4 (A
was topped up mid-pass with `npm run grant-credits`).

## Not verified here, deliberately

- **The stop threshold against a genuinely exhausted plan.** Reaching it would cost ~95 credits, so it
  was verified by overriding `BUDGET_STOP_RESERVE` — the substitution the plan anticipates. What the
  override cannot exercise is the arithmetic at a real boundary; that stays unobserved and is not
  reachable at MVP scale.
- **Whether `/v1/me` shares the transcript endpoints' rate bucket** (see 6.16). Still unverified, still
  assumed conservatively, still one constant in one place if Phase 7 shows it is exempt.
- **`warn` reaching anyone.** D5b: nothing receives these events. Confirmed emitted, not delivered.
- **Anything deployed.** Phase 7 remains the single deploy gate, and it is the deploy that first
  exposes the breaker — and Phase 3's refusal charge — to real users.
