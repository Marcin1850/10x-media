# AI Code Review in CI Implementation Plan

## Overview

Turn `packages/code_reviewer` from a correctness-only, one-diff CLI into a five-criteria PR reviewer whose pass/fail verdict is decided in code, wrap it in a composite action, and run it from a separate, **advisory** GitHub Actions workflow on pull requests to `master`. The workflow posts one sticky summary comment and exactly one outcome label (`ai-cr:passed` / `ai-cr:failed` / `ai-cr:skipped` / `ai-cr:error`), re-runs when a human adds `ai-cr:review`, and invalidates a verdict as soon as new commits land. Because this is the first place CI holds a paid LLM key, the plan also writes that exception into `test-plan.md` and the README.

Source requirements: `context/changes/ci-cd-code-review/requirements.md`. Codebase and platform grounding: `context/changes/ci-cd-code-review/research.md`.

## Current State Analysis

- **The package reviews correctness only.** `SYSTEM_PROMPT` forbids style/maintainability findings and speculation (`packages/code_reviewer/src/prompt.ts:4-18`), which excludes criteria 3 and 5 and leaves 2 and 4 incidental.
- **No scores, model-chosen verdict.** `ReviewOutput = { verdict, summary, findings[] }` with an F4 `superRefine` that rejects a verdict contradicting the findings (`src/schema.ts:16-46`). No per-criterion data exists.
- **Input is one diff path.** `loadConfig(argv, env)` reads `argv[0]` only (`src/config.ts:13-28`); `runReview({ diff, model })` and `buildReviewPrompt(diff)` take no title/description (`src/review.ts:24`, `src/prompt.ts:24`).
- **CI-hostile I/O.** Progress lines and the report JSON both go to stdout (`src/cli.ts:40,45-46,56,89,95`); the report file name is timestamped (`src/cli.ts:91-94`); oversize/empty/hunkless diffs share exit 1 with a missing API key (`src/cli.ts:29-38`).
- **No spend controls.** `MAX_TURNS = 3` is hard-coded (`src/review.ts:9`) and was fully used on a 15-line fixture (`context/changes/code-reviewer/verification/first-run.md`); no `maxBudgetUsd`; model unpinned.
- **CI side is a clean slate.** `.github/workflows/ci.yml` is the only file under `.github`: no `permissions:`, `concurrency:`, labels, `gh` usage, or package install/test. Root tooling ignores `packages/` (`tsconfig.json:4`, `eslint.config.js:100-102`).
- **Policy conflicts.** `context/foundation/test-plan.md` §4 (LLM judge row: "never as a merge gate, never in CI, and never before the judge has been calibrated") and §7 ("CI holds no such keys and must never need them") both need a scoped, written exception.
- **Sequencing.** The package exists only on the `code-reviewer` branch; `pull_request` runs the reviewer from the PR's merge commit, so package + workflow ship in one PR that reviews itself.

## Desired End State

On a same-repo, non-draft PR to `master` (not Dependabot):

- **Opened / reopened / ready_for_review** → one paid review. The PR gets a sticky comment (summary, a five-row score table with rationales, findings grouped by severity and criterion, model, cost, turns, reviewed SHA) and exactly one of:
  - `ai-cr:passed` (green) — every score ≥ 6 **and** no critical/major finding;
  - `ai-cr:failed` (red) — any score < 6 **or** any critical/major finding;
  - `ai-cr:skipped` (grey) — no reviewable diff (empty, > 200 KB, binary/rename/mode-only); no API call made;
  - `ai-cr:error` (yellow) — config error, agent error, invalid output, lockdown failure, budget or turn cap hit. The job goes red **only** in this case.
- **New push (`synchronize`)** → no review; all four outcome labels removed; the sticky comment is marked outdated with a hint to add `ai-cr:review`. A review still in flight for the previous head is cancelled, and even if it finishes it applies no label to a head it didn't review.
- **Human adds `ai-cr:review`** → one review (drafts included), and `ai-cr:review` is removed at the end of every run, including errors and cancellations.
- Fork PRs, Dependabot PRs, closed PRs, and any other label event → the review job is skipped; nothing is spent.
- The workflow is **not** a required check; `ci.yml` and `deploy` are untouched. `ANTHROPIC_API_KEY` reaches exactly one step's `env:`.

Verify by: package `npm test` + `npm run typecheck` green; `actionlint`-clean YAML; and a live pass on the introducing PR covering review, push-invalidation, retry label, and one forced error — recorded in `context/changes/ci-cd-code-review/verification/`.

