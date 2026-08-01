# Transcript Cost Guardrail — Plan Brief

> Full plan: `context/changes/transcript-cost-guardrail/plan.md`
> Locked design: `context/foundation/roadmap.md` §S-09, Decisions D1–D12 (2026-07-31)
> Phase 1 verification: `reviews/manual-verification-phase-1.md` (2026-08-01) — the source of D13/D14

## What & Why

The app prices generation in characters, *after* the fetch, capped at 2 user credits. Supadata bills in
minutes, *during* the fetch, uncapped. So one ~50-minute video on the Whisper path drains a whole
100-credit month, and `HARD_MAX_TRANSCRIPT_CHARS` cannot help because it runs after the money is spent.
This slice bounds the spend per generation and across the fleet, and tells the user when a video cannot
be summarized cheaply instead of absorbing the cost invisibly.

**Extended 2026-08-01, after Phase 1's live verification.** That pass surfaced two gaps the original
scope did not cover: the ledger records no HTTP status, so "a 206 costs a credit" was a derived claim
propping up the reconciliation formula (**D13**); and a caption-less submit cost the operator 1 credit and
the user 0, with D4's 2 h window multiplying exactly that traffic (**D14**). Two new phases, 2 and 3;
everything downstream shifted by two.

## Starting Point

`fetchTranscript` requests `mode=auto` (`transcript.ts:255`), which falls back to Whisper silently.
S-07's `transcript_cache` and `supadata_calls` ledger are live, so transcript reuse already works and
spend is already measured — but `fetchVideoMetadata` (`generate.ts:568`) is called unconditionally with
no lookup, making it 100% of a repeat generation's cost. Nothing anywhere reads the org's remaining
budget.

## Desired End State

A generation costs at most **3** Supadata credits (**2** typically; the third is metadata's billable
retry, which the breaker cannot gate because it happens inside `fetchVideoMetadata`), and **0** on a warm
video — a bound known before any work starts rather than discovered afterwards. A caption-less video gets
its own message saying so. When the monthly plan is nearly exhausted, paid work is refused before it
starts — **atomically, so concurrent requests cannot each spend the same last credit** — and a structured
event is emitted through a seam a monitoring tool can later receive.

## Key Decisions Made

