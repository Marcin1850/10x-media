---
change_id: transcript-cost-guardrail
title: Transcript cost guardrail
status: implementing
created: 2026-07-31
updated: 2026-08-01
archived_at: null
---

## Notes

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
