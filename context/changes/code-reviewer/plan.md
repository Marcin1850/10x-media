# Code Reviewer (Claude Agent SDK) — First Version Implementation Plan

## Overview

Build the first runnable version of a code-review agent on `@anthropic-ai/claude-agent-sdk`, as a standalone package in `packages/code_reviewer/`. It takes a unified diff, reviews it with no tools and no inherited settings, and returns zod-validated JSON findings. The change is done when one real run on a few-line, LLM-generated diff with a planted bug reports that bug. SDK documentation fetched through Context7 is saved in `packages/code_reviewer/docs/` for future work.

## Current State Analysis

- `packages/code_reviewer/` is empty apart from `.claude/settings.local.json` (gitignored by the root `.claude/` rule). The repo root is a single npm package — no `workspaces`.
- The root toolchain would silently adopt anything under `packages/`:
  - `tsconfig.json` — `include: ["**/*"]`, `exclude: ["dist", "coverage"]`; used by `npm run typecheck` (pre-commit, CI) and `astro check` (pre-push, CI).
  - `eslint.config.js` — `eslint .` with `projectService: true` and type-checked rules; lint-staged runs `eslint --fix` on every staged `*.{ts,tsx,astro}`. Only `.gitignore` feeds its ignores (`includeIgnoreFile`, line 99).
  - `vitest.config.ts` — both projects include only `src/**`, so Vitest already does not collect the package.
- The SDK (npm `0.3.270`, Node ≥18, peers `zod ^4`, `@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`) defaults to loading user + project + local settings — i.e. `~/.claude` rules, the repo `CLAUDE.md`, hooks. For a reviewer meant to be independent (`context/team/opportunity-map.md`), that default is wrong.
- No roadmap item carries this change ID; this is a tooling spike outside the product roadmap. It is **not** the `review-runner` from the opportunity map (that one wraps Codex and is still gated on the Mom Test); this change only proves the SDK can host a reviewer.

## Desired End State

- `packages/code_reviewer/` is a self-contained npm package (own `package.json`, lockfile, `node_modules`, `tsconfig.json`) that the root's `typecheck`, `typecheck:astro`, `lint`, and CI never touch — and whose absence of effect on them is proven by running them.
- `npm run review -- <diff-file>` (inside the package) runs the agent with `ANTHROPIC_API_KEY` from the package's `.env`, prints and saves a JSON report `{ verdict, findings[], meta: { model, costUsd, durationMs, sessionId } }` validated by zod, and exits non-zero on any configuration or agent failure.
- A fixture diff of a few lines with one documented planted bug exists, and a recorded run shows the agent finding it.
- `packages/code_reviewer/docs/` holds the Agent SDK reference material used to build it.

Verification: the Progress section below — automated gates per phase, plus a human check of the first run's findings against `expected.md`.

### Key Discoveries:

- `allowedTools` does **not** restrict tools — it only auto-approves the listed ones; unlisted tools still exist and fall through to the permission mode (SDK docs, *Permissions → Allow and deny rules*). A tool-less agent needs `tools: []` (restricts the built-in set) plus `permissionMode: "dontAsk"`.
- `settingSources` omitted = user + project + local settings, CLAUDE.md included; `settingSources: []` loads none (SDK docs, *Modifying system prompts → CLAUDE.md*). A plain-string `systemPrompt` replaces the `claude_code` preset.
- Structured output: `outputFormat: { type: "json_schema", schema }` → `structured_output` on the `result` message with `subtype: "success"`; failure subtype `error_max_structured_output_retries`. Zod bridge: `z.toJSONSchema(Schema, { target: "draft-7" })`, then `safeParse` the returned object (SDK docs, *Structured outputs*).
- A single-shot `query()` **throws after yielding** an error result; a connection/process failure yields no result at all. The result message carries `total_cost_usd`, `session_id`.
- In TypeScript, the `env` option *replaces* the subprocess environment — so don't pass it; rely on `process.env` populated by `--env-file`.
- Root `.gitignore` already ignores `.env` / `.env.*` with `!.env.example` at any depth, and `.claude/` at any depth.
- *(Found in Phase 2, 2026-09-14.)* With `tools: []` + `outputFormat`, the init message lists exactly one tool, `StructuredOutput` — the SDK's delivery channel for structured output. It is the expected tool list, not a lockdown leak; anything beyond it is.
- Model attribution must come from what the run reports, never a hard-coded string — the opportunity map found two drifting spellings of the Codex model in 43 commits.

