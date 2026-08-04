---
change_id: transcript-cost-guardrail
title: Transcript cost guardrail
status: impl_reviewed
created: 2026-07-31
updated: 2026-08-04
archived_at: null
---

## Notes

**Phases 2 and 3 manually verified 2026-08-04 (local)** — rows 2.6–2.9 and 3.9–3.15 all pass; record at
`reviews/manual-verification-phases-2-3.md`. Run as one pass because the two phases share submissions.
Supadata delta 3 reconciled exactly against the per-outcome ledger total — and this time the
`unavailable → 1` branch was corroborated by the recorded `http_status = 206` rather than resting on our
own `outcome` label, which is the whole point of D13. Both phases stay **undeployed**; Phase 7 is the
single deploy gate. Two things worth carrying forward: 3.11 is only meaningful paired with 3.12 (a
replayed 422 and a re-run of the cached-`unavailable` path are indistinguishable from the response
alone), and `z.uuid()` rejects a hand-typed non-v4 key with a 400 — reachable only now that F1 made
`requestId` required, harmless for the first-party client.

**Phase 3 impl-review triaged 2026-08-04** — verdict NEEDS ATTENTION (0 critical, 2 warnings, 1
observation); all 3 findings fixed, none skipped. F1 made `requestId` **required** in `generateSchema`:
leaving it optional exported the "no key ⇒ skip the charge" rule to the trust boundary, so any
authenticated caller could omit the field and drive the paid `unavailable` path for free. The pre-F22
compatibility clause is superseded by a dated addendum in `plan.md`; the null-tolerant branches stay as
an internal safety net. F2 narrowed the `unique_violation` handler — it now re-reads the
`(user_id, request_id)` key and re-`raise`s when no non-refunded row exists, so an unrelated integrity
failure can no longer be answered as a valid `replay`; both paths re-proved in psql. F3 corrected this
file's own stale routing (deploy gate is Phase 7, not 5). Manual rows 3.9–3.15 remain deliberately
pending.

**Phase 3 addition, 2026-08-02.** `charge_failed_transcript` carries an `exception when
unique_violation` handler the plan did not specify. The plan says `'replay'` must be reached through
the existing partial unique index, and the `select … for update` that does so is copied from
`begin_generation` — but it cannot lock a row that does not exist yet, so two concurrent callers on
one key both find nothing, serialize on the `user_credits` row lock instead, and the loser reaches the
insert. Without the handler that surfaces as a raised exception, and the service would report "not
charged" for a request that genuinely was charged by the other caller. The handler's implicit
savepoint rolls back the loser's own decrement along with its failed insert, so the outcome is exactly
`'replay'`: one row, one credit. Proved in two psql sessions rather than reasoned about.