### Key Discoveries:

- The F4 pattern (`src/schema.ts:25-46`) is the precedent for "rules in code": this plan goes one step further and removes `verdict` from the model's schema entirely — `decideResult()` computes it — so no model self-contradiction can ever become invalid output or a wrong label.
- JSON Schema constraints (`minimum`/`maximum`, integer, enums) are enforced by the SDK's structured-output retry; zod `superRefine` failures are local and **not** retried (`src/schema.ts:48-54`). Hence: keep invariants that the model must satisfy in the JSON Schema, keep decisions in code, add no new refinements.
- `maxBudgetUsd` → `subtype: "error_max_budget_usd"` (`packages/code_reviewer/docs/query-options.md:140`, `docs/messages-and-errors.md:52,129`); `interpretResult` already maps any non-success subtype to `agent-error` (`src/result.ts:55-63`), so no new result branch is needed.
- `review.ts` deliberately passes no `env` option (`src/review.ts:41`): `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` must be set in the **step's** environment, which the SDK subprocess inherits (closes impl-review F1 on runners without touching the lockdown).
- `ci.yml` conventions to mirror: step-level `env:` for secrets (`ci.yml:34-36`), `id:` + `$GITHUB_OUTPUT` (`ci.yml:120-130`), why-comments on non-obvious steps, major-tag action pins.

## What We're NOT Doing

- **No merge gate.** No required check, no branch protection change, no edit to `ci.yml` or `deploy`'s `needs`.
- **No automatic re-review on push.** `synchronize` only invalidates; re-review is human-triggered via `ai-cr:review`.
- **No repository reads by the agent.** It stays tool-less (`["StructuredOutput"]` lockdown unchanged); CLAUDE.md / `test-plan.md` are not passed in and are no longer referenced by the rubric (requirements.md edited accordingly). Repo anchors (`cn()`, `astro:env`, `reporting.ts`, RLS/revoke rules, two-sided e2e oracle) live as prose in the prompt.
- **No truncation of oversized diffs** — they are skipped, never partially reviewed.
- **No path filtering** — docs-only and `context/**` PRs are reviewed like any other.
- **No fork / Dependabot / `pull_request_target` support.**
- **No SHA-pinning** of actions (repo convention is major tags); no PAT or GitHub App token.
- **Parked criteria** (business alignment, architectural fit) stay out.
- **No calibration tooling** — calibration is a manual, recorded comparison in Phase 4; the label stays advisory regardless of its outcome.
- **No package tests in `ci.yml`** — they run inside the composite action before the paid call.
- **No token `usage` reporting** — cost comes from `total_cost_usd` as today.

## Implementation Approach

Build inside-out so every layer is testable before the next one depends on it: first the pure review contract (schema, decision rule, prompt, config), then the CLI's CI-facing I/O and renderers, then the YAML that only orchestrates files and exit codes, then the policy docs and a live, recorded verification. The package keeps its "fail closed, distinct outcomes" architecture; the workflow carries that distinction all the way to the PR as four non-overlapping labels.

## Critical Implementation Details

- **Timing & lifecycle — push during a running review.** Both workflow jobs (`review`, `invalidate`) share `concurrency: ai-cr-${{ github.event.pull_request.number }}` with `cancel-in-progress: true`, set at **job** level so skipped jobs (unrelated labels) never cancel a live review. As a second guard, before applying any outcome label the `review` job compares the SHA it reviewed (`github.event.pull_request.head.sha`) with the PR's current head (`gh pr view --json headRefOid`); on mismatch it posts the comment marked outdated and applies no outcome label. The `ai-cr:review` removal step is `if: always()`, which also runs on cancellation.
- **Script injection inside the composite action.** `${{ inputs.* }}` in a composite `run:` is interpolated into the script exactly like `${{ github.event.* }}`. Every input — title especially — must be mapped through the step's `env:` and referenced as a quoted shell variable. The PR body is written to a file in the workflow via `env:` (`body` is `null` when empty → `|| ''`) and passed by path.
- **Exit-code contract (package ↔ action).** `0` = review completed (report says `passed`/`failed`), `1` = config error (e.g. missing key), `2` = agent/output/lockdown/budget/turns error, `3` = input refused (skip, no spend). The action maps `0 → report.result`, `3 → skipped`, anything else → `error`. A missing secret must never read as "skipped".
- **Labels are created idempotently each run** (`gh label create … --force`, colors `0E8A16` passed, `B60205` failed, `BFBFBF` skipped, `FBCA04` error); removing an absent label must be tolerated. Job permissions: `contents: read`, `pull-requests: write`, `issues: write` (label creation is a repo-labels endpoint).

