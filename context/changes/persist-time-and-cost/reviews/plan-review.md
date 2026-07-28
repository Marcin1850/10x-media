<!-- PLAN-REVIEW-REPORT -->
# Plan Review: Persist generation time and provider cost per summary (S-07)

- **Plan**: `context/changes/persist-time-and-cost/plan.md`
- **Mode**: Deep
- **Date**: 2026-07-28
- **Verdict**: REVISE → **SOUND after triage** (2026-07-28)
- **Findings**: 1 critical, 5 warnings, 0 observations — 4 fixed, 1 accepted, 1 moot

## Verdicts

| Dimension | At review | After triage |
| --- | --- | --- |
| End-State Alignment | FAIL | PASS |
| Lean Execution | PASS | PASS |
| Architectural Fitness | WARNING | PASS |
| Blind Spots | WARNING | PASS |
| Plan Completeness | WARNING | PASS |

Reasoning for the movement is at the bottom, under §Triage outcome.

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
- **Decision**: FIXED via Fix A — docs fetched via Context7 and captured in `context/changes/persist-time-and-cost/docs/supadata-billable-requests.md` (+ `docs/README.md`); plan updated across Current State, Desired End State, What We're NOT Doing, Implementation Approach, Phase 1(b) schema, Phase 3 §2/§3/§4, Phase 5 verification, References and Progress. Grounded further during triage: `@supadata/js@1.4.0` binds `fetch` at module load, so the transport swap (following the existing `metadata.ts:43` direct-fetch precedent) is the only workable route.

### F2 — The production RPC outage window is avoidable

- **Severity**: ⚠️ WARNING
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Architectural Fitness
- **Location**: Critical Implementation Details; Phases 1 and 5
- **Detail**: The plan knowingly accepts 500s and lost OpenRouter spend between migration and deployment (`plan.md:66`). The repository already has the compatible pattern: append new arguments with `DEFAULT NULL`, allowing the previous call shape to continue working (`supabase/migrations/20260727120000_transcript_quote_langs.sql:20-23,66-80`).
- **Fix**: Give all eight appended `persist_summary` parameters `DEFAULT NULL`; update the rollout and rollback sections to remove the incompatibility window.
- **Decision**: ACCEPTED — window kept, as S-08 did. Note for the record: `DEFAULT NULL` would not have avoided the drop-and-recreate (grants are signature-scoped); it would only have kept the new function callable with the old 15-argument shape between `db push` and `wrangler deploy`.

### F3 — Cache writes can persist an empty transcript

- **Severity**: ⚠️ WARNING
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Blind Spots
- **Location**: Phase 4 — Cache lookup and reuse
- **Detail**: The plan places the cache write "immediately after a successful fetch" (`plan.md:271`), but `fetchTranscript` can return an empty string; the endpoint currently rejects it afterward (`src/pages/api/summaries/generate.ts:281-285`). A literal implementation would cache whitespace and a later cache hit would bypass the fetch-only guard.
- **Fix**: Explicitly place `saveCachedTranscript` after the whitespace rejection, and reject whitespace-only cache rows as misses.
- **Reframed during triage (user)**: an empty transcript is a *billable success* and, for instrumental video, the permanent truth — so it should be cached to avoid re-paying, not excluded. Re-grounding also found the finding understated the bug: `summaryCost(0)` returns `1` (`summaries.ts:131-133`), so a cached-empty hit would clear the 413/409 gates, **debit a credit and send an empty transcript to the LLM**. The quote cache is safe today only because `saveTranscriptQuote` runs downstream of the guard; this plan is what makes the path reachable.
- **Decision**: FIXED via revised Fix A + `ok:false` split — cache empties (`outcome = 'empty'`), hoist the whitespace guard below the whole acquisition if/else, split `TranscriptResult`'s failure arm into `unavailable | failed | timeout`, and negative-cache only `unavailable` on a separate 24-hour window (`TRANSCRIPT_CACHE_NEGATIVE_MAX_AGE_SECONDS`) to bound the fresh-upload/late-auto-captions risk. `failed`/`timeout` are never cached. Plan updated in Phase 1(a), Phase 1 §2 RPCs, Phase 3 §1 and §3(b), Phase 4 §2, Testing Strategy and Progress.

### F4 — `'stored'` violates the quote-cache database constraint

