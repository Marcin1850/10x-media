---
change_id: transcript-cost-guardrail
title: Transcript cost guardrail
status: plan_reviewed
created: 2026-07-31
updated: 2026-08-02
archived_at: null
---

## Notes

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
Phase 1 is complete and stays **undeployed** — Phase 5 is the single deploy gate. Caught during
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

**Phase count is now 5.** The breaker was split: Phase 3 is the reservation ledger (migration only,
proved in SQL, called by nothing), Phase 4 wires it into the endpoint, Phase 5 is the deploy + live
pass that used to be Phase 4. The split puts the atomicity assertion where it is cheap to prove and
keeps the phase touching the paid pipeline small enough to review.

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
