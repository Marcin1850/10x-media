---
change_id: testing-phase-2-paid-path
title: Paid-path integration tests — charge-versus-delivery and spend reconciliation
status: implementing
created: 2026-09-04
updated: 2026-09-04
archived_at: null
---

## Notes

Paid-path integration tests (test-plan §3 Phase 2, Linear MAR-20): prove the charge-versus-delivery contract on every terminating exit of the generation endpoint, and that locally-derived spend reconciles against the vendor's own counter. Covers risks #1, #2, #3, #5. Integration layer, paid vendor HTTP boundary faked, everything below it real.

### Handed over by Phase 1 (test-plan §6.6)

- `refuseAndCharge` / `refusalResponse` were never extracted from the endpoint, so the `REFUSAL_COPY` lookup and the `ambiguousCharge: true` body shape are uncovered. The request-boundary tests reach both **without any refactor** — that is why the extraction was skipped.
- `readBillableCredits` was blocked on a doc-vs-code conflict. **Unblocked 2026-09-04** (`5c20bbe`): `supadata-billable-requests.md` §Parsing contract now states the strict `/^\d+$/` + int4-range rule and why prefix-parsing would fabricate a measurement, so the oracle is a source rather than a mirror. The same commit fixed the function's JSDoc, which still called the header's unit open after the doc had settled it as credits on 2026-07-29.
- A module importing `astro:env/server` is unreachable from a unit test — but this phase exercises the endpoint itself, so it needs a different answer than Phase 1's extract-to-`src/lib/` move.

### Open constraint research must settle (test-plan §3)

Integration tests need clean state between runs, and per-user cleanup does not reach all of it:

- transcript and metadata caches are **user-agnostic** (keyed by video id, no owner column);
- vendor budget state is a **singleton row shared with the local dev environment**, so forcing the breaker into stop / stale-read / unreadable-counter states has no user to scope cleanup to;
- test-plan §7's cleanup exception explicitly does **not** cover that singleton row.

Either that state becomes injectable, or this group of tests needs its own database. `/10x-research` decides; the plan must not pre-empt it.

### Oracle sources (never the implementation)

README §Summary credits, PRD FR-003 + Open Question 3, roadmap S-01 / S-07 / S-09 decisions (D5, D13, D14), and `supadata-billable-requests.md`. Risk #2's independent oracle is the vendor's own free `GET /v1/me` counter — do not re-implement the vendor's pricing table in a test.

### Watch-out

Two stale-doc conflicts turned up in `supadata-ledger.ts` from the same 2026-07-28 → 07-29 window, only one of which Phase 1 had flagged. Research should sweep the rest of that module's comments before any assertion is written against them.
