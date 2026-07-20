<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Generate and Save a Video Summary (S-01)

- **Plan**: `context/changes/generate-and-save-summary/plan.md`
- **Scope**: Phases 1–7 of 8
- **Date**: 2026-07-19
- **Verdict**: NEEDS ATTENTION
- **Findings**: 0 critical, 6 warnings, 2 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | FAIL |
| Scope Discipline | PASS |
| Safety & Quality | WARNING |
| Architecture | PASS |
| Pattern Consistency | PASS |
| Success Criteria | WARNING |

## Verification

| Check | Result |
|-------|--------|
| `npm.cmd run lint` | PASS |
| `npm.cmd run build` | PASS |
| `npx.cmd supabase migration up` | PASS — no pending local migrations |
| No stale `summaries/probe` references under `src/` | PASS |
| `npm.cmd audit --offline --json` | PASS — 0 known vulnerabilities |

Sixteen manual acceptance checks in phases 1–7 remain unchecked. Phase 7's prompt-quality check is the only manual criterion recorded complete.

## Findings

### F1 — Prompt length rules contradict the planned skim ceiling

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Plan Adherence
- **Location**: `src/lib/services/llm.ts:31`
- **Detail**: Phase 7 requires a bounded skim-length ceiling. Both prompts instead say length should follow the content and important points must not be omitted to stay short (`llm.ts:31-34` and `llm.ts:61-63`). This is a direct contract drift, not a formatting difference.
- **Fix A ⭐ Recommended**: Add explicit, character-specific ceilings while retaining concise coverage.
  - Strength: Restores the approved watch/skip contract and bounds response cost and reading time.
  - Tradeoff: Dense videos may omit lower-priority details.
  - Confidence: HIGH — the phase contract explicitly requires a bounded skim.
  - Blind spot: The best bullet/section limits still need a prompt-quality spot check.
- **Fix B**: Amend the plan to make completeness content-driven and accept unbounded output length.
  - Strength: Preserves the current prompts and favors completeness.
  - Tradeoff: Weakens the skim experience and removes the planned response-length bound.
  - Confidence: HIGH — this accurately documents the implemented behavior.
  - Blind spot: Token-cost and output-length behavior has not been measured across long transcripts.
- **Decision**: FIXED via Fix B (2026-07-20) — confirmed a conscious Phase 7 decision, not drift. Resolved by reframing the product around the **two jobs a summary does**: (1) decide whether the video is worth watching, (2) stand in for the video when it isn't. The shipped prompts already serve both via a layered shape (framing sentences → complete body), which is why the ceiling had to go. Docs updated, prompts deliberately untouched to preserve the Phase 7 manual quality pass: `prd.md` Success Criteria + FR-005 output, `plan.md` Phase 7 contract (with amendment note), `README.md`, `Welcome.astro`. `shape-notes.md`/`idea-notes.md` left as dated discovery records. Lint + build pass. **Carried risk**: unbounded output length is unmeasured, and cost is priced off transcript length (input) only — a fact-dense video yields a longer, more expensive completion at the same credit price.

### F2 — Markdown summaries can trigger third-party image requests

- **Severity**: ⚠️ WARNING
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: `src/components/summaries/GenerateSummaryForm.tsx:282`
- **Detail**: LLM output is untrusted because transcript content can influence it. `react-markdown` blocks raw HTML and unsafe URL protocols, but Markdown images remain enabled and can make the viewer's browser fetch an attacker-controlled URL, exposing network/referrer information. The component map does not suppress `img`.
- **Fix**: Restrict `Markdown` to the elements required by the prompts or override `img` to render nothing; suppress links too unless they are product-required.
- **Decision**: PENDING

### F3 — A failed refund can leave a user charged for failed work

