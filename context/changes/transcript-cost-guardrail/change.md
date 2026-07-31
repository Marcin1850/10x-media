---
change_id: transcript-cost-guardrail
title: Transcript cost guardrail
status: plan_reviewed
created: 2026-07-31
updated: 2026-07-31
archived_at: null
---

## Notes

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
