<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Persist generation time and provider cost per summary (S-07)

- **Plan**: `context/changes/persist-time-and-cost/plan.md`
- **Scope**: Phases 2–4 of 5
- **Date**: 2026-07-29
- **Verdict**: NEEDS ATTENTION
- **Findings**: 0 critical, 6 warnings, 0 observations
- **Excluded by owner**: deployment-window risk; measurement of data predating this change

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | WARNING |
| Scope Discipline | PASS |
| Safety & Quality | WARNING |
| Architecture | PASS |
| Pattern Consistency | WARNING |
| Success Criteria | PASS |

## Verification

- `npm.cmd run lint` — PASS
- `npm.cmd run build` — PASS
- `npx.cmd supabase migration up` — PASS (`applied: []`; local schema already current)
- `git diff --check 4a1b49c..aacca30` — PASS
- Static phase checks — PASS: no unsafe assertion around `providerMetadata`, no `supadata.transcript(...)` call, and the three-way transcript failure union is present.
- Manual rows 2.4–4.9 are checked in `## Progress`; `change.md` records the local five-generation/DB-inspection verification pass. This review found code and persisted evidence consistent with those results.

## Findings

### F1 — Poll failures create a phantom transcript call

- **Severity**: ⚠️ WARNING
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: `src/lib/services/transcript.ts:187`
- **Detail**: The initial `/transcript` call is recorded at line 190, then `pollTranscriptJob()` runs inside the same outer `try`. A poll exception is recorded once as `transcript_poll/error` at lines 247–254 and rethrown; the outer catch at lines 207–225 then records the same exception again as `transcript/error`, although no second transcript HTTP call occurred. This breaks the one-ledger-row-per-real-call contract and can double-count the failed poll's reported credits.
- **Fix**: Limit the outer catch to the initial `/transcript` request and invoke `pollTranscriptJob()` after that catch boundary, so poll failures are recorded only by the poll layer.
- **Decision**: PENDING

### F2 — Direct transcript requests have no deadline

- **Severity**: ⚠️ WARNING
- **Impact**: 🟡 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: `src/lib/services/transcript.ts:74`
- **Detail**: `supadataGet()` calls `fetch` without an `AbortSignal`. This affects both the initial transcript request and every job poll. The attempt-count bound does not help when one HTTP attempt never resolves; the request can outlive the 600-second generation lease and overlap a successor. The analogous direct boundary in `metadata.ts` uses a 10-second deadline, and the OpenRouter call is also bounded.
- **Fix**: Add an `AbortSignal.timeout(...)` to `supadataGet()` (with separately named initial/poll limits if needed) and let timeout errors flow through the existing metering and structured 502 path.
  - Strength: Bounds the request and lease lifetime using the same pattern already used by the other two external providers.
  - Tradeoff: The timeout must be chosen high enough not to reject legitimately slow Supadata responses.
  - Confidence: HIGH — the unbounded wait is concrete and the repository already uses this mechanism.
  - Blind spot: No production latency distribution is available to tune the exact limit.
- **Decision**: PENDING

### F3 — Billing-header parsing can fabricate or reject measurements

- **Severity**: ⚠️ WARNING
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Adherence
- **Location**: `src/lib/services/supadata-ledger.ts:133`
- **Detail**: `Number.parseInt(raw, 10)` accepts partial values, so `"1oops"` and `"1.5"` both become `1` instead of `null`, contradicting the stated “verbatim integer or null” contract. Negative or out-of-range integers can also reach the RPC's PostgreSQL `integer` cast and cause the single batch insert to lose every call row for that request.
- **Fix**: Accept only a complete non-negative decimal integer string, require a safe integer within PostgreSQL's `integer` range, and return `null` otherwise.
- **Decision**: PENDING

### F4 — Malformed successful JSON can lose the correct ledger row

- **Severity**: ⚠️ WARNING
- **Impact**: 🟡 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: `src/lib/services/transcript.ts:183`
- **Detail**: Successful JSON is cast and used without runtime shape validation. On the initial path, `"jobId" in result` throws for `null` or a primitive after the billable header was read, and the outer catch records `null` instead of that header. On the poll path, `job.status` is dereferenced outside the poll request's catch, so malformed JSON is recorded as the wrong `transcript/error` row (via F1) rather than a `transcript_poll/error`. The transport promises one truthful record for every real call, including malformed vendor responses.
- **Fix**: Narrow the successful response shape before property access and turn schema failures into a billed error that retains the already-read header; with F1 fixed, each caller can then record the failure under the correct operation.
  - Strength: Preserves both call cardinality and the vendor-reported bill at the external boundary.
  - Tradeoff: Adds small runtime validators for transcript/job response unions.
  - Confidence: HIGH — both failure paths follow directly from JavaScript property semantics.
  - Blind spot: The vendor may guarantee these shapes in practice, but the current code explicitly treats external responses as untrusted elsewhere.
- **Decision**: PENDING

### F5 — `transcript_ms` includes the cache-write RPC

- **Severity**: ⚠️ WARNING
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Adherence
- **Location**: `src/pages/api/summaries/generate.ts:374`
- **Detail**: `fetchMs` is frozen after transcript acquisition and passed to `saveCachedTranscript`, but the persisted `transcriptMs` is not frozen until line 405, after the cache-write RPC awaited at lines 377–397. The plan says `transcript_ms` brackets the transcript source and that the same measured value is passed as `fetchDurationMs`; the implementation instead includes database-write latency and stores a different value.
- **Fix**: Freeze `transcriptMs` immediately after acquisition, pass that same value as `fetchDurationMs`, and perform the cache write outside the transcript timer.
- **Decision**: PENDING

### F6 — Over-limit transcripts are cached without the promised size bound

- **Severity**: ⚠️ WARNING
- **Impact**: 🔴 HIGH — architectural stakes; think carefully before deciding
- **Dimension**: Safety & Quality
- **Location**: `src/pages/api/summaries/generate.ts:388`
- **Detail**: Every successful transcript body is stored before the 200,000-character hard-cap check at lines 421–427. The plan's performance contract says cache rows are “up to 200k chars”, but the table can retain arbitrarily larger bodies that the application will never summarize. Positive-balance users can repeatedly add these rows within the transcript rate limit, and later cache hits pull the unusable body from Postgres only to return 413.
- **Fix A ⭐ Recommended**: Add a `too_long` cache outcome (with no transcript body and, optionally, the observed character count), reuse it on the same 30-day window, and map hits directly to 413.
  - Strength: Preserves the paid-fetch deduplication goal while bounding storage and read amplification.
  - Tradeoff: Requires a schema/RPC/type change spanning the phase boundary and a decision about the diagnostic length field.
  - Confidence: HIGH — it represents the existing 413 result without retaining content the app cannot use.
  - Blind spot: The desired TTL for an edited/replaced caption track has not been explicitly validated.
- **Fix B**: Skip cache writes when `content.length` exceeds the hard cap.
  - Strength: Very small endpoint-only change that immediately enforces the storage bound.
  - Tradeoff: Repeated requests for the same over-limit video pay Supadata again, weakening the slice's deduplication promise.
  - Confidence: HIGH — the guard is local and mechanically simple.
  - Blind spot: Repeat spend frequency for over-limit videos is unknown.
- **Decision**: PENDING
