<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Transcript → LLM Probe (F-02)

- **Plan**: context/changes/transcript-llm-probe/plan.md
- **Scope**: Phase 3 of 4 (Services — transcript, LLM, persistence)
- **Date**: 2026-07-08
- **Verdict**: NEEDS ATTENTION
- **Findings**: 0 critical, 2 warnings, 2 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | PASS |
| Scope Discipline | PASS |
| Safety & Quality | WARNING |
| Architecture | PASS |
| Pattern Consistency | WARNING |
| Success Criteria | PASS |

## Findings

### F1 — `mode: "auto"` async job misclassified as "unavailable"

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: src/lib/services/transcript.ts:14
- **Detail**: `supadata.transcript()` returns `TranscriptOrJobId = Transcript | { jobId: string }` (confirmed in `@supadata/js/dist/index.d.ts:123`; the SDK docstring: *"If the video is too large to return transcript immediately, request returns a job ID."*). When the response is the `{ jobId }` shape, the guard `!("content" in result)` returns `{ ok: false, reason: "unavailable" }` — reporting a *pending async transcription* as *permanently unavailable*, writing no rows. This is precisely the Whisper-fallback path (`mode: "auto"`) that was chosen to resolve PRD Open Q1 ("video without a transcript"), so the case the fallback exists for is the case that silently fails. Manual check 3.4 ("returns `{ ok: false }` for a caption-less video") may have **false-passed**: a mis-read `jobId` yields the same `{ ok: false }` the test expected, masking the gap.
- **Fix**: Branch on the result shape — if `"jobId" in result`, poll `supadata.transcript.getJobStatus(jobId)` until the job completes (or a bounded timeout), then map its terminal `failed`/unavailable state to `{ ok: false }`; only treat a genuine terminal-unavailable as `unavailable`.
  - Strength: Actually exercises the Whisper fallback the probe was built to de-risk; removes the false-pass on check 3.4.
  - Tradeoff: Adds a polling loop with a timeout budget — worth confirming against the Worker CPU/wall-clock limits that Phase 4 measures anyway.
  - Confidence: HIGH — return union and `getJobStatus` are both in the shipped SDK types.
  - Blind spot: Haven't confirmed whether short caption-less videos return `content` inline or always via a job; Phase 4's live run should verify with a genuinely caption-less clip.
- **Decision**: FIXED — added `"jobId" in result` branch with bounded polling (`pollTranscriptJob`) in src/lib/services/transcript.ts. Revised twice after follow-up research:
  1. Confirmed via Cloudflare docs that Workers HTTP requests have no wall-clock duration limit — the actual constraint is the free-plan subrequest budget (50/invocation), not time. Switched from a time-based deadline to an attempt-count cap.
  2. Confirmed via Supadata's docs (docs.supadata.ai/get-transcript) that videos >20 min always take the async `jobId` path and Supadata publishes no upper bound on job duration ("AI transcription time is correlated with video duration"); their own guidance is to poll every 1s and polling is free of charge. Since summarization isn't a real-time interaction, switched to **exponential backoff**: `JOB_POLL_INITIAL_INTERVAL_MS = 1000`, `JOB_POLL_BACKOFF_FACTOR = 2`, `JOB_POLL_MAX_INTERVAL_MS = 30000`, `JOB_POLL_MAX_ATTEMPTS = 12` — sequence 1s/2s/4s/8s/16s/30s×7, giving ~4 minutes of coverage at exactly 12 subrequests (vs. 50s at 10 subrequests in the prior revision). Movie-length videos with longer Whisper jobs remain a known residual risk (Supadata gives no SLA to size against); Phase 4's live `wrangler tail` run against real long-form content is the way to validate this empirically.