## What We're NOT Doing

- No integration with the 10x skills, `/10x-impl-review`, git hooks, CI, or a commit step — that is the `review-runner` idea, still unvalidated.
- No repo access for the agent: no `Read`/`Grep`/`Glob`/`Bash`, no `cwd` pointing at code. Context-dependent bugs are out of reach in v1 by design.
- No npm workspaces, no changes to the root `package.json`, lockfile, or CI workflow.
- No automated assertion that the LLM found the planted bug (flaky by nature) — that match is a manual check.
- No markdown rendering of findings, no multi-diff batch runs, no reading diffs from `git diff` directly (a file path is the only input).
- No Claude-subscription login fallback — API key only.
- No Stryker, coverage thresholds, or lint setup inside the package.

## Implementation Approach

Isolate first, then build the smallest agent that can be verified, then prove it on a known answer. Phase 1 makes the package invisible to the Astro app's gates before any `.ts` file lands in it, so a pre-commit hook never trips on an SDK import the root cannot resolve. Phase 2 splits the agent into pure pieces (schema, prompt builder, config guard, result interpretation) that are unit-testable without spending tokens, and one thin `query()` call site. Phase 3 is the only phase that costs money: one run, saved as evidence.

## Critical Implementation Details

**Lockdown must be verified, not assumed.** Setting `tools: []`, `settingSources: []`, `permissionMode: "dontAsk"` is the intent; the proof is the `system` / `init` message the SDK yields first, which lists the session's tools and model. The CLI should log that tool list (and take `model` from it for `meta`). If structured output turns out to require an internal tool that `tools: []` removes (the run ends in `error_max_structured_output_retries` or never produces `structured_output`), fall back to `disallowedTools` naming the built-in tools explicitly — do not fall back to the default tool set.

**Two failure channels.** The CLI must handle both an error `result` message (record subtype + cost, then the loop throws) and a throw with no result at all. Interpret the result message inside the loop, catch the throw around it, and decide the exit code from what was captured — never report success because the loop ended.

## Phase 1: Package Scaffold, Root Isolation, SDK Docs

### Overview

Create the standalone package skeleton, make the root toolchain ignore `packages/**`, and save the SDK docs.

### Changes Required:

#### 1. Root isolation

**File**: `tsconfig.json`

**Intent**: Stop root `tsc --noEmit` and `astro check` from typechecking the package against the app's config and dependency tree.

**Contract**: add `"packages"` to `exclude`.

**File**: `eslint.config.js`

**Intent**: Stop `eslint .` (CI, lint-staged) from linting package files with the app's type-aware config.

**Contract**: a global-ignores entry for `packages/**` in the exported `tseslint.config(...)`, next to `includeIgnoreFile`, with a one-line comment in the file's existing style explaining that packages carry their own toolchain.

`vitest.config.ts` needs no change (both projects already include only `src/**`) — note it in the commit message rather than editing it.

#### 2. Package skeleton

**File**: `packages/code_reviewer/package.json`

**Intent**: Self-contained ESM package with its own dependencies and scripts.

**Contract**: `"private": true`, `"type": "module"`, `engines.node >=22`. Dependencies: `@anthropic-ai/claude-agent-sdk`, `zod` (^4). Dev: `typescript` (same major as root, ^5.9), `tsx`, `vitest`, `@types/node`. Scripts: `review` (`tsx --env-file-if-exists=.env src/cli.ts`), `typecheck` (`tsc --noEmit`), `test` (`vitest run`). Commit `package-lock.json`.

**File**: `packages/code_reviewer/tsconfig.json`

**Intent**: Strict, Node-targeted config independent of Astro's.

**Contract**: `strict`, `module`/`moduleResolution` `NodeNext` (or `Bundler` with `noEmit`), `target` ES2022+, `types: ["node"]`, `include: ["src"]` (fixtures are `.diff`/`.md`, not compiled), `noEmit: true`.

**File**: `packages/code_reviewer/.env.example`, `packages/code_reviewer/.gitignore`

**Intent**: Document the one required key; ignore package-local generated output.

**Contract**: `.env.example` → `ANTHROPIC_API_KEY=` (and optional `REVIEW_MODEL=` documented as override). `.gitignore` → `output/`. (`.env` and `node_modules/` are already covered by root rules.)