| Decision | Choice | Why | Source |
| --- | --- | --- | --- |
| Which levers | A (`mode: "native"`) + C (budget breaker) | A bounds the video, C bounds the fleet; B and D rejected | Roadmap |
| `mode` configurability | Hard-coded constant, no env var | A secret toggle re-enables the expensive path with no trace in code | Roadmap D2 |
| Negative-cache window | 24 h → 2 h | A day is too long to wait for a freshly published video's captions | Roadmap D4 |
| Metadata cache shape | Full `metadata_cache` keyed by `youtube_id` | `videos` is per-user and cascades — one deletion would evict shared data | Roadmap D6 |
| Metadata fetch placement | Lookup hoisted to `:317-322` (after the 402 gate), fetch unmoved | A hit removes the request; the miss path's two other reasons still hold | Roadmap D7 |
| Notification | One swappable function, no receiver yet | Monitoring tool lands later; warn is decorative until then | Roadmap D5b |
| **Cache-hit marker** | **`summaries.metadata_via` column** | Literal symmetry with S-07's `resolved_via`; costs a `persist_summary` swap | **Plan** |
| **Breaker at the metadata call** | **Gate it too — skip metadata, keep the summary** | On a warm transcript the metadata call *is* the first paid call; refusing post-debit to protect a thumbnail is worse | **Plan** |
| **Stop threshold** | **`remaining < 3`** | Derived from the worst-case envelope (1 transcript + 2 metadata, the second being the retry), not picked | **Plan** |
| **Unreadable budget state** | **Fail open, and report it** | A `/v1/me` outage must not break a product whose transcript API is fine | **Plan** |
| **Verification budget** | **~4 credits live, ≤6 worst case** | Proves the envelope against the vendor's own billing, as S-07 did | **Plan** |
| **Breaker mechanics** | **Atomic reserve/settle under the singleton row** | A read-then-spend breaker bounds nothing: ledger rows only flush in `POST.finally`, so a request's own spend is invisible to every concurrent one | **Review F2** |
| **Live accounting source** | **Reservations, not `supadata_calls`** | The ledger is stale by the duration of the work it would bound, and `error` + null header means *unknown*, not zero | **Review F2** |
| **Reservation size** | **Transcript 1, metadata 2** | The breaker cannot gate the retry *inside* `fetchVideoMetadata`, but it can refuse to start unless both requests fit | **Review F1+F2** |
| **Refresh spacing** | **Refresh-claiming caller waits `RETRY_DELAY_MS`** | An in-line `/v1/me` lands directly before the paid call on a 1 req/s plan; one request per TTL pays it | **Review F3** |
| **Budget service totality** | **Never throws; `AbortSignal.timeout`; response narrowed** | The second check sits *after* the debit and the LLM call, where a throw bypasses the refund | **Review F4** |
| **Refusal status** | **`503`, with the client preferring `serverError`** | `case 503` currently hardcodes "isn't configured", so the breaker's copy would never reach a user | **Review F6** |
| **HTTP status in the ledger** | **`http_status`, transcript calls only, no backfill** | Makes the billable 206 observed instead of inferred from our own `outcome` label | **D13 (user)** |
| **Charging for a refusal** | **1 credit on 4 of the 5 422 exits** | A submit that costs the operator should cost the user; the 2 h window multiplies exactly this traffic | **D14 (user)** |
| **Transient failures** | **Exempt from the charge** | `error` + null header means the cost is *unknown* — charging resolves our ambiguity against the user | **D14 (user)** |
| **Cache-hit refusals** | **Charged, though the operator paid nothing** | A flat rule beats one that costs differently depending on cache state the user cannot see | **D14 (user)** |
| **Charge visibility** | **None — copy and 422 body unchanged** | User's explicit call; the consequence is recorded in the plan's out-of-scope list rather than mitigated | **D14 (user)** |
| **Charge idempotency** | **Reuse the request's `requestId`; skip if absent** | A fresh key would bill once per retry — the exact case `requestId` exists to absorb | **Plan** |

## Scope

**In scope:** `mode: "native"`; a dedicated 422 for caption-less videos (server *and* client); the 2 h
negative-cache window; `supadata_calls.http_status` for transcript calls (D13); a 1-credit charge on
refusals in the billable class (D14); `metadata_cache` + `metadata_via`; the budget breaker as an atomic
reserve/settle (`supadata_budget` + `supadata_reservations`), its 503 refusal end to end (server *and*
client), and its notification seam.

**Out of scope:** what a **successful** summary costs the user (`summaryCost` is untouched — S-05 still
owns pricing for delivered work); charging for transient failures (D14); surfacing the charge in the UI
(D14); `http_status` on metadata calls (D13); upgrading the Supadata plan; delivering the notification
anywhere (D5b); backfilling either the metadata cache (D11) or `http_status` (D13); negative-caching
metadata failures (D9); injection screening (S-10).

> The original "not changing what a summary costs the user in app credits" boundary was **removed
> 2026-08-01** — it is what left the caption-less submit free to the user and billable to the operator.
> The replacement above is narrower on purpose.

## Architecture / Approach

Three guards on the existing pipeline, no restructuring:

```
request → 402 gate → transcript quote → transcript_cache ─┐
                                        metadata_cache ───┤ (both free; hits skip everything below)
                                                          ↓
              [reserve 1] → rate limit → transcript fetch → [settle]
                                                          ↓
                    debit → LLM → [reserve 2] → metadata fetch → [settle]
                                                          ↓
                                     persist_summary (+ metadata_via)
```

Both breaker points sit on **miss** paths only: a cache hit costs nothing, so blocking it would break
the product for no saving.

