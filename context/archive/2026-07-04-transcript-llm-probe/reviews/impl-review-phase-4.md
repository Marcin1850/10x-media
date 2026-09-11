<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Transcript → LLM Probe (F-02) — Phase 4

- **Plan**: context/changes/transcript-llm-probe/plan.md
- **Scope**: Phase 4 of 4 (API route + deploy & verify on the Worker)
- **Date**: 2026-07-09
- **Verdict**: NEEDS ATTENTION
- **Findings**: 0 critical, 1 warning, 4 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | PASS |
| Scope Discipline | PASS |
| Safety & Quality | WARNING |
| Architecture | PASS |
| Pattern Consistency | PASS |
| Success Criteria | WARNING |

## Findings

### F1 — Async-job (long-form) transcript path never exercised on the live Worker

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Success Criteria
- **Location**: src/lib/services/transcript.ts:49 (pollTranscriptJob); evidence gap in research.md F-02 verdict
- **Detail**: Progress items 4.5/4.6 are checked `[x]` and the F-02 verdict in `research.md`/`change.md` records "all calls Ok" — but the recorded evidence describes only a short **happy-path** inline summary. The `{ jobId }` / HTTP-202 branch (`pollTranscriptJob`, the exponential-backoff loop) is the riskiest part of the transcript service and the exact reason `mode: "auto"` (Whisper fallback) exists. The plan calls it out twice as an explicit Phase-4 deliverable: line 181 ("validate empirically in Phase 4's live `wrangler tail` run against real long-form content") and line 275. No `resolved_via = "job"` row or long-form latency is recorded, so the F-02 de-risk is incomplete for videos >20 min. The 12-attempt / ~4-min poll ceiling is also a known residual — a long Whisper job could exhaust the loop and return a spurious 422; only a real long-form run tells us whether 4 min of coverage is enough.
- **Fix**: Run the probe against the user-provided long video (`https://www.youtube.com/watch?v=1zKTCcdVcGQ`, `character: "informational"`) on the deployed Worker under `wrangler tail`; confirm a `200` + Polish summary, a `summaries` row with `resolved_via = "job"`, and record the transcript-job wall-clock + observed poll attempts back into `research.md`. If the job outlives the ~4-min ceiling, that's a real result to record (bump `JOB_POLL_MAX_ATTEMPTS` or accept the residual).
  - Strength: Closes the one unproven leg of the F-02 spike using the exact code path (`pollTranscriptJob`) that S-01 will inherit; directly satisfies plan lines 181/275.
  - Tradeoff: Requires a live authenticated run + secrets; a review agent can't execute it, so it's a manual step for the user.
  - Confidence: HIGH — the code branch is real and the plan explicitly scopes this validation to Phase 4.
  - Blind spot: Actual Whisper duration for this specific video is unknown until run; it may resolve inline (fast job) and not exercise the poll at all — in which case try a longer/no-caption video.
- **Decision**: RESOLVED — live run 2026-07-09 (see research.md → "Long-form / async-job validation"). Both branches proven on the deployed Worker: long spoken video `1zKTCcdVcGQ` → `200` in 33 s, `resolved_via='inline'`; music video `1ZYbU82GVz4` → `{ jobId }` → `pollTranscriptJob` ran to full 12-attempt exhaustion (~254 s) → `422`, no rows written, no Worker/CPU/subrequest failure. Two plan-assumption corrections captured: (a) a ~1 h video resolved **inline**, not via `{ jobId }` (the ">20 min ⇒ job" claim is not a hard rule); (b) served model slug `anthropic/claude-sonnet-5-20260630` ≠ requested `anthropic/claude-sonnet-5`, validating the "store served model" design. Residual (~4-min poll ceiling) unchanged but now characterized.

### F2 — Full transcript sent to the model with no length guard