**File**: `packages/code_reviewer/README.md`

**Intent**: How to install, configure, run, and what the agent can and cannot do (no tools, no settings, diff-only).

**Contract**: sections Setup / Run / Output shape / Isolation. States explicitly that each run spends API credit.

#### 3. SDK docs

**File**: `packages/code_reviewer/docs/*.md`

**Intent**: Keep the SDK material this package depends on, fetched through Context7 (`/websites/code_claude_en_agent-sdk`), for future sessions.

**Contract**: one file per topic — `overview-and-quickstart.md`, `query-options.md` (TypeScript options incl. `tools` vs `allowedTools` vs `disallowedTools`, `settingSources`, `systemPrompt`, `maxTurns`, `model`, `env`), `permissions.md`, `structured-outputs.md`, `messages-and-errors.md` (result subtypes, throw-after-error, cost, session id), plus `docs/README.md` indexing them with the Context7 library ID, SDK version (`0.3.270`), and fetch date. Each file cites its source URL.

### Success Criteria:

#### Automated Verification:

- Package installs cleanly: `npm ci` in `packages/code_reviewer`
- Root typecheck still passes and does not see the package: `npm run typecheck` (root)
- Root lint still passes and does not lint the package: `npm run lint` (root)
- Root Astro check still passes: `npm run typecheck:astro` (root)
- Root lockfile unchanged: `git diff --exit-code package-lock.json` (root)

#### Manual Verification:

- Docs in `packages/code_reviewer/docs/` are readable and cover the five topics with source URLs
- README setup steps make sense to someone who hasn't seen this plan

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 2: Reviewer Agent

### Overview

Implement the review as pure, testable modules plus one `query()` call site and a CLI entry.

### Changes Required:

#### 1. Findings schema

**File**: `packages/code_reviewer/src/schema.ts`

**Intent**: Single source of truth for the report shape the model must return; the JSON Schema sent to the SDK is derived from it.

**Contract**: `ReviewOutput` zod object — `verdict: enum("approve", "request_changes", "comment")`, `summary: string`, `findings: array(Finding)`; `Finding` — `file: string`, `line: int` (optional), `severity: enum("critical", "major", "minor", "nit")`, `title: string` (short label), `explanation: string`, `failureScenario: string` (concrete input → wrong output). Export `reviewOutputJsonSchema = z.toJSONSchema(ReviewOutput, { target: "draft-7" })` and the inferred types.

#### 2. Prompt

**File**: `packages/code_reviewer/src/prompt.ts`

**Intent**: The reviewer's system prompt and a builder that wraps a diff into the user prompt.

**Contract**: `SYSTEM_PROMPT: string` — review for correctness bugs only in the diff's changed lines, report only defects with a concrete failure scenario, no style nits unless they cause bugs, empty `findings` + `approve` is a valid answer, output must match the schema. `buildReviewPrompt(diff: string): string` — embeds the diff inside a clearly delimited block so diff content cannot be read as instructions.

#### 3. Config guard

**File**: `packages/code_reviewer/src/config.ts`

**Intent**: Fail fast, for free, before any SDK call.

**Contract**: `loadConfig(argv: string[], env: Record<string, string | undefined>)` → `{ ok: true, diffPath, model | undefined, outDir } | { ok: false, message }`. Errors: missing diff path argument, missing/empty `ANTHROPIC_API_KEY`. Pure — reads nothing from disk; the CLI checks the file exists and is non-empty.

#### 4. Result interpretation

**File**: `packages/code_reviewer/src/result.ts`

**Intent**: Turn the SDK's result message into an outcome without touching the SDK process — the part where "it ran" and "it worked" get confused.

**Contract**: `interpretResult(message)` → `{ kind: "ok", output: ReviewOutput, meta } | { kind: "invalid-output", issues, meta } | { kind: "agent-error", subtype, meta }`. `ok` only when `subtype === "success"` **and** `structured_output` passes `ReviewOutput.safeParse`. `meta` carries `costUsd`, `durationMs`, `sessionId`, `numTurns`. Typed against the SDK's exported result-message type (no `any`).

#### 5. Agent call site

**File**: `packages/code_reviewer/src/review.ts`

**Intent**: The one place that calls `query()`.