Each `[reserve]` locks the singleton `supadata_budget` row `for update`, counts outstanding reservations
at their **maximum** (an unknown outcome stays charged), and either hands back a reservation id or
refuses with a 503. Each `[settle]` is a `finally` obligation, records the real billed figure, and never
deletes its row — a stale sweep and the next `/v1/me` refresh are what clear them. The reserve precedes
the rate-limit check so a refusal costs the user no transcript attempt.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Lever A + 422 split ✅ | The cost bound itself; caption-less videos get their own copy | The client discards the server's 422 string — miss it and the copy never ships |
| 2. `http_status` (D13) | The billable 206 becomes observed, not inferred | Almost none — one nullable column and an optional meter field; the risk is scope creep into `metadata.ts` |
| 3. Refusal charge (D14) | An unusable submit costs the user 1 credit | A charge keyed on anything but the request's own `requestId` bills once per retry |
| 4. `metadata_cache` + marker | Repeat generations stop paying for metadata | `persist_summary` drop+recreate at 24 params; a stale overload if done with `create or replace` |
| 5. Reservation ledger | The atomic mechanism, provable in SQL, called by nothing yet | The concurrency assertion needs two open sessions — a single-session test passes while proving nothing |
| 6. Wiring the breaker | The bound made real: two check points, 503 end to end | A settle leaked on an error path holds credit hostage until the sweep; and the reserve must be *before* the rate-limit check |
| 7. Deploy + verify | Live, reconciled against `GET /v1/me` | The push/deploy window: between the two commands, every generation fails after the LLM is paid for |

**Prerequisites:** S-01, S-07, S-08 — all shipped. No new Worker secrets.

**Why the charge lands before the breaker.** Both bound the same overspend, but the charge is per-user,
bites from the first event, and needs no vendor call, while the breaker only engages once the plan is
nearly exhausted and protects the budget by refusing service to everyone at once. Cheaper and more
targeted goes first. Phase 3 depends on neither the metadata cache nor the reservation ledger, so its
position blocks nothing.

**Estimated effort:** ~7 sessions, one per phase, with a manual gate between each. Review F2 roughly
doubled the breaker's size — a second table, reserve/settle RPCs with a stale sweep, a settlement
obligation on every paid exit path, a fourth file (`GenerateSummaryForm.tsx`), and a concurrency
assertion that has to be written by hand because nothing else in the repo tests it — so it is split
across two phases rather than crammed into one.

**Why 5 and 6 are separate.** The split follows the line where verification changes character. Phase 5's
central property is a *database* property: two concurrent reserves against a one-generation budget yield
one reservation and one refusal. That is provable in two psql sessions in minutes, and the migration is
purely additive, so it needs no deploy coordination. Bundled with the wiring it would instead be
verified last, through the UI, where a failure looks like any other failure. It is also a clean revert
boundary: dropping Phase 6 leaves Phase 5's tables in place and unread.

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
- **`/v1/me`'s rate bucket is assumed, not confirmed.** The vendor docs do not say whether it shares the
  transcript endpoints' 1 req/s limit. The plan takes the conservative reading and isolates the wait in
  one constant, so it is a one-line deletion if Phase 7's live pass shows the endpoint is exempt.
- **The reservation sweep window is a guess bounded by the transcript poll.** Set it too short and it
  un-reserves a call that is still running, reopening the race the reservation exists to close. Erring
  long only makes the breaker temporarily over-conservative — so err long.
- **The refusal charge ships silently, by decision (D14).** A user can lose several credits to repeated
  caption-less submits with no on-screen acknowledgement — including on cache hits, the one case where
  the operator paid nothing. This is the slice's only change that takes something from a user, and it is
  also the only one with no UI surface. Watch settled, summary-less `credit_reservations` rows in the
  first days after Phase 7; if the rate looks disproportionate, the copy is the first thing to revisit.
- **A charge cannot be un-made by a revert.** Reverting Phase 3 stops future charges but returns nothing
  already taken. The affected rows are trivially identifiable, which is an argument for keeping them
  rather than deleting them.

## Success Criteria (Summary)

- A repeat generation of the same video moves `usedCredits` by **0**, verified against the vendor.
- A cold generation costs at most 3 credits (2 without a metadata retry), and the ledger reconciles
  exactly with `GET /v1/me`.
- A user submitting a caption-less video is told *that*, not a generic failure — and is charged 1 credit
  for it, so the cost of an unusable submission is no longer carried entirely by the operator.
- The billable 206 is identifiable from a recorded HTTP status rather than from our own outcome label,
  and the two agree.
- Two concurrent reserves against a one-generation budget produce one reservation and one refusal —
  never two. This is the property that distinguishes a fleet bound from an advisory one.