**Phase 2 adaptation, approved 2026-08-02 (user).** The plan's Phase 2 contract says "No RPC or grant
change — `supadata_calls` is written through the existing insert path." That existing path,
`record_supadata_calls` (`20260728120000_generation_telemetry.sql:305-334`), enumerates its columns
explicitly, so the new column alone would have stayed permanently null while the service sent the value
and the RPC silently dropped it — a failure with no error anywhere, and one that would have sunk manual
rows 2.6–2.9. Fixed with a `create or replace` on the **same** `(jsonb)` signature inside the same
migration: no drop, no signature change, grants preserved, still no deploy window (an older Worker that
omits the key simply writes null, which is one of the column's three documented meanings). The phase
keeps its "purely additive" character; only the "no RPC change" sub-clause was wrong.

**Phase 2 impl-review triaged 2026-08-02** — verdict APPROVED (0 critical, 0 warnings, 1 observation);
F1 fixed, none skipped. The `supadataGet` comment claimed a `206 transcript-unavailable` left through
the `!response.ok` arm; `Response.ok` is true across 200–299, so it actually leaves through the success
path and is classified `unavailable` on the missing string `content`. Behavior was already correct — the
comment's stated reason was not, and it hid the load-bearing dependency on `isTranscriptOrJobId`
accepting a body with neither `jobId` nor `content`. Comment-only fix; manual criterion 2.6 named as the
regression gate. Manual rows 2.6–2.9 remain deliberately pending.

**Scope extended 2026-08-01 (user) — plan is now 7 phases, not 5.** Phase 1's verification surfaced two
gaps, both now phases of their own, inserted as 2 and 3 with everything downstream shifted by two:

- **D13 — `supadata_calls.http_status`**, transcript calls only, nullable, no backfill. Makes the
  billable 206 an observation instead of an inference from our own `outcome` label — which the
  reconciliation formula depends on being right.
- **D14 — 1 app credit for a refusal in the billable class.** Four of the five 422 exits charge; the
  transient `failed`/`timeout` one is exempt, because `error` + a null header means the cost is
  *unknown* and charging would resolve our ambiguity against the user. The cache-hit case charges even
  though the operator paid nothing — a flat rule beats one that costs differently depending on cache
  state the user cannot see. **Ships silently by the user's explicit call**: copy and 422 body unchanged.

D14 **removes** the original "not changing what a summary costs the user in app credits" boundary. The
replacement is narrower: `summaryCost` for a *delivered* summary is still S-05's, untouched; this slice
prices only the refusal. Phase 3 is placed before the breaker because the charge is per-user and bites
from the first event, while the breaker only engages at plan exhaustion and refuses everyone at once.

**Phase 1 manually verified 2026-08-01 (local)** — rows 1.5–1.8 all pass; record at
`reviews/manual-verification-phase-1.md`. Supadata delta 3 reconciled exactly against the per-outcome
ledger total, independently re-confirming that a `null` `billable_credits` on a 206 means 1 credit.
Phase 1 is complete and stays **undeployed** — **Phase 7** is the single deploy gate (written as
Phase 5 before the same-day scope extension above renumbered the tail). Caught during
pre-flight: a dev server from 2026-07-29 was still holding port 4321 and serving pre-Phase-1 code;
killed before testing. Worth re-checking on every future manual pass.

**Phase 1 impl-review triaged 2026-08-01** — verdict APPROVED (0 critical, 1 warning, 2 observations);
all 3 findings fixed, none skipped. F1 synced the stale roadmap surfaces and Linear MAR-15 (Todo → In
Progress, Phase 1 comment posted, description corrected). F2 reworded the "permanent / retrying will
never help" comments in `transcript.ts` and `generate.ts` — they contradicted D4's 2 h `unavailable`
window; no behavior or user-facing copy change. F3 fixed the "three files" → "four files" typo in the
plan's Implementation Approach. Manual rows 1.5–1.8 remain deliberately pending.

**Plan review triaged 2026-07-31** — all 7 findings fixed in `plan.md`; verdict RETHINK → SOUND. Two
were structural: the per-generation ceiling is **3** credits, not 2 (metadata's retry is separately
billed), and the budget breaker is an **atomic reservation** under the singleton row, not a read
followed by a spend. The breaker grew accordingly — `supadata_reservations`, reserve/settle RPCs, a
settlement obligation on every paid path, and a client 503 change.

**Phase count is now 5.** ~~The breaker was split: Phase 3 is the reservation ledger (migration only,
proved in SQL, called by nothing), Phase 4 wires it into the endpoint, Phase 5 is the deploy + live
pass that used to be Phase 4.~~ **SUPERSEDED 2026-08-01 by the scope extension above — the count is 7
and every number in this paragraph shifted by two: the reservation ledger is Phase 5, the endpoint
wiring Phase 6, the deploy + live pass Phase 7.** The reasoning still holds: the split puts the
atomicity assertion where it is cheap to prove and keeps the phase touching the paid pipeline small
enough to review.

S-09 from roadmap

Source: `context/foundation/roadmap.md` §S-09 — **design is locked, not open**. The `Decisions
(locked 2026-07-31, user)` block there carries the lever choice (**A + C**; B and D rejected) and
twelve numbered decisions D1–D12 covering `mode: "native"`, the 422 copy split, the negative-cache
window cut to 2 h, the minimal budget breaker with its notification seam, and the full
`metadata_cache`. Planning input, not a starting point for re-deciding.

Two caveats recorded there that planning must carry rather than quietly drop:

- **Lever A may save nothing measurable.** S-07 never reached the Whisper path (five submits across
  three videos, no `202`), so `mode: "auto"` may never have cost 2 credits/minute in practice. A buys
  a contractual worst-case bound, not a proven saving.
- **A + C do not remove the fleet ceiling.** The resulting envelope still allows only ~50 cold videos
  per month on the Free (100/mo) plan.

Also open, deliberately: D5b's warning has **no receiver** until a monitoring tool lands, so the warn
threshold is decorative on delivery. The user tracks that separately.