## Phase 1: Review contract (package, pure)

### Overview

Change what the model is asked for and how its answer becomes a verdict: five scored criteria, criterion-tagged findings, a code-decided `passed`/`failed`, a rubric-carrying prompt with delimited title and description, and configurable turns/budget. Everything here is pure and unit-tested; no CLI or YAML changes yet.

### Changes Required:

#### 1. Output schema

**File**: `packages/code_reviewer/src/schema.ts` (+ `schema.test.ts`)

**Intent**: Replace the model-chosen verdict with per-criterion scores and tag each finding with the criterion it belongs to, so a verdict can be computed rather than trusted.

**Contract**:
- `Criterion = "correctness" | "security" | "idiomaticity" | "testCoverage" | "maintainability"`.
- `CriterionScore = { score: int 1..10, rationale: string }` — bounds expressed in the JSON Schema (`z.int().min(1).max(10)`) so the SDK's structured-output retry enforces them.
- `ReviewOutput = { summary: string, scores: Record<Criterion, CriterionScore> (all five keys required), findings: Finding[] }` — **no `verdict` field**.
- `Finding` gains `criterion: Criterion`; other fields unchanged.
- The F4 `superRefine` and `expectedVerdict` are removed (their job moves to `decideResult`); `reviewOutputJsonSchema` is generated from the plain shape as today.
- Tests: a score of 0 / 11 / 5.5 is rejected; a missing criterion key is rejected; a finding without `criterion` is rejected; the generated JSON Schema carries `minimum: 1`, `maximum: 10` and all five required keys.

#### 2. Decision rule

**File**: `packages/code_reviewer/src/decision.ts` (new) + `decision.test.ts`

**Intent**: The single place that turns a schema-valid review into the PR outcome, so the label never depends on the model agreeing with itself.

**Contract**:
- `PASS_MIN_SCORE = 6` (inclusive: 6 passes), `BLOCKING_SEVERITIES = ["critical", "major"]`.
- `decideResult(output: ReviewOutput): { result: "passed" | "failed"; reasons: string[] }` — `failed` iff any score `< PASS_MIN_SCORE` or any finding has a blocking severity; `reasons` names each failing criterion/score and each blocking finding title (rendered in the comment).
- `it.each` rows, each catching a distinct regression: all 6s → passed (inclusive threshold); `[9,9,9,9,4]` → failed (min, not mean); all 7s + one `major` → failed (severity independent of scores); all 10s + only `minor`/`nit` → passed; one `critical` in `idiomaticity` → failed (severity independent of criterion). Expected values come from the requirement text, not the implementation.

#### 3. Prompt rewrite

**File**: `packages/code_reviewer/src/prompt.ts` (+ `prompt.test.ts`)

**Intent**: Carry the five-criteria rubric and the repo-specific anchors from `requirements.md` in the system prompt, and add the PR title and description as separately delimited untrusted input.

**Contract**:
- `SYSTEM_PROMPT` rewritten: role (independent reviewer of one PR, no repository access), the five criteria each with its definition and its 1 / 10 anchors taken from `requirements.md` §Code Review Criteria, scoring guidance (score only what the diff shows; say so in the rationale when a criterion is barely touched, rather than inventing risk), finding rules (concrete `failureScenario`, `criterion` tag, severity meaning), and the untrusted-input rule covering all three blocks. The old "no style / no maintainability" rules are removed.
- `buildReviewPrompt({ diff, title, body }: { diff: string; title: string; body: string }): string` — three blocks with their own open/close markers (`<<<PR_TITLE_BEGIN>>>`…, `<<<PR_DESCRIPTION_BEGIN>>>`…, `<<<DIFF_BEGIN>>>`…); **every** marker is defused in **every** block (a description containing `<<<DIFF_END>>>` must not close anything).
- `MAX_BODY_CHARS = 8_000`; a longer body is cut and followed by a visible `[description truncated at 8000 characters]` note inside its block; an empty body renders an explicit "(no description)".
- Tests: each criterion name and at least one anchor per criterion appear in `SYSTEM_PROMPT`; the forbidden-style sentence is gone; each block has exactly one open and one close marker even when title/body/diff contain all six markers; body truncation at 8000 with the note, no note at 8000 exactly; empty body placeholder.

