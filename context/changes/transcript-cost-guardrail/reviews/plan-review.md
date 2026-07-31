<!-- PLAN-REVIEW-REPORT -->
# Plan Review: Transcript Cost Guardrail

- **Plan**: `context/changes/transcript-cost-guardrail/plan.md`
- **Mode**: Deep
- **Date**: 2026-07-31
- **Verdict**: RETHINK → **SOUND after triage** (all 7 findings fixed in the plan, 2026-07-31)
- **Findings**: 2 critical, 5 warnings, 0 observations — 7 fixed, 0 skipped, 0 accepted, 0 dismissed
- **Excluded by user**: deployment-window concerns; historical-data measurement

## Verdicts

| Dimension | Before triage | After fixes |
|-----------|---------------|-------------|
| End-State Alignment | FAIL | PASS |
| Lean Execution | PASS | PASS |
| Architectural Fitness | FAIL | PASS |
| Blind Spots | WARNING | PASS |
| Plan Completeness | WARNING | PASS |

The two FAILs were structural, not cosmetic, and both fixes changed the plan's shape rather than its
wording: the cost ceiling is now 3 (F1, metadata's billable retry), and the breaker is now an atomic
reservation rather than read-then-spend (F2). Phase 3 is materially larger than it was — a second table,
two more RPCs, a settlement obligation on every paid path, and a fourth file. Re-estimate before starting.

## Grounding

9/9 existing paths ✓, 5/5 symbols ✓, brief↔plan ✓, Progress contract ✓. The five planned-new paths are absent as declared. Runtime blast-radius checks found no additional callers of `fetchTranscript`, `fetchVideoMetadata`, or `persistSummaryAndSettle` outside `src/pages/api/summaries/generate.ts`; the planned persistence and cache service/type surfaces match the current architecture.

## Findings

> **Phase numbering**: the `Location` fields below refer to the plan **as reviewed** (four phases). After
> triage the breaker was split in two, so the plan now has five: what these findings call "Phase 3" is
> now Phase 3 (the reservation ledger) plus Phase 4 (wiring the breaker), and the old Phase 4 (deploy +
> live verification) is Phase 5. Locations are left unrewritten so the record matches what was reviewed.

### F1 — Metadata retry breaks the 2-credit ceiling

- **Severity**: ⛔ CRITICAL
- **Impact**: 🔴 HIGH — architectural stakes; think carefully before deciding
- **Dimension**: End-State Alignment
- **Location**: Desired End State; Phases 2–3
- **Detail**: The plan promises at most two credits and sets `BUDGET_STOP_RESERVE = 2`. However, `fetchVideoMetadata` can make two HTTP requests (`src/lib/services/metadata.ts:169-178`), and its documentation explicitly describes the retry as a second billable request (`:43-46`). One breaker call before this helper does not gate the retry. A generation can therefore cost three credits: transcript 1 plus two metadata attempts.
- **Fix A ⭐ Recommended**: Remove the automatic paid metadata retry for this guarded path.
  - Strength: Preserves the locked two-credit contract and makes reserve 2 correct.
  - Tradeoff: A transient metadata failure leaves decorative fields null until another generation.
  - Confidence: HIGH — the second request is explicit in the current implementation.
  - Blind spot: None significant.
- **Fix B**: Accept a three-credit ceiling and change the reserve, end state, tests, and verification budget to 3.
  - Strength: Preserves metadata retry reliability.
  - Tradeoff: Reopens the locked cost guarantee and reduces monthly capacity.
  - Confidence: HIGH.
  - Blind spot: Future retries would require changing the ceiling again.
- **Decision**: FIXED via Fix B — ceiling raised to 3 in Desired End State (new row + derivation
  paragraph), `BUDGET_STOP_RESERVE = 3` with the "metadata counts twice" reasoning attached, Phase 4
  verification budget ~4 / ≤6, criterion 4.4 and `plan-brief.md` updated to match.

### F2 — The proposed breaker cannot provide a fleet-wide bound

- **Severity**: ⛔ CRITICAL
- **Impact**: 🔴 HIGH — architectural stakes; think carefully before deciding
- **Dimension**: Architectural Fitness
- **Location**: Phase 3 — Budget service and RPCs
- **Detail**: The breaker is a read/evaluate/spend sequence without an atomic reservation. The existing generation lease is per-user (`src/pages/api/summaries/generate.ts:77-85`), while ledger rows remain in memory until the request finishes and flushes them in `POST.finally` (`:100-125`). Concurrent users can all see the same remaining balance and spend before any call becomes visible. The proposed delta is not exact either: `error` plus `billable_credits = null` means unknown rather than zero; `created_at` records batch-insertion time instead of HTTP-call time, creating `/v1/me` snapshot races; and concurrent stale readers can each refresh and emit the warning.
- **Fix A ⭐ Recommended**: Introduce an atomic provider-credit reservation under the singleton budget row.
  - Strength: A row lock can reserve the maximum before each real HTTP attempt, reconcile known results, keep unknown failures pessimistically charged, and deduplicate refresh/warning decisions. This matches the existing atomic app-credit pattern.
  - Tradeoff: Requires reservation expiry and reconciliation for Worker termination.
  - Confidence: HIGH — the current delayed ledger flush and per-user lease make the race unavoidable.
  - Blind spot: Reservation timeout policy needs deciding.
- **Fix B**: Explicitly redefine C as an advisory breaker with a concurrency safety margin.
  - Strength: Considerably smaller implementation.
  - Tradeoff: It no longer bounds the fleet; overrun remains possible.
  - Confidence: HIGH.
  - Blind spot: A safe margin depends on peak concurrency.
- **Decision**: FIXED via Fix A — Phase 3 rebuilt around an atomic reservation. New
  `supadata_reservations` table; `reserve_supadata_credits` sweeps, locks the singleton `for update`,
  counts outstanding at `coalesce(actual_credits, credits)` (unknown stays pessimistically charged),
  and hands the refresh claim to exactly one caller (warn dedupe). `settle_*` never deletes; refresh
  deletes superseded rows. The breaker no longer does live arithmetic over `supadata_calls` — that
  total is re-scoped to Phase 4 reconciliation. Transcript reserves 1, metadata reserves 2 (F1's
  retry). Settlement is a `finally` obligation. Concurrent-reserve assertion added to Phase 3.

### F3 — Inline `/v1/me` refresh violates the documented rate limit

- **Severity**: ⚠️ WARNING
- **Impact**: 🟠 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Architectural Fitness
- **Location**: Phase 3 — `checkBudget`
- **Detail**: The plan states that `/v1/me` immediately before a transcript call breaks the one-request-per-second Supadata limit, but then specifies that sequence whenever the reading is stale. No spacing mechanism follows the refresh.
- **Fix**: Make the provider-call reservation return a fleet-wide `notBefore` time, or otherwise enforce spacing after `/v1/me` before permitting the paid request.
  - Strength: Removes deterministic `limit-exceeded` failures on refresh requests.
  - Tradeoff: Adds roughly 1.2 seconds to the request that performs a refresh.
  - Confidence: HIGH — the contradiction appears inside the plan itself.
  - Blind spot: Confirm whether `/v1/me` shares the same rate bucket; the plan currently assumes it does.
- **Decision**: FIXED — the refresh-claiming caller waits `RETRY_DELAY_MS` (reused from `metadata.ts:6`)
  after `/v1/me` before the reserve decision returns; ~one request per 15 min pays it. The shared-bucket
  assumption is now stated as unverified with a note on how to delete the wait if Phase 4 disproves it.

### F4 — `checkBudget` is not explicitly total or time-bounded

- **Severity**: ⚠️ WARNING
- **Impact**: 🟠 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Blind Spots
- **Location**: Phase 3 — Budget service
- **Detail**: The second check occurs after user debit and the paid LLM call. The plan promises fail-open behavior but does not require a timeout, runtime validation, or a never-throw boundary. A hanging `/v1/me` request could strand the reservation, the same failure mode the metadata service carefully prevents.
- **Fix**: Specify `checkBudget(): Promise<BudgetDecision>` as never-throwing, use `AbortSignal.timeout`, validate the response shape, and report then fail open on every transport, status, or schema failure.
  - Strength: Preserves existing refund and total-service invariants.
  - Tradeoff: Requires choosing a bounded timeout.
  - Confidence: HIGH — existing provider services already establish this pattern.
  - Blind spot: Exact timeout remains a tuning choice.
- **Decision**: FIXED — the budget service is now specified as total by contract, with `AbortSignal.timeout`
  (shorter than metadata's 10 s, since the call is advisory), boundary narrowing of the response instead
  of faith-destructuring, and report-then-proceed on every transport/status/schema failure. Settle
  failures are reported, never thrown; the sweep is named as the backstop. Criterion 3.17 added.

### F5 — Budget refusal consumes a transcript rate-limit attempt

- **Severity**: ⚠️ WARNING
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Phase 3 — First endpoint checkpoint
- **Detail**: The plan places `checkBudget` after `recordTranscriptAttempt`, although that RPC records a paid-fetch attempt. Repeated budget refusals can exhaust the ten-attempt window without any transcript call.
- **Fix**: On a cache miss, check and reserve the provider budget first; record the transcript attempt only immediately before the real fetch.
- **Decision**: FIXED — Phase 3's first checkpoint now sits explicitly *before* `recordTranscriptAttempt`,
  with the reasoning attached. Criterion 3.10 added.

### F6 — Budget-refusal HTTP behavior is unresolved

- **Severity**: ⚠️ WARNING
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Phase 3 — Endpoint wiring
- **Detail**: "Return a distinct status" leaves the implementer to choose it. The likely `503` currently discards `serverError`, so the promised operator-specific message would not reach the user.
- **Fix**: Specify `503` and change `case 503` to `return serverError ?? "Summary generation isn't configured.";`.
- **Decision**: FIXED — 503 pinned, and Phase 3 gained a fourth file (`GenerateSummaryForm.tsx`) making
  `case 503` prefer `serverError`, with a comment naming the two causes that now answer 503. Criterion
  3.9 extended to check the breaker's copy reaches the UI.

### F7 — Metadata lookup placement and timing contradict each other

- **Severity**: ⚠️ WARNING
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Phase 2 — Endpoint wiring
- **Detail**: The lookup is said to happen around lines 317–322 and ahead of the 402 exit, but the 402 exit is at lines 290–292. The plan also promises that `metadata_ms` measures the early database read while requiring the existing late timing bracket to remain unchanged.
- **Fix**: Place the lookup after the 402 gate, time it there, carry `metadataMs` forward, and overwrite that duration with the late HTTP-fetch duration on a miss.
- **Decision**: FIXED — Phase 2 now states the lookup lands after the 402 gate (`:290-292`) and before
  the 413/409 exits, corrects the impossible "ahead of all three gates" placement, and specifies the
  `metadataMs` carry-forward/overwrite so the existing late bracket stays untouched.