- **Severity**: ⚠️ WARNING
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Architectural Fitness
- **Location**: Phases 1 and 4
- **Detail**: A long shared-cache hit sets `resolvedVia = 'stored'` and later calls `saveTranscriptQuote`. The shared TypeScript union reaches that service, but `transcript_quotes.resolved_via` still accepts only `inline`/`job` (`supabase/migrations/20260722130000_transcript_spend_guards.sql:77-85`). The service swallows the resulting RPC error, producing predictable hidden failures.
- **Fix**: Widen the `transcript_quotes` CHECK to include `'stored'` and add the cached-long-video 409/confirmation path to manual verification.
- **Decision**: FIXED — Phase 1(d) now covers **both** `resolved_via` constraints (`summaries` and `transcript_quotes`) with the silent-failure symptom spelled out; verification added at Phase 1 manual (1.8) and Phase 4 manual (4.9), the latter querying `transcript_quotes` directly since a swallowed constraint error is invisible from the client.

### F5 — “No new ledger rows” contradicts the metadata contract

- **Severity**: ⚠️ WARNING
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Desired End State verification
- **Detail**: The plan says the second generation creates "no new ledger rows" (`plan.md:33`), while Phase 5 correctly expects a new metadata row because only the transcript is cached (`plan.md:328`). The brief also uses the correct narrower promise.
- **Fix**: Change this to "no new transcript ledger row; one metadata row is expected."
- **Decision**: FIXED — corrected as part of the F1 edit to the Desired End State verification line.

### F6 — Retrospective SQL omits promised metadata spend

- **Severity**: ⚠️ WARNING
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Phase 1 — Retrospective spend estimate
- **Detail**: The contract promises one metadata credit for summaries created after S-08, but the supplied query calculates only `est_transcript_credits` (`plan.md:86-98`). Its success criteria can therefore pass without estimating total historical spend.
- **Fix**: Add the post-S-08 metadata-call count and combined estimated credits to the SQL and document the exact rollout timestamp used.
- **Decision**: MOOT — the retrospective estimate was cut from the plan entirely during triage. Its only costing input was the `resolved_via` → Whisper formula that F1's fix supersedes, and the ledger reports measured spend within days of rollout. History before the ledger stays unpriced by decision, recorded in "What We're NOT Doing".

## Triage outcome (2026-07-28)

| Finding | Decision |
| --- | --- |
| F1 — Ledger cannot deliver the promised Supadata metrics | FIXED (Fix A, docs fetched first) |
| F2 — Production RPC outage window | ACCEPTED |
| F3 — Cache writes can persist an empty transcript | FIXED (revised Fix A + `ok:false` split) |
| F4 — `'stored'` violates the quote-cache CHECK | FIXED |
| F5 — "No new ledger rows" contradiction | FIXED (folded into F1's edit) |
| F6 — Retrospective SQL omits metadata spend | MOOT (artifact cut) |

### Decisions taken during triage that go beyond the findings

1. **Retrospective spend estimate cut from Phase 1.** Its only costing input was the
   `resolved_via` → Whisper formula F1 discredited, and the ledger supersedes it within days
   of rollout. Phase 1 is now "Schema"; history before the ledger stays unpriced by decision.
2. **Phase 5 budget raised from 2–3 to 6–9 credits** and the Whisper `job` path moved from
   "deliberately not verified live" to a required run. Rationale: the vendor docs name the
   header `x-billable-requests` but describe it as *credit usage* monitoring, and those
   diverge only on the `job` path (a 3-min Whisper job is 1 request, 6 credits). A native
   video reads `1` under either reading, so runs 1–2 cannot settle the unit. Shipping a
   column whose unit is discovered after rows accumulate would repeat F1's own failure mode.
3. **Negative caching gained a separate 24-hour window.** `unavailable` is usually but not
   always permanent — YouTube publishes auto-captions with a lag — so the shorter TTL bounds
   how long a stale "no transcript" claim can lock out a freshly uploaded video.

### Verdict movement

| Dimension | Before | After |
| --- | --- | --- |
| End-State Alignment | FAIL | PASS — spend is measured per call; the S-09 question is answerable |
| Lean Execution | PASS | PASS — an artifact was removed, none added |
| Architectural Fitness | WARNING | PASS — both CHECK constraints widened; transport swap follows `metadata.ts` |
| Blind Spots | WARNING | PASS — empty/unavailable paths cached and guarded; header unit scheduled for resolution |
| Plan Completeness | WARNING | PASS — Progress re-synced (9/5/9/9/7) |
