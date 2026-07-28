<!-- PLAN-REVIEW-REPORT -->
# Plan Review: Persist generation time and provider cost per summary (S-07)

- **Plan**: `context/changes/persist-time-and-cost/plan.md`
- **Mode**: Deep
- **Date**: 2026-07-28
- **Verdict**: REVISE
- **Findings**: 1 critical, 5 warnings, 0 observations

## Verdicts

| Dimension | Verdict |
| --- | --- |
| End-State Alignment | FAIL |
| Lean Execution | PASS |
| Architectural Fitness | WARNING |
| Blind Spots | WARNING |
| Plan Completeness | WARNING |

## Grounding

Grounding: 11/11 existing paths ✓, 6/6 symbol groups ✓, brief↔plan ✗ (F5). Progress: 5/5 phases and 32/32 success criteria matched.

## Findings

### F1 — Ledger cannot deliver the promised Supadata metrics

- **Severity**: ⛔ CRITICAL
- **Impact**: 🔬 HIGH — architectural stakes; think carefully before deciding
- **Dimension**: End-State Alignment
- **Location**: Desired End State; Phases 1, 3 and 5
- **Detail**: The proposed ledger stores `operation`, `outcome`, `resolved_via` and links, but no per-request billed credits (`plan.md:113`). The code explicitly says `inline`/`job` describes the fetch mechanism—not native versus Whisper (`src/types.ts:3`). Generated work can return synchronously, while long videos trigger jobs, so `job` is not a fallback signal. Phase 5 could therefore pass its short/native checks while exact credit and Whisper-fallback analysis remains impossible. Supadata documents an authoritative `x-billable-requests` response header for each request, while the installed SDK discards response headers.
- **Fix A ⭐ Recommended**: Capture `x-billable-requests` at the HTTP boundary and persist nullable `billable_credits` on every ledger row.
  - Strength: Authoritative per-request cost, including summaryless failures and generated transcripts.
  - Tradeoff: Requires wrapping or replacing the SDK's transcript request path while preserving its error/result handling.
  - Confidence: HIGH — Supadata documents the header specifically for request-level credit tracking.
  - Blind spot: Verify header behavior on the initial 202 response and error responses during implementation.
- **Fix B**: Keep a call-only ledger and remove claims of exact credits and measured Whisper fallback.
  - Strength: Minimal change; call counts, retries and job-path frequency remain useful.
  - Tradeoff: S-09 still lacks the primary measurement this plan says it unlocks.
  - Confidence: HIGH — accurately reflects what the proposed fields can prove.
  - Blind spot: None significant.
- **Source**: [Supadata transcript documentation](https://docs.supadata.ai/get-transcript)
- **Decision**: PENDING

### F2 — The production RPC outage window is avoidable

- **Severity**: ⚠️ WARNING
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Architectural Fitness
- **Location**: Critical Implementation Details; Phases 1 and 5
- **Detail**: The plan knowingly accepts 500s and lost OpenRouter spend between migration and deployment (`plan.md:66`). The repository already has the compatible pattern: append new arguments with `DEFAULT NULL`, allowing the previous call shape to continue working (`supabase/migrations/20260727120000_transcript_quote_langs.sql:20-23,66-80`).
- **Fix**: Give all eight appended `persist_summary` parameters `DEFAULT NULL`; update the rollout and rollback sections to remove the incompatibility window.
- **Decision**: PENDING

### F3 — Cache writes can persist an empty transcript

- **Severity**: ⚠️ WARNING
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Blind Spots
- **Location**: Phase 4 — Cache lookup and reuse
- **Detail**: The plan places the cache write "immediately after a successful fetch" (`plan.md:271`), but `fetchTranscript` can return an empty string; the endpoint currently rejects it afterward (`src/pages/api/summaries/generate.ts:281-285`). A literal implementation would cache whitespace and a later cache hit would bypass the fetch-only guard.
- **Fix**: Explicitly place `saveCachedTranscript` after the whitespace rejection, and reject whitespace-only cache rows as misses.
- **Decision**: PENDING

### F4 — `'stored'` violates the quote-cache database constraint

- **Severity**: ⚠️ WARNING
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Architectural Fitness
- **Location**: Phases 1 and 4
- **Detail**: A long shared-cache hit sets `resolvedVia = 'stored'` and later calls `saveTranscriptQuote`. The shared TypeScript union reaches that service, but `transcript_quotes.resolved_via` still accepts only `inline`/`job` (`supabase/migrations/20260722130000_transcript_spend_guards.sql:77-85`). The service swallows the resulting RPC error, producing predictable hidden failures.
- **Fix**: Widen the `transcript_quotes` CHECK to include `'stored'` and add the cached-long-video 409/confirmation path to manual verification.
- **Decision**: PENDING

### F5 — “No new ledger rows” contradicts the metadata contract

- **Severity**: ⚠️ WARNING
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Desired End State verification
- **Detail**: The plan says the second generation creates "no new ledger rows" (`plan.md:33`), while Phase 5 correctly expects a new metadata row because only the transcript is cached (`plan.md:328`). The brief also uses the correct narrower promise.
- **Fix**: Change this to "no new transcript ledger row; one metadata row is expected."
- **Decision**: PENDING

### F6 — Retrospective SQL omits promised metadata spend

- **Severity**: ⚠️ WARNING
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Phase 1 — Retrospective spend estimate
- **Detail**: The contract promises one metadata credit for summaries created after S-08, but the supplied query calculates only `est_transcript_credits` (`plan.md:86-98`). Its success criteria can therefore pass without estimating total historical spend.
- **Fix**: Add the post-S-08 metadata-call count and combined estimated credits to the SQL and document the exact rollout timestamp used.
- **Decision**: PENDING