**Contract**: `runReview({ diff, model? })` → `Promise<ReviewRun>` where `ReviewRun` = interpreted outcome + `initTools: string[]` + `model: string` (from the init message) or `{ kind: "no-result", error }` when the stream throws without a result. Options: `systemPrompt: SYSTEM_PROMPT`, `tools: []`, `permissionMode: "dontAsk"`, `settingSources: []`, `outputFormat: { type: "json_schema", schema: reviewOutputJsonSchema }`, `maxTurns` small (start at 3), `model` only when provided. No `env`, no `cwd`-dependent behavior. See Critical Implementation Details for the two failure channels.

#### 6. CLI

**File**: `packages/code_reviewer/src/cli.ts`

**Intent**: `npm run review -- <diff-file>` entry point.

**Contract**: loads config → reads diff → `runReview` → prints the init tool list and model, the report, and cost to stdout; writes `output/<ISO-timestamp>-<diff-basename>.json` containing `{ verdict, summary, findings, meta: { model, costUsd, durationMs, sessionId, numTurns, tools } }`. Exit codes: `0` ok; `1` config/input error (no SDK call made); `2` agent error, invalid output, or no result. Warns loudly (non-zero exit is not required) if `initTools` contains anything other than `StructuredOutput`.

#### 7. Unit tests

**Files**: `packages/code_reviewer/src/{schema,prompt,config,result}.test.ts`

**Intent**: Cover the pure pieces hermetically — no SDK process, no network, no credits. Oracle is the SDK's documented result contract and this plan's exit-code/report contract, not the implementation.

**Contract**: see Testing Strategy. `review.ts` and `cli.ts` are exercised only by the Phase 3 run.

### Success Criteria:

#### Automated Verification:

- Package typechecks: `npm run typecheck` in `packages/code_reviewer`
- Package unit tests pass: `npm test` in `packages/code_reviewer`
- Missing key fails fast with exit 1 and no SDK call: `npm run review -- fixtures/does-not-matter.diff` with `ANTHROPIC_API_KEY` unset
- Root gates still pass: `npm run typecheck` and `npm run lint` (root)

#### Manual Verification:

- Code review of `review.ts` confirms `tools: []`, `settingSources: []`, `permissionMode: "dontAsk"`, no `env`, and that both failure channels map to exit 2

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 3: Fixture Diff and First Real Run

### Overview

Create a known-answer input, spend one run on it, and record the evidence.

### Changes Required:

#### 1. Fixture

**File**: `packages/code_reviewer/fixtures/planted-bug.diff`

**Intent**: A few-line, LLM-generated unified diff (valid `diff --git` format, one small TypeScript file) containing exactly one deliberately planted, unambiguous correctness bug — e.g. an off-by-one boundary or an inverted condition — with no comment hinting at it.

**Contract**: under ~15 changed lines; applies to a single hypothetical file; the bug is visible from the diff alone (the agent has no repo access).

**File**: `packages/code_reviewer/fixtures/planted-bug.expected.md`

**Intent**: The written-down answer, authored before the run so the run can't shape it.

**Contract**: file + line of the planted bug, what's wrong, a concrete failing input, and what counts as "found" (the finding points at that line or its hunk and describes the same defect; wording and severity may differ). Also lists what would be a false positive worth noting.

#### 2. First run evidence

**File**: `context/changes/code-reviewer/verification/first-run.json` and `context/changes/code-reviewer/verification/first-run.md`

**Intent**: Keep the run's output and the human judgment next to the plan (package `output/` is gitignored).

**Contract**: `first-run.json` — copy of the saved report. `first-run.md` — command run, SDK version, model and tool list from the init message, cost, turns, verdict, and the found / not-found judgment against `expected.md` with any false positives. No API key or account identifiers.

### Success Criteria:

#### Automated Verification:

- The run exits 0: `npm run review -- fixtures/planted-bug.diff` in `packages/code_reviewer`
- The saved report re-validates against the schema (the run's own `safeParse`, reflected in exit 0) and its `meta.tools` contains only `StructuredOutput`
- Package tests and typecheck still pass: `npm test`, `npm run typecheck`

#### Manual Verification:

- The planted bug from `planted-bug.expected.md` appears in `findings`
- Cost per run is recorded and acceptable
- `first-run.md` contains no secrets or account identifiers

**Implementation Note**: This phase spends real API credit. Run once; re-run only if the first attempt fails for a plumbing reason (e.g. `error_max_turns` → raise `maxTurns`), and record every attempt in `first-run.md`.

---

## Testing Strategy

### Unit Tests:

- `schema.test.ts` — one `it.each` over valid reports (empty findings + approve; finding without `line`) and one over invalid ones (unknown severity, missing `failureScenario`, non-integer `line`), each row a different regression; plus the derived JSON Schema is an object schema that requires `verdict` and `findings`.
- `prompt.test.ts` — the built prompt contains the diff verbatim inside the delimiter; a diff containing the delimiter text or "ignore previous instructions" stays inside the block.
- `config.test.ts` — missing diff argument; missing key; empty-string key; happy path carries `REVIEW_MODEL` when set and `undefined` when not.
- `result.test.ts` — `success` + valid `structured_output` → `ok` with meta from the message; `success` + schema-violating output → `invalid-output`; `success` with no `structured_output` → `invalid-output`; `error_max_turns` and `error_max_structured_output_retries` → `agent-error` carrying subtype and cost. Fixtures are hand-built from the SDK's documented result message shape.

### Integration Tests:

- None automated. The single real SDK run in Phase 3 is the integration check, judged manually against `expected.md`.

### Manual Testing Steps:

1. `cd packages/code_reviewer && npm ci && cp .env.example .env`, fill `ANTHROPIC_API_KEY`.
2. `npm run review -- fixtures/planted-bug.diff`; confirm stdout shows a tool list of only `StructuredOutput` and the model.
3. Open the saved `output/*.json`; compare `findings` with `fixtures/planted-bug.expected.md`.
4. Unset the key and re-run; confirm exit 1 and that no cost line is printed.

## Performance Considerations

One short diff, no tools, `maxTurns` ~3: expect seconds and cents per run. Cost is logged on every run from `total_cost_usd`.

## Migration Notes

None. The only edits outside the package are two ignore entries in root `tsconfig.json` and `eslint.config.js`; reverting them plus deleting `packages/code_reviewer/` restores the previous state.

## References

- Change note: `context/changes/code-reviewer/change.md`
- Motivation / future direction: `context/team/opportunity-map.md`, `context/team/mom-test-validation.md`
- SDK docs (Context7): `/websites/code_claude_en_agent-sdk` — *Structured outputs*, *Permissions*, *Modifying system prompts*, *Claude Code features (settingSources)*, *Cost tracking*
- Root isolation points: `tsconfig.json:4`, `eslint.config.js:98-108`, `vitest.config.ts:67,75`
- Node-script ESLint precedent: `eslint.config.js:72-84`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Package Scaffold, Root Isolation, SDK Docs

#### Automated

- [x] 1.1 Package installs cleanly: `npm ci` in `packages/code_reviewer` — b170839
- [x] 1.2 Root typecheck still passes and does not see the package: `npm run typecheck` (root) — b170839
- [x] 1.3 Root lint still passes and does not lint the package: `npm run lint` (root) — b170839
- [x] 1.4 Root Astro check still passes: `npm run typecheck:astro` (root) — b170839
- [x] 1.5 Root lockfile unchanged: `git diff --exit-code package-lock.json` (root) — b170839

#### Manual

- [x] 1.6 Docs in `packages/code_reviewer/docs/` are readable and cover the five topics with source URLs — b170839
- [x] 1.7 README setup steps make sense to someone who hasn't seen this plan — b170839

### Phase 2: Reviewer Agent

#### Automated

- [x] 2.1 Package typechecks: `npm run typecheck` in `packages/code_reviewer`
- [x] 2.2 Package unit tests pass: `npm test` in `packages/code_reviewer`
- [x] 2.3 Missing key fails fast with exit 1 and no SDK call
- [x] 2.4 Root gates still pass: `npm run typecheck` and `npm run lint` (root)

#### Manual

- [x] 2.5 Code review of `review.ts` confirms the lockdown options and failure-channel mapping

### Phase 3: Fixture Diff and First Real Run

#### Automated

- [ ] 3.1 The run exits 0: `npm run review -- fixtures/planted-bug.diff`
- [ ] 3.2 The saved report re-validates against the schema and its `meta.tools` contains only `StructuredOutput`
- [ ] 3.3 Package tests and typecheck still pass

#### Manual

- [ ] 3.4 The planted bug from `planted-bug.expected.md` appears in `findings`
- [ ] 3.5 Cost per run is recorded and acceptable
- [ ] 3.6 `first-run.md` contains no secrets or account identifiers