### F2 — `baseUrl` deprecated in tsconfig (TS 7.0 removal)

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: tsconfig.json:8
- **Detail**: VS Code reports *"Option 'baseUrl' is deprecated and will stop functioning in TypeScript 7.0."* Since TS 4.1, `paths` entries that are themselves relative (here `"@/*": ["./src/*"]`) resolve against the tsconfig's own directory with no `baseUrl` needed. Project is on `typescript@5.9.3`, so `baseUrl` is redundant today and only carried for the alias, which no longer requires it. Not part of the Phase 3 diff — pre-existing config, surfaced because it was raised alongside this review.
- **Fix A ⭐ Recommended**: Delete the `"baseUrl": "."` line; keep `paths` as-is.
  - Strength: Removes the deprecated option entirely rather than muting the warning; `@/*` keeps resolving because `./src/*` is already tsconfig-relative. Verified the extended `astro/tsconfigs/strict` sets no `baseUrl` of its own.
  - Tradeoff: None functional — `npm run lint`/`build` both pass without it (re-verify after the edit).
  - Confidence: HIGH — standard TS 5.x path-alias-without-baseUrl setup.
  - Blind spot: None significant.
- **Fix B**: Add `"ignoreDeprecations": "6.0"` to silence the diagnostic.
  - Strength: One line; keeps `baseUrl` if some tool is assumed to depend on it.
  - Tradeoff: Only postpones — the option still stops functioning in TS 7.0; you'd revisit then.
  - Confidence: HIGH — that's the exact flag the message names.
  - Blind spot: Nothing here actually needs `baseUrl`, so this hides rather than fixes.
- **Decision**: FIXED via Fix A — removed `"baseUrl": "."` from tsconfig.json:8; `npm run lint` passes, `@/*` alias still resolves via tsconfig-relative `paths`.

### F3 — Error message dereferences possibly-null error object

- **Severity**: 🔭 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/lib/services/summaries.ts:116,128
- **Detail**: The guard `if (videoError || !video)` also fires when `videoError` is `null` but `video` is falsy, yet the body reads `videoError.message` (same at line 127/128 for `summaryError`). In that branch the message access would throw `TypeError: Cannot read properties of null` instead of the intended clean error. In practice `.single()` after `upsert/ins...select` returns a non-null error (PGRST116) whenever no row comes back, so the branch is effectively unreachable — hence the finding is an observation, not a warning.
- **Fix**: Use `videoError?.message ?? "no row returned"` (and the same for `summaryError`) so the thrown message is robust regardless of which half of the guard tripped.
- **Decision**: DISMISSED — attempted the fix; `@typescript-eslint/no-unnecessary-condition` rejected the optional chaining as unnecessary. `postgrest-js`'s `PostgrestSingleResponse<T>` is a discriminated union (`{success:true,error:null,data:T}` | `{success:false,error:PostgrestError,data:null}`); TS narrows `videoError` to non-null within the `if (videoError || !video)` block via that discriminant, so the null-deref is statically unreachable, not merely unreachable "in practice." Reverted the edit to keep the original `videoError.message`/`summaryError.message`.

### F4 — Served-model slug read via `finalStep.response` rather than `response`

- **Severity**: 🔭 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Adherence
- **Location**: src/lib/services/llm.ts:33
- **Detail**: The plan's contract specifies persisting `response.modelId` from the `generateText` result. The code reads `result.finalStep.response.modelId`. Both resolve to the served slug and the smoke test (3.3) confirmed a non-empty value, so this is functionally correct — just a slightly more indirect access than the documented `result.response.modelId` (which the AI SDK exposes as the final-step response).
- **Fix**: Read `result.response.modelId` to match the plan contract and shorten the access path.
- **Decision**: DISMISSED — checked `ai` package's shipped `GenerateTextResult` type (`node_modules/ai/dist/index.d.ts:4549`): `response` is `@deprecated Use finalStep.response instead.` The current code (`result.finalStep.response.modelId`) is the correct, non-deprecated accessor for the installed AI SDK version; applying this "fix" would reintroduce a deprecated field. The plan's contract predates this SDK's deprecation and is the stale artifact here, not the code. No change made.
