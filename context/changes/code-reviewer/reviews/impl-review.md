<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Code Reviewer (Claude Agent SDK) — First Version Implementation Plan

- **Plan**: `context/changes/code-reviewer/plan.md`
- **Scope**: Phases 1–3 of 3
- **Date**: 2026-09-14
- **Verdict**: NEEDS ATTENTION
- **Findings**: 0 critical, 4 warnings, 1 observation

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | FAIL |
| Scope Discipline | PASS |
| Safety & Quality | WARNING |
| Architecture | FAIL |
| Pattern Consistency | PASS |
| Success Criteria | WARNING |

## Verification evidence

| Criterion | Result |
|-----------|--------|
| Package `npm ci` | PASS — 153 packages installed, 0 vulnerabilities |
| Package `npm run typecheck` | PASS |
| Package `npm test` | PASS — 4 files, 21 tests |
| Missing-key fast failure | PASS — exit 1 before SDK call |
| Root `npm run typecheck` | PASS |
| Root `npm run lint` | PASS |
| Root `npm run typecheck:astro` | PASS — 0 errors; 8 pre-existing hints |
| Root lockfile unchanged | PASS |
| Phase 3 paid run | NOT RE-RUN — the plan allows one paid run only; existing evidence records exit 0, one matching finding, cost $0.066499, and tools exactly `["StructuredOutput"]` |

## Findings

### F1 — Declared diff-only isolation still inherits host context

- **Severity**: ⚠️ WARNING
- **Impact**: 🔬 HIGH — architectural stakes; think carefully before deciding
- **Dimension**: Architecture
- **Location**: `packages/code_reviewer/src/review.ts:46`
- **Detail**: The plan and package description promise no inherited settings and a diff-only reviewer, but `settingSources: []` does not suppress auto-memory or `~/.claude.json`. The package's own `docs/query-options.md:64-95` says both are read regardless of `settingSources`, and confirms auto-memory exists for this repository. `review.ts:51` intentionally omits `env`, so unrelated or sensitive host context can enter the system prompt and influence a review. Managed policy remains a residual risk even after local isolation.
- **Fix ⭐ Recommended**: Pass a controlled merged environment with `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` and a dedicated empty `CLAUDE_CONFIG_DIR`; document managed policy as the remaining limitation.
  - Strength: Aligns the runtime with the stated diff-only boundary using controls documented by the package itself.
  - Tradeoff: `env` replaces rather than merges, so required process variables must be copied deliberately and the temporary config directory needs lifecycle handling.
  - Confidence: HIGH — the SDK behavior and disabling controls are already documented in `docs/query-options.md`.
  - Blind spot: Server/endpoint-managed policy cannot be disabled from the SDK and must remain disclosed.
- **Decision**: PENDING

### F2 — Lockdown attestation is fail-open and init metadata is optional

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Plan Adherence
- **Location**: `packages/code_reviewer/src/cli.ts:36`
- **Detail**: The Phase 2 contract requires successful runs to carry `initTools: string[]` and `model: string` from the init message. Instead, `ReviewRun` uses `Partial<SessionInit>` (`review.ts:22-24`); missing init or unexpected tools only produce warnings (`cli.ts:36-47`), and a valid structured result can still exit 0 and save `model: null` / `tools: null` (`cli.ts:69-89`). This turns the plan's lockdown proof into a fail-open after-the-fact signal. The caret SDK range makes a future tool-list regression relevant.
- **Fix**: Require a complete init message and exact tool list `['StructuredOutput']` before an `ok` result may be reported or saved; otherwise return exit 2, and add hermetic tests for missing and unexpected init data.
  - Strength: Makes the executable contract match the plan and prevents automation from accepting an unverified session.
  - Tradeoff: A benign SDK protocol change will fail closed until the package is updated.
  - Confidence: HIGH — the current successful evidence already demonstrates the expected init shape.
  - Blind spot: The current architecture has no unit seam around the CLI/session stream, so a small extraction may be needed for hermetic coverage.
- **Decision**: PENDING

### F3 — Any readable file can be sent to the paid API without a size cap

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: `packages/code_reviewer/src/cli.ts:11`
- **Detail**: Input validation checks only that a path is readable and non-empty. A mistaken command such as reviewing `.env` would transmit secrets to the API; a very large file is read fully and can create avoidable cost, memory pressure, or a context-limit failure. README calls the input a unified diff, but the CLI does not enforce that boundary.
- **Fix**: Before reading/sending, require a regular file under a documented byte cap and minimally validate unified-diff markers/hunks; reject likely secret/config files and document the limit.
  - Strength: Prevents the highest-impact operator mistakes before an API call and bounds resource/cost exposure.
  - Tradeoff: Minimal diff validation must allow legitimate variants such as new/deleted/binary-file diffs or explicitly reject them with a clear message.
  - Confidence: HIGH — the current code has no size/type/content guard.
  - Blind spot: A syntactically valid diff can still contain secrets, so documentation and an explicit warning remain necessary.
- **Decision**: PENDING

### F4 — Schema accepts contradictory verdicts and findings

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: `packages/code_reviewer/src/schema.ts:16`
- **Detail**: `ReviewOutput` validates fields independently but not their semantic relationship. It accepts `approve` with a critical finding, or `comment` with a major finding, even though `SYSTEM_PROMPT` defines request_changes for critical/major, comment for minor/nit, and approve only for no findings. `safeParse` therefore labels internally contradictory model output as successful, and the CLI exits 0; downstream automation could trust the wrong field.
- **Fix**: Add post-schema semantic validation for the verdict/finding relationship and table-driven negative tests; ensure the JSON Schema remains compatible with the SDK and retain local `safeParse` as the final guard.
  - Strength: Converts a prompt convention into an enforced output contract at the trust boundary.
  - Tradeoff: Refinements may not be represented in generated Draft-07 JSON Schema, so enforcement may occur only in the local validation step.
  - Confidence: HIGH — the contradictory objects currently pass the exported Zod schema.
  - Blind spot: The intended behavior for an empty `comment` or minor findings with `request_changes` is not explicitly stated and should be decided before encoding the rule.
- **Decision**: PENDING

### F5 — Error-handling documentation has malformed Markdown

- **Severity**: 👁️ OBSERVATION
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Success Criteria
- **Location**: `packages/code_reviewer/docs/messages-and-errors.md:85`
- **Detail**: The manual documentation criterion is marked complete, but a key rule renders as `max*turns`, ``error*\*`subtype`` and `**Check`terminal_reason`before`subtype`.\*\*`, obscuring the distinction between terminal reasons and error subtypes.
- **Fix**: Correct the text to `max_turns`, an `error_*` subtype, and “Check `terminal_reason` before `subtype`.”
- **Decision**: PENDING