#### 4. Run options and config

**File**: `packages/code_reviewer/src/config.ts` (+ `config.test.ts`), `src/review.ts`

**Intent**: Make turns and spend cap configurable from the environment, and thread title/body into the run.

**Contract**:
- `loadConfig` additionally reads `REVIEW_MAX_TURNS` (positive integer, default **5**) and `REVIEW_MAX_BUDGET_USD` (positive number, optional; unset → no cap). Invalid values are a config error (`ok: false`), not silently defaulted.
- `runReview({ diff, title, body, model, maxTurns, maxBudgetUsd })` passes `maxTurns` and, when set, `maxBudgetUsd` to `query()` options; lockdown options and the "no `env`" rule unchanged. `MAX_TURNS` constant removed.
- Tests: default turns 5; `REVIEW_MAX_TURNS=0`, `abc`, `2.5` rejected; `REVIEW_MAX_BUDGET_USD=1.00` parsed, `-1`/`abc` rejected, unset → `undefined`.
- `.env.example` documents both new variables.

### Success Criteria:

#### Automated Verification:

- Package unit tests pass: `cd packages/code_reviewer && npm test`
- Package typecheck passes: `cd packages/code_reviewer && npm run typecheck`
- Root gates unaffected: `npm run lint` and `npm run typecheck` (root)

#### Manual Verification:

- Read the rewritten `SYSTEM_PROMPT` against `requirements.md`: every criterion's definition and both anchors are represented, and nothing references CLAUDE.md or `test-plan.md`
- `decision.test.ts` rows read as the pass/fail rule you agreed to (min score ≥ 6 inclusive, critical/major always fails)

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 2: CLI for CI (package I/O)

### Overview

Give the CLI a machine-readable contract: named inputs, predictable output paths, progress logs moved to stderr so stdout is JSON-only, a distinct "skipped" exit code, and markdown for all three comment shapes. Verified with one paid local run on the planted-bug fixture.

### Changes Required:

#### 1. CLI arguments

**File**: `packages/code_reviewer/src/config.ts` (+ `config.test.ts`)

**Intent**: Accept everything the action needs without shell-quoting large or untrusted text through argv.

**Contract**:
- Usage: `npm run review -- <diff-path> [--title <text>] [--body-file <path>] [--report <path>] [--markdown <path>]`. Parsed with `node:util` `parseArgs` (strict; unknown flag → config error).
- `title` defaults to `""`; `bodyPath`, `reportPath`, `markdownPath` optional. Without `--report`, the timestamped file under `output/` is kept (local use unchanged).
- Tests: positional-only invocation still valid; each flag parsed; unknown flag rejected; missing diff path still rejected.

#### 2. Outcome rendering

**File**: `packages/code_reviewer/src/render.ts` (new) + `render.test.ts`

**Intent**: Pure markdown for the sticky PR comment in all outcomes, so the YAML only moves files.

