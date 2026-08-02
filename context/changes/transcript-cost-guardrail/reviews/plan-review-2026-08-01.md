<!-- PLAN-REVIEW-REPORT -->
# Plan Review: Transcript Cost Guardrail

- **Plan**: `context/changes/transcript-cost-guardrail/plan.md`
- **Mode**: Deep
- **Date**: 2026-08-01
- **Verdict**: RETHINK → **SOUND after triage** (all 9 findings fixed in the plan, 2026-08-02)
- **Findings**: 2 critical, 6 warnings, 1 observation
- **Excluded by user**: deployment-window concerns; measurement or reconstruction of historical data
- **Prior review**: `reviews/plan-review.md` remains unchanged; this report reviews the seven-phase plan after the 2026-08-01 D13/D14 scope extension

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| End-State Alignment | FAIL → PASS |
| Lean Execution | PASS |
| Architectural Fitness | FAIL → PASS |
| Blind Spots | WARNING → PASS |
| Plan Completeness | FAIL → PASS |

*Verdicts as found, then after triage. All nine findings were fixed in `plan.md` on 2026-08-02; none
were skipped, accepted or dismissed.*

The cache, persistence, and provider-service patterns fit the repository, and the additional phases are
not gratuitous. The blocker is the budget state machine: its first-reading path is absent, and its
refresh path can delete the reservation protecting the call that has not happened yet. Phase 6 also
leaves several data contracts for the implementer to invent. Those are pre-code contract problems, not
deployment-window or historical-measurement concerns.

## Grounding

11/11 existing paths ✓, 10/10 key symbols ✓, brief↔plan phase/decision/scope structure ✓, Progress
contract ✓ (one bottom block, 7/7 phase headings matched, every phase success bullet represented; one
additional explicit override-reversion gate). Planned-new migrations/services and the Phase 7 review
file are absent as declared. No additional runtime callers were found for `beginGeneration`,
`respondToRepeatedRequest`, `fetchTranscript`, `fetchVideoMetadata`, or
`persistSummaryAndSettle`. The proposed metadata-cache service follows the existing
`transcript-cache.ts` pattern; no pattern-proliferation finding.

## Findings

### F1 — Refresh deletes the reservation protecting the next paid call

- **Severity**: ⛔ CRITICAL
- **Impact**: 🔴 HIGH — architectural stakes; think carefully before deciding
- **Dimension**: Architectural Fitness
- **Location**: Phase 5 — `save_supadata_budget`; Phase 6 — `reserveBudget`
- **Detail**: The planned order is reserve → optionally refresh `/v1/me` → save the fresh reading → wait → return so the paid call can start (`plan.md:759-789`, `:865-880`). The save RPC then deletes reservations created before its new `read_at`. The refresh-claiming request's reservation was necessarily created before that save and has not been spent yet, so it is deleted before the provider call. Other in-flight reservations can be deleted for the same reason even though the vendor snapshot cannot include work that has not happened. The later settle targets a missing row, the refreshed decision is never re-evaluated, and concurrent callers can reuse credit that was supposedly reserved. This breaks the fleet-bound property the reservation table exists to provide.
- **Fix A ⭐ Recommended**: Make refresh a distinct pre-reservation state and define an explicit snapshot boundary.
  - Strength: A stale caller claims refresh without inserting the paid-call reservation, saves the reading, then reruns the atomic reserve decision; adding settlement timing lets the save retain all unsettled/overlapping work and discard only reservations certainly represented by the snapshot.
  - Tradeoff: Requires a small state machine (`refresh_required` → refresh/save → reserve) plus a lifecycle timestamp such as `settled_at` or an equivalent accounted-through marker.
  - Confidence: HIGH — the deletion follows directly from the order specified in the plan.
  - Blind spot: Supadata's exact consistency point for `usedCredits` is undocumented, so the safe boundary must be pessimistic.
- **Fix B**: Keep reserve-before-refresh, but preserve the claimant and every unsettled/overlapping reservation, return a refreshed decision, and require the caller to re-evaluate before spending.
  - Strength: Retains the current call order and refresh claim shape.
  - Tradeoff: More complicated accounting; excluding only the current id is insufficient because other calls can overlap the snapshot.
  - Confidence: MEDIUM — correct only if the plan pins a conservative rule for which settled calls the vendor reading contains.
  - Blind spot: Eventual consistency in `/v1/me` can still force temporary over-counting.
