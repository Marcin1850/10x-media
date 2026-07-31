<!-- PLAN-REVIEW-REPORT -->
# Plan Review: Transcript Cost Guardrail

- **Plan**: `context/changes/transcript-cost-guardrail/plan.md`
- **Mode**: Deep
- **Date**: 2026-07-31
- **Verdict**: RETHINK
- **Findings**: 2 critical, 5 warnings, 0 observations
- **Excluded by user**: deployment-window concerns; historical-data measurement

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| End-State Alignment | FAIL |
| Lean Execution | PASS |
| Architectural Fitness | FAIL |
| Blind Spots | WARNING |
| Plan Completeness | WARNING |

## Grounding

9/9 existing paths ✓, 5/5 symbols ✓, brief↔plan ✓, Progress contract ✓. The five planned-new paths are absent as declared. Runtime blast-radius checks found no additional callers of `fetchTranscript`, `fetchVideoMetadata`, or `persistSummaryAndSettle` outside `src/pages/api/summaries/generate.ts`; the planned persistence and cache service/type surfaces match the current architecture.

## Findings

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
- **Decision**: PENDING

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
- **Decision**: PENDING

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
- **Decision**: PENDING

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
- **Decision**: PENDING

### F5 — Budget refusal consumes a transcript rate-limit attempt

- **Severity**: ⚠️ WARNING
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Phase 3 — First endpoint checkpoint
- **Detail**: The plan places `checkBudget` after `recordTranscriptAttempt`, although that RPC records a paid-fetch attempt. Repeated budget refusals can exhaust the ten-attempt window without any transcript call.
- **Fix**: On a cache miss, check and reserve the provider budget first; record the transcript attempt only immediately before the real fetch.
- **Decision**: PENDING

### F6 — Budget-refusal HTTP behavior is unresolved

- **Severity**: ⚠️ WARNING
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Phase 3 — Endpoint wiring
- **Detail**: "Return a distinct status" leaves the implementer to choose it. The likely `503` currently discards `serverError`, so the promised operator-specific message would not reach the user.
- **Fix**: Specify `503` and change `case 503` to `return serverError ?? "Summary generation isn't configured.";`.
- **Decision**: PENDING

### F7 — Metadata lookup placement and timing contradict each other

- **Severity**: ⚠️ WARNING
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Phase 2 — Endpoint wiring
- **Detail**: The lookup is said to happen around lines 317–322 and ahead of the 402 exit, but the 402 exit is at lines 290–292. The plan also promises that `metadata_ms` measures the early database read while requiring the existing late timing bracket to remain unchanged.
- **Fix**: Place the lookup after the 402 gate, time it there, carry `metadataMs` forward, and overwrite that duration with the late HTTP-fetch duration on a miss.
- **Decision**: PENDING