- **Severity**: ⚠️ WARNING
- **Impact**: 🔬 HIGH — architectural stakes; think carefully before deciding
- **Dimension**: Safety & Quality
- **Location**: `src/lib/services/credits.ts:63`
- **Detail**: The endpoint debits before LLM/persistence work, but `refundCredits` logs and swallows a missing admin client or failed refund RPC. The response then returns 500/502 while the debit remains, contradicting the plan's invariant that failed work never charges the user. `SUPABASE_SERVICE_ROLE_KEY` is also not part of the generation preflight/config-status gate.
- **Fix**: Introduce an idempotent reservation/refund ledger with retry/reconciliation, and fail generation before debit when the admin compensation path is not configured.
  - Strength: Makes the no-charge-on-failure invariant recoverable across transient and ambiguous failures.
  - Tradeoff: Requires a migration, endpoint/service changes, and an operational retry/reconciliation path.
  - Confidence: HIGH — the current swallowed failure has a direct data-integrity consequence.
  - Blind spot: The desired retry mechanism and operational ownership are not yet specified.
- **Decision**: PENDING

### F4 — Concurrent requests can amplify paid transcript work

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: `src/pages/api/summaries/generate.ts:59`
- **Detail**: The pre-transcript gate is a balance read. Many concurrent requests can all pass it and incur Supadata work before the later atomic debit allows only the affordable winners. The plan accepts a race-losing transcript fetch as an MVP tradeoff, but there is no per-user concurrency/rate limit to bound amplification.
- **Fix**: Add a per-user in-flight generation limit or idempotent pre-transcript reservation that can be adjusted after transcript length is known.
  - Strength: Bounds external cost amplification without weakening the atomic final debit.
  - Tradeoff: Requires shared state and careful cleanup for abandoned requests.
  - Confidence: HIGH — the read/debit ordering permits the concurrency window by construction.
  - Blind spot: Expected user concurrency and Supadata billing behavior have not been quantified.
- **Decision**: PENDING

### F5 — Unknown credit balance disables otherwise valid generation

- **Severity**: ⚠️ WARNING
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: `src/components/summaries/GenerateSummaryForm.tsx:87`
- **Detail**: `credits === null` disables submission and displays “no credits,” while `dashboard.astro` deliberately uses `null` for missing configuration, a missing row, or a transient display-only read failure. A recoverable display read therefore blocks the feature before the authoritative endpoint can enforce credits.
- **Fix**: Treat an unknown balance separately from zero, allow submission when unknown, and let the endpoint remain authoritative while displaying a balance-unavailable hint.
- **Decision**: PENDING

### F6 — Long-video confirmation is not bound to the quoted inputs

- **Severity**: ⚠️ WARNING
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: `src/components/summaries/GenerateSummaryForm.tsx:125`
- **Detail**: Confirmation stores only cost and transcript length and remains visible when URL or character changes. Clicking “Generate anyway” then submits the current inputs with `allowLong: true`, although the displayed quote came from an earlier request.
- **Fix**: Clear confirmation whenever URL/character changes, or bind it to the submitted inputs/server-issued quote and reject mismatches.
- **Decision**: PENDING

### F7 — Empty or unusable LLM output is persisted and charged

- **Severity**: ℹ️ OBSERVATION
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: `src/lib/services/llm.ts:84`
- **Detail**: Any resolved `generateText` result is treated as success without trimming or checking for empty text or an unusable/truncated finish reason. It can then be persisted and charged as a valid summary.
- **Fix**: Require non-empty trimmed text and reject unusable finish states so the existing failure/refund path runs.
- **Decision**: PENDING

### F8 — Most manual acceptance evidence is still pending

- **Severity**: ℹ️ OBSERVATION
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Success Criteria
- **Location**: `context/changes/generate-and-save-summary/plan.md:501`
- **Detail**: Automated gates pass, but 16 manual criteria remain unchecked across English fallback copy, RPC permissions/behavior, endpoint error/refund paths, long-video confirmation, browser UI behavior, and Chrome/Firefox coverage. Only phase 7's two-character prompt-quality check is recorded complete.
- **Fix**: Execute the pending phase 1–7 manual matrix against the local/cloud environment as applicable and record evidence in `## Progress` before release acceptance.
  - Strength: Validates the external-service, permission, browser, and compensation behavior that static review cannot prove.
  - Tradeoff: Requires authenticated fixtures, controlled balances/keys, long/no-transcript videos, and two browsers.
  - Confidence: HIGH — all pending checks are explicitly visible in the plan.
  - Blind spot: This review did not mutate production data or intentionally break live credentials to manufacture evidence.
- **Decision**: PENDING