- **Decision**: FIXED via Fix A — Phase 5 splits `refresh_required` into a pre-reservation state, adds
  `settled_at`, and prunes on a caller-supplied pre-call timestamp; Phase 6's `reserveBudget` becomes a
  bounded two-pass call that re-decides against the fresh reading.

### F2 — The singleton budget has no first-reading path

- **Severity**: ⛔ CRITICAL
- **Impact**: 🟠 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: End-State Alignment
- **Location**: Phase 5 — `supadata_budget` / `reserve_supadata_credits`; Phase 6 — `reserveBudget`
- **Detail**: The migration defines a singleton table but does not seed it or specify a no-row branch (`plan.md:746-779`). The concurrency test starts only "with the budget seeded" (`:804-807`). The service refreshes only when the RPC returns `should_refresh` (`:865-868`), but `select ... where singleton for update` has no row to lock on a fresh deployment. Implemented literally, the empty state can fall into fail-open indefinitely and never acquire its first authoritative reading, so the breaker never becomes active.
- **Fix**: Specify an atomic uninitialized outcome: create/lock a nullable sentinel row (or return `refresh_required` from a no-row-safe RPC), fetch and save `/v1/me`, then rerun the reserve decision; if refresh fails, return the explicit untracked fail-open outcome from F4. Add a clean-database assertion proving the first successful request initializes the row and is then evaluated against it.
- **Decision**: FIXED — the migration now seeds one all-null row with nullable `max_credits` /
  `used_credits` / `read_at`; `read_at is null` is the explicit uninitialized state, the RPC returns
  `refresh_required` (or `uninitialized`) for it, and Progress 5.8/5.9 assert both.

### F3 — Settlement has no billing observation channel

- **Severity**: ⚠️ WARNING
- **Impact**: 🔴 HIGH — architectural stakes; think carefully before deciding
- **Dimension**: Plan Completeness
- **Location**: Phase 6 — budget service and both endpoint checkpoints
- **Detail**: The plan requires `settleBudget` to receive the actual credits for exactly one guarded operation, including two metadata attempts and `null` when any billed figure is unknown (`plan.md:887-898`, `:955-965`). Current provider results do not carry billing: `fetchTranscript` returns only `TranscriptResult` (`src/lib/services/transcript.ts:279-339`) and `fetchVideoMetadata` returns only `VideoMetadata | null` (`src/lib/services/metadata.ts:164-195`). Per-attempt figures exist only as pushes into `SupadataMeter`, whose public operations are `record`, `attachSummary`, and whole-request `drain` (`src/lib/services/supadata-ledger.ts:41-76`). The implementer must invent how to isolate a call's rows, sum a retry, and preserve unknown semantics.
- **Fix A ⭐ Recommended**: Add a scoped meter checkpoint/reducer and list `src/lib/services/supadata-ledger.ts` in Phase 6.
  - Strength: Billing stays in the component that already records every attempt; snapshot before the guarded operation and reduce only rows since that point, returning `null` if any attempt is unreported and otherwise the sum.
  - Tradeoff: Expands the meter API and requires tests for mixed known/unknown retry rows.
  - Confidence: HIGH — all required observations already reach the meter.
  - Blind spot: The reducer must reject operation mismatches so unrelated rows cannot settle the wrong reservation.
- **Fix B**: Widen both provider return contracts to include a billing envelope.
  - Strength: Makes the settlement value explicit at the provider boundary.
  - Tradeoff: Touches both provider result types and their error/totality paths, and duplicates aggregation concerns now centralized in the meter.
  - Confidence: HIGH — both provider functions have one runtime caller.
  - Blind spot: A thrown transcript call still needs a billed error envelope rather than a bare rejection.
- **Decision**: FIXED via Fix A — Phase 6 gains a "Scoped billing observation" section adding
  `checkpoint()` / `billedSince(mark, operation)` to `SupadataMeter`, with unknown-is-contagious null
  semantics and operation filtering; `supadata-ledger.ts` is now a listed Phase 6 file and 6.5 asserts
  the reducer.