- **Severity**: 🔵 OBSERVATION
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: src/lib/services/llm.ts:27; src/pages/api/summaries/probe.ts:43
- **Detail**: `summarize()` passes the entire transcript as `prompt` with no truncation, chunking, or size cap. For the short probe videos this is fine, but the moment Phase 4 is exercised on genuinely long-form content (the requested test), a multi-hour transcript can exceed the model's input context window (OpenRouter returns an error → thrown → unhandled 500) or drive up latency/cost. This is directly on the path of the long-video test in F1: if that test fails, an over-length prompt is a likely cause.
- **Fix**: For the probe, note it as a known limit; before S-01, add a transcript length guard (truncate to a token/char budget, or map an over-length/context error to a clear non-500 JSON like the `422` path).
- **Decision**: DEFERRED to S-01 — accepted as a known probe limit. Note: the ~1 h Test-1 transcript summarized fine (`200`/33 s), so the ceiling wasn't hit in practice here, but the guard is still warranted for the real UX.

### F3 — Uncaught upstream errors surface as raw 500s

- **Severity**: 🔵 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/pages/api/summaries/probe.ts:38-43
- **Detail**: The endpoint enumerates 503/401/400/422/200, but any *non*-`transcript-unavailable` throw from `fetchTranscript` (e.g. `getJobStatus` failing mid-poll, a Supadata network/5xx) or any throw from `summarize` (OpenRouter outage/rate-limit) is uncaught, yielding Astro's default 500 with a potential stack in the response. Acceptable for a throwaway probe, but the plan's non-500 contract only holds for the *transcript-unavailable* case, not for transient upstream failures.
- **Fix**: Wrap the transcript+summarize orchestration in a try/catch that logs and returns a `502`/`503` JSON (`{ error: "upstream failure" }`) instead of leaking a 500. Skippable for the probe; fold into S-01 hardening.
- **Decision**: DEFERRED to S-01 — accepted for the probe. No uncaught-500 was observed in the live run (all four requests logged `Ok`), but the guard is warranted before the real UX.

### F4 — Persist summary generation time to the DB

- **Severity**: 🔵 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Success Criteria (observability / later comparison)
- **Location**: src/pages/api/summaries/probe.ts:43-62 ; src/lib/services/summaries.ts (SummaryInsert)
- **Detail**: The probe records `model` and `resolved_via` per summary to support later manual quality comparison, but not **how long generation took**. The live run showed this varies widely and meaningfully — 33 s (inline transcript + LLM) vs 254 s (async-job poll to exhaustion). Capturing generation latency (transcript-fetch ms and/or LLM ms, or a single wall-clock ms) alongside each summary would let S-01 compare models/characters on speed as well as content, and flag slow long-form cases — the same rationale that justified persisting `model`/`resolved_via`.
- **Fix**: Postponed to S-01. When the real UX lands, add an additive `generation_ms` (or split `transcript_ms`/`llm_ms`) column to `summaries` and thread the timing through the persistence service, same idempotent-migration pattern as `model`/`resolved_via`.
- **Decision**: DEFERRED to S-01 — accepted as a good-to-have; not a probe blocker.

### F5 — Persist per-call LLM cost to the DB

- **Severity**: 🔵 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Success Criteria (observability / later comparison)
- **Location**: src/lib/services/llm.ts:7 (getSummaryModel), :27-33 (summarize)
- **Detail**: Alongside `model`, `resolved_via`, and generation time (F4), the **actual $ cost** of each summary is the other axis for the plan's "75%-good-enough" cost/quality tracking (it's even called out in `docs/openrouter.md`). **Confirmed feasible via the SDK already in use** (Context7 → `@openrouter/ai-sdk-provider`): construct the model with `usage: { include: true }`, then read `result.providerMetadata?.openrouter?.usage` — an `OpenRouterUsageAccounting` object exposing `cost` (credits/$), `promptTokens`, `completionTokens`, `totalTokens`. No new dependency, no raw-REST fallback needed. The probe's `getSummaryModel` currently omits `usage: { include: true }`, so cost isn't captured today.
- **Fix**: Postponed to S-01. (1) Add `{ usage: { include: true } }` to the `getSummaryModel` model options; (2) return `cost` (and optionally token counts) from `summarize()` via `providerMetadata.openrouter.usage`; (3) add an additive `cost_usd numeric` (+ optional token columns) to `summaries` and thread it through the persistence service — same idempotent-migration pattern as `model`/`resolved_via`. Note `cost` is `number | undefined` in the type, so persist null-safely.
- **Decision**: DEFERRED to S-01 — accepted as a good-to-have; not a probe blocker. Feasibility confirmed (OpenRouter usage accounting via AI SDK provider).
