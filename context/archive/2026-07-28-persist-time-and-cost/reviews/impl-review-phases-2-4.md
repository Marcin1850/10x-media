<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Persist generation time and provider cost per summary (S-07)

- **Plan**: `context/changes/persist-time-and-cost/plan.md`
- **Scope**: Phases 2–4 of 5
- **Date**: 2026-07-29
- **Verdict**: NEEDS ATTENTION → **all 6 findings fixed in triage, 2026-07-29**
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
### Post-triage re-verification, 2026-07-29

- `npm run lint` — PASS
- `npm run build` — PASS
- `npx supabase migration up` — PASS (`20260729120000_transcript_cache_too_long.sql` applied to the local stack)
- Vendor docs re-fetched via Context7 and repo docs updated: `persist-video-metadata/docs/supadata-transcript.md` gains a §Latency (60s sync ceiling, >20min → async job, timed-out requests still billed), `supadata-billable-requests.md` records why the job path was never observed locally, `supadata-account-limits.md` notes the tier table reproduced identically.
- Not re-run: the five-generation local pass. The `too_long` and shape-guard paths have no local reproduction (no >200k-char or malformed-response video on hand), so they are code-verified only.

### Original verification

- Manual rows 2.4–4.9 are checked in `## Progress`; `change.md` records the local five-generation/DB-inspection verification pass. This review found code and persisted evidence consistent with those results.

## Findings

### F1 — Poll failures create a phantom transcript call

- **Severity**: ⚠️ WARNING
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: `src/lib/services/transcript.ts:187`
- **Detail**: The initial `/transcript` call is recorded at line 190, then `pollTranscriptJob()` runs inside the same outer `try`. A poll exception is recorded once as `transcript_poll/error` at lines 247–254 and rethrown; the outer catch at lines 207–225 then records the same exception again as `transcript/error`, although no second transcript HTTP call occurred. This breaks the one-ledger-row-per-real-call contract and can double-count the failed poll's reported credits.
- **Fix**: Limit the outer catch to the initial `/transcript` request and invoke `pollTranscriptJob()` after that catch boundary, so poll failures are recorded only by the poll layer.
- **Decision**: FIXED — `fetchTranscript`'s try now wraps only the initial `/transcript` request; job polling runs after the catch boundary.

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
- **Decision**: FIXED — `supadataGet` now takes a `timeoutMs` and passes `AbortSignal.timeout(...)`. Limits verified against the vendor docs before applying: Supadata documents the synchronous path as taking **up to 60 seconds** for AI-generated transcripts and warns that timed-out requests still consume credits, so the initially proposed 60s sat exactly on the documented ceiling. Applied `TRANSCRIPT_TIMEOUT_MS = 90_000` (50% headroom, just under the ~100s Cloudflare origin timeout behind the observed `524`) and `JOB_POLL_TIMEOUT_MS = 10_000` (matches `metadata.ts`).

### F3 — Billing-header parsing can fabricate or reject measurements

- **Severity**: ⚠️ WARNING
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Adherence
- **Location**: `src/lib/services/supadata-ledger.ts:133`
- **Detail**: `Number.parseInt(raw, 10)` accepts partial values, so `"1oops"` and `"1.5"` both become `1` instead of `null`, contradicting the stated “verbatim integer or null” contract. Negative or out-of-range integers can also reach the RPC's PostgreSQL `integer` cast and cause the single batch insert to lose every call row for that request.
- **Fix**: Accept only a complete non-negative decimal integer string, require a safe integer within PostgreSQL's `integer` range, and return `null` otherwise.
- **Decision**: FIXED — `readBillableCredits` now requires `/^\d+$/` on the trimmed header and a safe integer `<= 2_147_483_647`; anything else returns `null`. The `int4` bound is load-bearing because the flush is a single batch insert — one bad header would otherwise discard every row for that request.

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
- **Decision**: FIXED — `supadataGet` is now generic over an `isValid` type guard that runs on the parsed 2xx body inside the transport boundary, so a malformed success throws a `BilledSupadataError` that still carries `x-billable-requests`. Added `isTranscriptOrJobId` (rejects non-objects; requires a string `jobId` when present) and `isJobResult` (requires a string `status`). Both are deliberately permissive about a non-string `content` and an odd `lang`, which the callers already handle as `unavailable` / still-usable rather than as schema failures. The casts at both call sites are gone.

### F5 — `transcript_ms` includes the cache-write RPC

- **Severity**: ⚠️ WARNING
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Adherence
- **Location**: `src/pages/api/summaries/generate.ts:374`
- **Detail**: `fetchMs` is frozen after transcript acquisition and passed to `saveCachedTranscript`, but the persisted `transcriptMs` is not frozen until line 405, after the cache-write RPC awaited at lines 377–397. The plan says `transcript_ms` brackets the transcript source and that the same measured value is passed as `fetchDurationMs`; the implementation instead includes database-write latency and stores a different value.
- **Fix**: Freeze `transcriptMs` immediately after acquisition, pass that same value as `fetchDurationMs`, and perform the cache write outside the transcript timer.
- **Decision**: FIXED — `transcriptMs` is now declared once above the branches and frozen inside each one the moment the transcript is in hand (quote hit, shared-cache hit, paid fetch). The separate `fetchMs` is gone; the fetch branch passes the same `transcriptMs` to `cacheTranscriptOutcome` as `fetchDurationMs`, so the summary row and the cache row can no longer disagree, and the cache-write RPC now falls outside the measurement.

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
- **Decision**: FIXED via Fix A. New migration `supabase/migrations/20260729120000_transcript_cache_too_long.sql` widens the `outcome` CHECK to include `'too_long'` and adds a nullable `content_chars` diagnostic column; `save_transcript_cache` is dropped and recreated with a ninth argument (`p_content_chars`) rather than overloaded. `'too_long'` falls through `get_transcript_cache`'s `case` onto the 30-day window unchanged — a transcript does not get shorter, so unlike `'unavailable'` the claim cannot stop being true. The endpoint applies the cap in the fetch branch *before* the cache write, storing the verdict with an empty body and the observed length, and a `'too_long'` cache hit returns 413 directly. The generic hard-cap gate is kept: it still covers the quote-cache path and any `'ok'` row written before this migration.
- **Follow-up for Phase 5**: the plan's performance contract ("cache rows up to 200k chars") is now enforced rather than assumed, and `content_chars` gives S-09 the over-cap size distribution for free. Worth an addendum line in `plan.md` since the schema change crosses the phase boundary.