### F4 — The budget decision type cannot represent fail-open or reporting data

- **Severity**: ⚠️ WARNING
- **Impact**: 🟠 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Plan Completeness
- **Location**: Phase 5 RPC return; Phase 6 `reserveBudget` / `reportBudgetThreshold`
- **Detail**: `reserveBudget` is described as returning a reservation id or refusal, yet an RPC/read failure must proceed without a reservation (`plan.md:865-868`, `:916-924`). That third state is not representable, so endpoint wiring cannot know to call the provider but skip settlement. The RPC contract also returns only the decision plus `should_refresh`, while threshold reporting requires used, max, outstanding delta, threshold, and reading age (`:927-933`). Stop events on non-refreshing callers therefore lack their promised payload unless the implementer invents more reads or return fields.
- **Fix**: Define and test a discriminated result such as `reserved`, `refused`, `refreshRequired`, and `proceedUntracked`; make settlement conditional on a reservation id. Pin the RPC/service statistics returned with decisions so `reportBudgetThreshold` can build its documented payload without another race-prone read.
- **Decision**: FIXED — Phase 5's RPC now returns statistics under the same lock as every decision;
  Phase 6 specifies a three-case service union (`reserved` / `refused` / `untracked`) with settlement
  conditional on `reserved`, and 6.6/6.7 assert both.

### F5 — A retry of a charged refusal changes from 422 to 409

- **Severity**: ⚠️ WARNING
- **Impact**: 🟠 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Blind Spots
- **Location**: Phase 3 — request-id idempotency and manual verification
- **Detail**: Reusing `requestId` does prevent a second debit, but a sequential retry never reaches the planned `refuseAndCharge` helper. The endpoint probes `beginGeneration(... amount: null)` before transcript/cache handling (`src/pages/api/summaries/generate.ts:276-295`). A settled reservation without a summary becomes `unavailable` in `begin_generation` (`supabase/migrations/20260723130000_idempotent_generation.sql:139-152`) and `respondToRepeatedRequest` immediately returns 409 with "Start a new generation" (`generate.ts:199-202`). The plan checks only that balance does not move (`plan.md:571`), so all criteria can pass while an ambiguous retry loses the caption-specific 422 contract.
- **Fix A ⭐ Recommended**: Persist a refusal classification on the charged reservation and teach the probe to replay the original 422 for that classification.
  - Strength: Preserves true request-idempotent HTTP behavior and the promised caption-specific message.
  - Tradeoff: Adds one small ledger field and widens the existing replay union.
  - Confidence: HIGH — the current 409 path is explicit and runs before every planned refusal site.
  - Blind spot: Existing operator-settled, summary-less rows must remain generic `unavailable`, not be misclassified.
- **Fix B**: Explicitly accept 409 for same-id retries and add it to the Phase 3 contract and manual criteria.
  - Strength: No additional code or schema scope.
  - Tradeoff: A transport retry does not reproduce the first response and no longer tells the user why the video was refused.
  - Confidence: HIGH.
  - Blind spot: Client retry behavior after an ambiguous 422 has not been observed.
- **Decision**: FIXED via Fix A — Phase 3 adds `credit_reservations.refusal_reason` and a read-only
  `get_refusal_replay`; the probe's `'unavailable'` branch replays the original 422 when a reason is
  stored and keeps 409 when it is not (preserving the operator-settle case). `begin_generation` is
  deliberately untouched so the migration stays additive. Criteria 3.5, 3.11 and 3.12 assert it.

### F6 — Phase 2 cannot read `response.status` where the plan says it can