**Contract**:
- `STICKY_MARKER = "<!-- ai-cr:sticky -->"`, always the first line.
- `renderReview(report, decision, { reviewedSha? })` — heading with result emoji + `passed`/`failed`, `reasons` when failed, summary, score table (criterion · score · rationale), findings grouped critical → nit with criterion, file:line, title, explanation, failure scenario; footer with model, cost, turns, reviewed SHA, and "advisory — not a merge gate; add `ai-cr:review` to re-run".
- `renderSkipped(reason)` and `renderError(reason)` — marker, heading, one-line reason, retry hint. Error reasons never include the API key or raw env.
- `MAX_COMMENT_CHARS = 60_000` (under GitHub's 65,536): when exceeded, findings are dropped from the lowest severity up and a "N findings omitted — see the workflow run's step summary" line is added; marker, heading, score table and footer always survive.
- Tables escape `|` and newlines in model text.
- Tests: marker on line 1 for all three renderers; oversize report stays ≤ 60,000 and keeps the score table and footer; a rationale containing `|` and `\n` does not break the table row; findings order by severity.

#### 3. CLI flow and exit codes

**File**: `packages/code_reviewer/src/cli.ts`, `src/diff-input.ts`

**Intent**: Separate "nothing to review" from "misconfigured", write outputs to the requested paths in every outcome, and keep stdout parseable.

**Contract**:
- Exit codes: `EXIT_OK = 0`, `EXIT_CONFIG = 1`, `EXIT_AGENT = 2`, new `EXIT_SKIPPED = 3` for every `checkDiffFile`/`checkDiffText` refusal (empty, oversize, not-a-diff, no hunks). Header comment and README table updated.
- All progress/diagnostic lines go to **stderr**; stdout carries only the final report JSON on exit 0.
- Reads the body file if given (missing file → config error); passes `title`/`body` and config turns/budget to `runReview`.
- On exit 0: report JSON = `{ ...output, result, reasons, meta }` written to `--report` (or the timestamped default); markdown from `renderReview` written to `--markdown` if given.
- On exit 3: `renderSkipped` to `--markdown`. On exit 1/2: `renderError` to `--markdown` when the markdown path itself is known (best effort; a failure to write it must not mask the original exit code).
- `review.ts`/`cli.ts` wiring stays untested by unit tests (as today); verified by the manual runs below.

#### 4. Package README

**File**: `packages/code_reviewer/README.md`

**Intent**: Replace "no git hooks, no CI" with the CI usage, the flag list, the four exit codes, the five criteria + decision rule, and the two new env variables.

**Contract**: Sections affected: intro statement, usage, exit-code table, output shape, configuration.

### Success Criteria:

#### Automated Verification:

- Package unit tests pass: `cd packages/code_reviewer && npm test`
- Package typecheck passes: `cd packages/code_reviewer && npm run typecheck`
- Skip path exits 3 with no spend: `npm run review -- <empty-file> --markdown out.md; echo $?` → `3`, `out.md` starts with the sticky marker
- Missing key exits 1: running with `ANTHROPIC_API_KEY=` → `1`

#### Manual Verification:

- One paid local run: `npm run review -- fixtures/planted-bug.diff --title "…" --report r.json --markdown r.md` with `REVIEW_MODEL=claude-sonnet-5 REVIEW_MAX_BUDGET_USD=1` → exit 0, `r.json` has five scores + `result`, the planted bug appears as a critical/major finding and `result` is `failed`; `r.md` renders correctly in a GitHub markdown preview; stdout is only JSON
- Forced budget error: same run with `REVIEW_MAX_BUDGET_USD=0.001` → exit 2 and an error markdown
- Cost and turns of the paid run noted (expected well under $1, ≤ 5 turns)

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 3: Composite action + workflow

### Overview

Add the orchestration: a composite action that installs, self-tests and runs the reviewer and reports a single `result`, and a workflow that gates which events pay for a review, publishes the comment and labels, and invalidates verdicts on push.

### Changes Required:

#### 1. Composite action

**File**: `.github/actions/ai-code-review/action.yml` (new)

**Intent**: Everything needed to go from "a diff and PR text on disk" to "an outcome and a markdown file", so the workflow reads as trigger → review → publish.

**Contract**:
- `inputs`: `anthropic-api-key` (required), `diff-path`, `title`, `body-path`, `model` (default `claude-sonnet-5`), `max-budget-usd` (default `1.00`), `max-turns` (default `5`).
- `outputs`: `result` (`passed|failed|skipped|error`), `markdown-path`, `report-path` — each with `value: ${{ steps.<id>.outputs.* }}`.
- Steps (all `shell: bash`, `working-directory: ${{ github.workspace }}/packages/code_reviewer` — the action and the package ship together in one checkout):
  1. `actions/setup-node@v5`, `node-version: 22`, `cache: npm`, `cache-dependency-path: packages/code_reviewer/package-lock.json`.
  2. `npm ci` (never `--omit=optional` — the SDK's native binary is an optional dependency).
  3. `npm run typecheck` and `npm test` — a broken reviewer fails here, before any spend (surfaces as `error` via the mapping step).
  4. Review step: `ANTHROPIC_API_KEY`, `PR_TITLE`, `REVIEW_MODEL`, `REVIEW_MAX_BUDGET_USD`, `REVIEW_MAX_TURNS`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` via step `env:` only; runs the CLI with `--report "$RUNNER_TEMP/ai-cr/report.json" --markdown "$RUNNER_TEMP/ai-cr/comment.md"`, captures the exit code without failing the step, maps it (0 → `result` read from the report JSON with `node -p`; 3 → `skipped`; else → `error`), writes outputs to `$GITHUB_OUTPUT`, and appends the markdown to `$GITHUB_STEP_SUMMARY`.
  5. If the markdown file does not exist after a failure in steps 2–3 (`if: failure()` path), write a minimal error markdown so publishing still has a body, and set `result=error`.
- Why-comments on: inputs-through-`env:`, no `--omit=optional`, tests-before-spend, exit-code mapping.

#### 2. Review workflow

**File**: `.github/workflows/ai-code-review.yml` (new)

**Intent**: Decide which PR events get a paid review, run the action, publish exactly one outcome, and keep labels truthful when the code changes.

**Contract**:
- `on: pull_request: branches: [master], types: [opened, reopened, ready_for_review, synchronize, labeled]`.
- Top-level `permissions: { contents: read }`.
- **Job `review`**:
  - `if:` same-repo (`github.event.pull_request.head.repo.full_name == github.repository`) **and** `github.event.pull_request.user.login != 'dependabot[bot]'` **and** `github.event.pull_request.state == 'open'` **and** ( (`action` ∈ opened/reopened/ready_for_review **and** not draft) **or** (`action == 'labeled'` **and** `github.event.label.name == 'ai-cr:review'`) ).
  - `permissions: { contents: read, pull-requests: write, issues: write }`, `timeout-minutes: 15`, job-level `concurrency` as in Critical Implementation Details.
  - Steps: ensure the five labels exist (`--force`) → remove the four outcome labels → `actions/checkout@v5` with `fetch-depth: 2`, `persist-credentials: false` → write `github.event.pull_request.body || ''` via `env:` to `$RUNNER_TEMP/pr-body.md` → `git diff HEAD^1 HEAD > $RUNNER_TEMP/pr.diff` → `uses: ./.github/actions/ai-code-review` with `anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}` and title via `github.event.pull_request.title` → publish (`if: always()`): head-SHA check, upsert the sticky comment (find the comment whose body starts with `<!-- ai-cr:sticky -->` via `gh api --paginate`, PATCH it or POST a new one), add `ai-cr:<result>` only if the head still matches → remove `ai-cr:review` (`if: always()`, tolerate absent) → final step fails the job when `result == 'error'` (or the action step did not produce a result).
  - `GH_TOKEN: ${{ github.token }}` only on `gh` steps.
- **Job `invalidate`**:
  - `if:` same-repo, not Dependabot, `action == 'synchronize'`.
  - `permissions: { pull-requests: write, issues: write }`, same job-level `concurrency` group (cancels an in-flight review), `timeout-minutes: 5`, no checkout, no secrets.
  - Steps: remove the four outcome labels (tolerate absent); if a sticky comment exists, PATCH it to prepend `> ⚠️ Outdated — commits were pushed after this review (now at <short sha>). Add the \`ai-cr:review\` label to re-run.` directly below the marker (replacing an earlier outdated banner rather than stacking them).
- Why-comments on: the label filter, the fork/Dependabot guard, `GITHUB_TOKEN` label edits not re-triggering runs, job-level concurrency, the head-SHA check, the paid-key exception pointer to test-plan §7.

### Success Criteria:

#### Automated Verification:

- Workflow and action lint clean: `npx --yes actionlint` (or the `rhysd/actionlint` Docker image) over `.github/`
- No `${{ github.event.pull_request.title/body }}` or `${{ inputs.* }}` inside any `run:` block: `grep -nE 'run:.*\$\{\{ *(github\.event|inputs)\.' -r .github` returns nothing (and multi-line `run: |` blocks checked the same way)
- `ANTHROPIC_API_KEY` referenced exactly once across `.github/`: `grep -rn 'ANTHROPIC_API_KEY' .github`
- Package tests still pass: `cd packages/code_reviewer && npm test`

#### Manual Verification:

- Read-through of both YAML files against the Desired End State event matrix (opened, draft opened, ready_for_review, synchronize, `ai-cr:review` added, other label added, fork) — each row maps to the intended job/skip
- Confirm the `review` job's publish and label-removal steps run on `failure()` and cancellation paths (`if: always()`)

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 4: Policy docs + live verification

### Overview

Write down the scoped exception to the "no paid keys in CI" and "no LLM judge in CI" rules, document the workflow for operators and contributors, then prove the whole loop on the introducing PR and record a first calibration pass.

### Changes Required:

#### 1. Test plan exception

**File**: `context/foundation/test-plan.md`

**Intent**: Keep the hard rules true for the product's test suites while recording the one advisory exception and its limits.

**Contract**:
- §4 LLM-as-judge row: add a note that the AI code review is a **PR reviewer, not a product-quality judge**, runs in CI as advisory only, and is not a merge gate; its calibration record lives in this change's `verification/`.
- §5 Quality Gates: new row `AI code review | CI on PR (separate workflow) | advisory — never required | a second-reader signal on the five criteria; not a gate`.
- §7 first bullet: scoped exception — the `ai-code-review` workflow holds `ANTHROPIC_API_KEY` in one step; no product test (unit, integration, e2e) ever holds or needs it; spend bounded by pinned model, turn cap and `maxBudgetUsd`.

#### 2. Root README

**File**: `README.md`

**Intent**: Operators and contributors can find what the review does, what each label means, how to retry, what it costs, and how to set or remove the key.

**Contract**:
- CI section: new bullet for the `ai-code-review` workflow (separate file, advisory, triggers, four labels + `ai-cr:review`, push invalidates, skipped for forks/Dependabot/drafts, not in `deploy`'s `needs`).
- Required repository secrets table: `ANTHROPIC_API_KEY` — "AI code review step (`ai-code-review` workflow) **only**", with a note to use a workspace-scoped key with a spend limit; rollback = delete the secret (reviews then end as `ai-cr:error`) or disable the workflow.
- Project Structure: `packages/code_reviewer/` and `.github/actions/` entries.

#### 3. Agent rule mirrors

**File**: `CLAUDE.md`, `AGENTS.md` (gitignored, byte-identical except lines 1 and 3)

**Intent**: Keep agent-facing CI description accurate; edits stay local by design.

**Contract**: The `CI (.github/workflows/ci.yml)` paragraph gains one sentence naming the separate advisory `ai-code-review` workflow and that it is the only place CI holds a paid LLM key. Apply identically to both files.

#### 4. Verification record

**File**: `context/changes/ci-cd-code-review/verification/live-run.md` (new)

**Intent**: Evidence of each outcome path on real GitHub, plus a first calibration comparison.

**Contract**: One row per scenario (event, expected, observed label/comment, run link, cost). A calibration table: for each reviewed PR, the five model scores and result vs. your own 1–10 ratings and pass/fail, with a one-line note on disagreements. No account identifiers (lessons.md: public repo).

### Success Criteria:

#### Automated Verification:

- Root gates pass: `npm run lint`, `npm run typecheck`, `npm test`
- Package gates pass: `cd packages/code_reviewer && npm test && npm run typecheck`
- `ci.yml` unchanged: `git diff master -- .github/workflows/ci.yml` is empty

#### Manual Verification:

- Operator sets the secret in their own terminal: `gh secret set ANTHROPIC_API_KEY` (workspace-scoped key, spend limit configured in the Anthropic console)
- Opening the PR from this branch triggers `review`; the sticky comment and exactly one outcome label appear; `ci`/`integration`/`e2e` run as before
- Pushing a commit removes the outcome label and marks the comment outdated without a paid run
- Adding `ai-cr:review` runs a review and the label is removed afterward
- Adding an unrelated label starts no review
- Forced error (temporary commit setting `max-budget-usd: 0.001`, then reverted + re-run) yields `ai-cr:error`, a red job, an error comment — never `ai-cr:failed`
- Calibration: your own scores recorded for at least the self-review plus one other PR; disagreements noted in `verification/live-run.md`

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Testing Strategy

### Unit Tests:

- `decision.test.ts` — the pass/fail rule (inclusive threshold, min not mean, severity independent of score and criterion).
- `schema.test.ts` — score bounds and integer-ness, required criteria, `criterion` on findings, JSON Schema carries the bounds.
- `prompt.test.ts` — rubric completeness, cross-block marker defusing, body cap and placeholder.
- `config.test.ts` — flags, env parsing for turns/budget, invalid values rejected.
- `render.test.ts` — sticky marker, size cap preserving the table and footer, table escaping, severity ordering.

### Integration Tests:

- None automated: the paid boundary is deliberately not exercised by any test (test-plan §7). Wiring (`cli.ts`, `review.ts`, YAML) is verified by the recorded manual runs in Phases 2 and 4.

### Manual Testing Steps:

1. Local paid run on `fixtures/planted-bug.diff` → `failed` with the planted bug as critical/major.
2. Local skip (empty file) → exit 3, no spend; local budget error → exit 2.
3. Live PR: open → review; push → invalidation; `ai-cr:review` → rerun + label removed; unrelated label → nothing; forced budget error → `ai-cr:error`.
4. Calibration comparison recorded.

## Performance Considerations

- Per-run cost bounded by `claude-sonnet-5`, `maxTurns: 5`, `maxBudgetUsd: 1.00`; the 200 KB diff cap and 8k description cap bound input tokens.
- `npm ci` of the package downloads the SDK's native binary; the npm cache keyed on the package lockfile keeps repeat runs fast. Job timeout 15 minutes.
- Spend only on opened/reopened/ready_for_review and explicit retry — never on push.

## Migration Notes

- Rollout: merge this PR; no data or runtime migration. The product Worker and `deploy` are unaffected.
- Rollback: delete `ANTHROPIC_API_KEY` (runs end as `ai-cr:error`, no spend) or disable/delete the workflow file; labels can be deleted from the repo afterward.
- The `code-reviewer` change's report format changes (no `verdict`, new `scores`/`result`); earlier saved reports in `output/` are local-only and gitignored.

## References

- Requirements: `context/changes/ci-cd-code-review/requirements.md`
- Research: `context/changes/ci-cd-code-review/research.md`
- Prior change: `context/changes/code-reviewer/plan.md`, `reviews/impl-review.md` (F1, F4), `verification/first-run.md`
- Patterns: `.github/workflows/ci.yml:34-36` (step-level secrets), `:120-130` (`$GITHUB_OUTPUT`), `packages/code_reviewer/src/schema.ts:25-46` (rules in code), `src/result.ts:55-63` (non-success subtypes)
- Policy: `context/foundation/test-plan.md` §4, §5, §7

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Review contract (package, pure)

#### Automated

- [ ] 1.1 Package unit tests pass: `cd packages/code_reviewer && npm test`
- [ ] 1.2 Package typecheck passes: `cd packages/code_reviewer && npm run typecheck`
- [ ] 1.3 Root gates unaffected: `npm run lint` and `npm run typecheck` (root)

#### Manual

- [ ] 1.4 Rewritten `SYSTEM_PROMPT` represents every criterion and both anchors, with no CLAUDE.md / `test-plan.md` references
- [ ] 1.5 `decision.test.ts` rows match the agreed pass/fail rule

### Phase 2: CLI for CI (package I/O)

#### Automated

- [ ] 2.1 Package unit tests pass: `cd packages/code_reviewer && npm test`
- [ ] 2.2 Package typecheck passes: `cd packages/code_reviewer && npm run typecheck`
- [ ] 2.3 Skip path exits 3 with no spend and writes sticky-marker markdown
- [ ] 2.4 Missing key exits 1

#### Manual

- [ ] 2.5 Paid local run on the planted-bug fixture → exit 0, five scores, `failed`, markdown renders, stdout JSON-only
- [ ] 2.6 Forced budget error → exit 2 and error markdown
- [ ] 2.7 Cost and turns of the paid run noted

### Phase 3: Composite action + workflow

#### Automated

- [ ] 3.1 Workflow and action lint clean with actionlint
- [ ] 3.2 No `${{ github.event.* }}` / `${{ inputs.* }}` inside any `run:` block
- [ ] 3.3 `ANTHROPIC_API_KEY` referenced exactly once across `.github/`
- [ ] 3.4 Package tests still pass

#### Manual

- [ ] 3.5 Event matrix read-through maps each row to the intended job/skip
- [ ] 3.6 Publish and label-removal steps run on failure and cancellation paths

### Phase 4: Policy docs + live verification

#### Automated

- [ ] 4.1 Root gates pass: `npm run lint`, `npm run typecheck`, `npm test`
- [ ] 4.2 Package gates pass
- [ ] 4.3 `ci.yml` unchanged against `master`

#### Manual

- [ ] 4.4 Operator sets `ANTHROPIC_API_KEY` repository secret
- [ ] 4.5 Opening the PR triggers a review with sticky comment and one outcome label
- [ ] 4.6 Push removes the outcome label and marks the comment outdated without a paid run
- [ ] 4.7 Adding `ai-cr:review` re-runs and the label is removed afterward
- [ ] 4.8 Unrelated label starts no review
- [ ] 4.9 Forced budget error yields `ai-cr:error` and a red job, never `ai-cr:failed`
- [ ] 4.10 Calibration comparison recorded in `verification/live-run.md`