- **Severity**: ⚠️ WARNING
- **Impact**: 🟠 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Plan Completeness
- **Location**: Phase 2 — plumb status through the meter
- **Detail**: The plan says `fetchTranscript` passes `response.status` on every recording arm (`plan.md:423-429`). In current code the transport helper returns only `{ body, billableCredits }` (`src/lib/services/transcript.ts:158-224`), and its `BilledSupadataError` carries only `billableCredits` (`:226-248`). `fetchTranscript` has no `Response` on either success or error arms. The phase is implementable, but not by the stated contract; successful and thrown paths need different explicit plumbing.
- **Fix**: Extend `supadataGet` to return `httpStatus` and `BilledSupadataError` to retain it; add an `httpStatusFromError` helper parallel to `billedFromError`, then specify each transcript and poll recording arm. Keep metadata untouched as planned.
- **Decision**: FIXED — Phase 2 now specifies both paths: `supadata_get` returns `httpStatus`,
  `BilledSupadataError` retains it across its four throw sites, and `httpStatusFromError` mirrors
  `billedFromError`. The migration's column comment gained the third null meaning (no response at all),
  and 2.9 asserts the failure arm.

### F7 — Phase 6 depends on a private constant and leaves two values unresolved

- **Severity**: ⚠️ WARNING
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Phase 6 — budget service constants
- **Detail**: The plan requires importing `RETRY_DELAY_MS` from `metadata.ts` (`plan.md:873-878`), but it is currently a private module constant (`src/lib/services/metadata.ts:5-6`) and `metadata.ts` is not listed among Phase 6's files. The same section says to reuse 600 seconds "unless" the transcript ceiling argues otherwise and to "pick" a shorter `/v1/me` deadline (`plan.md:858-863`, `:906-909`), leaving two implementation-time choices in a supposedly locked plan.
- **Fix**: Add `src/lib/services/metadata.ts` to Phase 6 and export or relocate the shared delay; pin `RESERVATION_STALE_SECONDS` and the `/v1/me` timeout numerically with their derivations before implementation.
- **Decision**: FIXED — `metadata.ts` is now a listed Phase 6 file for a one-word `export`;
  `RESERVATION_STALE_SECONDS = 600` is pinned against a ceiling table (transcript 90 s, poll ~240 s,
  metadata ~21 s) and `BUDGET_READ_TIMEOUT_MS = 2_000` against metadata's 10 s.

### F8 — Phase 3 verification names a column that does not exist

- **Severity**: ⚠️ WARNING
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Phase 3 — Manual Verification; Progress 3.8
- **Detail**: The criterion asks for a `credit_reservations` row "with no `summary_id`" (`plan.md:567-568`, `:1229`). `credit_reservations` has no `summary_id` (`supabase/migrations/20260720160000_credit_reservations.sql:22-29`); the relationship points the other way through `summaries.reservation_id` (`20260722120000_link_summary_to_reservation.sql:25-35`). The intended assertion is valid, but the written query target is not.
- **Fix**: Rewrite the criterion as a settled reservation for the request id with no matching `summaries` row (`not exists` or a left join), and keep the Progress title synchronized.
- **Decision**: FIXED — the Phase 3 criterion and Progress 3.9 now assert a settled reservation for the
  request id with no matching `summaries` row, naming the FK direction. The Phase 7 first-day check and
  live-pass assertion were switched to the new `refusal_reason` column.

### F9 — “Current State” describes the pre-Phase-1 tree

- **Severity**: ℹ️ OBSERVATION
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Current State Analysis; `plan-brief.md` — Starting Point
- **Detail**: The plan says every Current State fact was verified against the working tree and that `fetchTranscript` still sends `mode=auto` (`plan.md:28-36`), while Phase 1 is marked done and the working tree now declares `TRANSCRIPT_MODE = "native"` (`src/lib/services/transcript.ts:72-99`). The brief repeats the old value under Starting Point. This does not invalidate later phases, but it makes the baseline/current distinction unreliable.
- **Fix**: Relabel those passages as the pre-Phase-1 baseline and add one short current-working-tree note stating that Phase 1 is complete locally but not yet deployed.
- **Decision**: FIXED — Current State Analysis is now explicitly labelled the pre-Phase-1 baseline with
  a note that nothing is deployed, and `plan-brief.md`'s Starting Point carries the same italic caveat.

## Recommended resolution order

1. Fix F1 and F2 together as one explicit initialization/refresh/reserve state machine.
2. Lock the Phase 6 service contracts in F3 and F4 before writing its migration or endpoint wiring.
3. Decide the refusal replay behavior in F5 before implementing the Phase 3 RPC schema.
4. Apply the narrow completeness fixes F6-F9.

