---
date: 2026-09-14T21:57:22+02:00
researcher: Claude (Opus 5) for Marcin Drobiecki
git_commit: 59be923d10fd46c3f0aa2d3d8c5c01248deeaed4
branch: code-reviewer
repository: Marcin1850/10x-media
topic: "CI/CD workflow for automated PR code review using packages/code_reviewer (requirements.md)"
tags: [research, ci, github-actions, composite-action, code-reviewer, claude-agent-sdk, labels, pr-comment]
status: complete
last_updated: 2026-09-14
last_updated_by: Claude (Opus 5)
---

# Research: CI/CD workflow for automated PR code review using `packages/code_reviewer`

**Date**: 2026-09-14T21:57:22+02:00
**Researcher**: Claude (Opus 5) for Marcin Drobiecki
**Git Commit**: 59be923d10fd46c3f0aa2d3d8c5c01248deeaed4
**Branch**: code-reviewer (7 commits ahead of `origin/master`; `packages/` does not exist on `master` yet)
**Repository**: Marcin1850/10x-media (public)

## Research Question

What does it take to implement `context/changes/ci-cd-code-review/requirements.md`? The requirements ask for:
- a GitHub Actions workflow on every PR to `master`, with the review itself in a composite action;
- inputs: PR title, PR description (a cost tradeoff is flagged) and the git diff;
- five criteria, each scored 1–10: implementation correctness, security & safety, idiomaticity, test/risk coverage, complexity & maintainability;
- a PR comment with a summary, the label `ai-cr:passed` or `ai-cr:failed`, and a re-run when `ai-cr:review` is added.

The research covers what already exists in `packages/code_reviewer`, the CI conventions the workflow must fit, earlier decisions, and the GitHub Actions and Agent SDK facts that constrain the design.

## Summary

1. **The reviewer package works, but it does not match the requirements yet.**
   - It is a locked-down, tool-less Agent SDK CLI. It reads **one diff file path**. It has **no title or description input**, **no scores**, and a prompt that **explicitly excludes** style and maintainability.
   - Its output is `verdict | summary | findings[]`, and stdout mixes that JSON with log lines. There is no markdown renderer.
   - Four of the five criteria are missing or excluded. Most of this change is **package work** (schema, prompt, CLI I/O). The YAML is the smaller part.
2. **The CI side has no conflicts.**
   - `ci.yml` is the only file under `.github`: no actions, labels config, `permissions:` or `concurrency:`.
   - Root tooling (tsc, eslint, vitest) ignores `packages/`, and CI never installs or tests the package.
   - A **separate workflow file** is the right shape. It can widen `GITHUB_TOKEN` (`pull-requests: write`) without touching `ci`/`integration`/`e2e`/`deploy`, and adding `types: [labeled]` there would not re-run the heavy jobs.
3. **The history pushes against this change in two places. The plan must address both explicitly.**
   - **Paid LLM credits in CI.** `test-plan.md` §7 has the hard rule "CI holds no such keys and must never need them". It was written about Supadata and OpenRouter, but the principle applies here too.
   - **LLM judges as merge gates.** `test-plan.md` §4 says "never as a merge gate, never in CI, and never before the judge has been calibrated". The opportunity map says twice "not a CI gate", although that was about a different tool, the Codex review-runner.
   - The natural reconciliation is an **advisory** label, not a required check. The exception and why it exists should be written into test-plan §5/§7 and the README.
4. **Hard platform facts that shape the design:**
   - Fork PRs and Dependabot PRs get **no secrets** on `pull_request`, so the job must skip cleanly rather than fail. `pull_request_target` is unsafe here.
   - Label changes made with `GITHUB_TOKEN` **do not trigger new runs**. The workflow can set pass/fail and remove `ai-cr:review` with no loop, and it **must** remove `ai-cr:review` so a human can add it again.
   - `labeled` fires for **every** label, so filter on the label name.
   - PR title and body must go through `env:`, never `${{ }}` inside `run:`, because of script injection.
   - A local `git diff` avoids the API diff limit (406 `too_large` at 300 files / 20k lines).
   - Comments are capped at 65,536 characters.
5. **Prerequisite:** the `code-reviewer` branch (the package itself) is not merged to `master`. A `pull_request` workflow runs the reviewer from the PR's merge commit, so the package has to reach `master` first, or ship in the same PR.

## Detailed Findings

### 1. `packages/code_reviewer`: current contract

**Invocation and input**
- `npm run review -- <diff-path>` resolves to `tsx --env-file-if-exists=.env src/cli.ts` (`package.json:11`). It must run from the package directory.
- The only argument is `argv[0]`, the diff path (`src/config.ts:14`). There are no flags, no stdin, and no git access (`README.md:42-43`).
- Title and description are not accepted. The signatures are `runReview({ diff, model })` (`src/review.ts:24`) and `buildReviewPrompt(diff)` (`src/prompt.ts:24`).
- **Size cap:** `MAX_DIFF_BYTES = 200_000` (`src/diff-input.ts:7`), checked before the file is read (`src/cli.ts:15-17`). An oversized diff is **refused with exit 1**, not truncated.
- **Shape check** (`src/diff-input.ts:9-10,27-38`): the diff needs a `---`/`+++` header and at least one `@@` hunk. A PR with only binary, rename or mode changes therefore exits 1. The workflow has to map that to "skipped", not "failed".

**Config and auth**
- `ANTHROPIC_API_KEY` is required and must be non-empty (`src/config.ts:19-24`). The SDK reads it from `process.env`.
- `REVIEW_MODEL` is optional (`src/config.ts:26`). **No model is pinned.** When unset, the SDK default is used; the sample run recorded `claude-opus-5[1m]`.
- There is **no `maxBudgetUsd`** and no timeout.
- The output directory `output/` is hard-coded relative to the working directory (`src/config.ts:5`) and gitignored (`packages/code_reviewer/.gitignore:2`).

**Lockdown** (`src/review.ts:30-42`)
- `tools: []`, `permissionMode: "dontAsk"`, `settingSources: []`, JSON-schema output format, `maxTurns: 3` (`src/review.ts:9`).
- No `env` is passed on purpose: it would replace the environment rather than merge into it (`:41`).
- `verifyLockdown` requires the init tool list to be exactly `["StructuredOutput"]`, otherwise the run exits 2 (`src/lockdown.ts:5`, `src/cli.ts:72-75`).
- **Consequence:** the agent reads no repository files. A checkout is needed only to *produce* the diff. It also means the agent cannot see CLAUDE.md or `test-plan.md`, yet the requirements' criteria refer to repo conventions (`cn()`, `astro:env`, `reporting.ts`, the authorization roster). That rubric knowledge has to be **embedded in the prompt**, or selected files have to be deliberately passed as extra delimited input.

**Prompt** (`src/prompt.ts:4-18`)
- "Review ONLY … for correctness bugs"; "Do not report style, naming, formatting, or preference issues unless they cause a bug"; "Do not speculate about code you cannot see."
- These rules directly contradict criteria 3 (idiomaticity) and 5 (complexity & maintainability). The prompt needs a rewrite, not an addition.
- The diff is wrapped in `<<<DIFF_BEGIN>>>`/`<<<DIFF_END>>>`, with markers inside the diff defused (`src/prompt.ts:24-32`). Title and body are equally untrusted and need the same treatment.

**Output schema** (`src/schema.ts:7-46`)
- `ReviewOutput = { verdict: "approve"|"request_changes"|"comment", summary, findings: Finding[] }`.
- `Finding = { file, line?, severity: critical|major|minor|nit, title, explanation, failureScenario }`.
- A `superRefine` enforces verdict ↔ findings consistency (the impl-review F4 fix).
- The JSON Schema sent to the SDK is generated from the unrefined shape.
- The CLI adds `meta { model, costUsd, durationMs, sessionId, numTurns, tools }` (`src/cli.ts:77-87`). Token `usage` is dropped (`src/result.ts:48-53`).

| Requirement criterion | Today |
| --- | --- |
| 1. Implementation correctness | The only thing reviewed; findings by severity, no score |
| 2. Security & safety | Only if it is also a correctness bug |
| 3. Idiomaticity | Explicitly excluded (`prompt.ts:9`) |
| 4. Test/risk coverage | Absent; also needs repo context the agent lacks |
| 5. Complexity & maintainability | Excluded as "style" |

**Results and exit codes** (`src/cli.ts:9-11`, `README.md:61-67`)
- Exit 0 means a schema-valid review **of any verdict** (`request_changes` also exits 0).
- Exit 1 means a config or input error, with no spend.
- Exit 2 means an agent error, invalid output, no result, a lockdown failure, or an unexpected throw.
- stdout mixes progress lines (`cli.ts:40,45-46,56,95`) with the report JSON (`:89`), so it cannot be parsed as-is.
- The report file name is timestamped (`cli.ts:91-94`), so CI cannot predict the path.

**Runtime**
- Node `>=22` (`package.json:8`).
- The SDK bundles the Claude Code binary as a per-platform optional dependency. `package-lock.json:37` lists `@anthropic-ai/claude-agent-sdk-linux-x64` 0.3.270, so `npm ci` on `ubuntu-latest` works, but **not with `--omit=optional`**.
- The Windows binary is about 227 MB, so an npm cache is worthwhile (`cache-dependency-path: packages/code_reviewer/package-lock.json`).
- The SDK is pre-1.0 and pinned with a caret (`^0.3.270`).

**Tests:** `npm test` (vitest) and `npm run typecheck` are hermetic and pure (config, diff-input, lockdown, prompt, result, schema). `review.ts`/`cli.ts` wiring is untested. **CI runs none of them today.**

**Cost and runtime evidence:** one run on a 12–18-line fixture cost **$0.0665**, took **19.3 s**, and used **3 of 3 turns** (`verification/first-run.json`). A richer five-criteria schema plus real PR diffs is likely to hit `error_max_turns` at the current cap.

**Package gaps for CI use:**
1. Title and description inputs, delimited as untrusted (flags or files).
2. A `scores` object with five 1–10 integers, ideally with a rationale per criterion, plus a criterion or category per finding.
3. A **deterministic pass/fail rule** in code, enforced with a `superRefine` like F4. For example: fail if any critical/major finding or any score is below a threshold. It should not be a model-chosen label.
4. A rewritten `SYSTEM_PROMPT` that carries the five-criteria rubric and the repo-specific anchors from requirements.md.
5. A pure `renderMarkdown(report)` covering the summary, a score table, findings, model and cost, truncated under 65,536 characters, with a hidden marker for the sticky comment.
6. Machine-readable output: an `--output <path>` flag and/or JSON-only stdout (logs moved to stderr), and/or `$GITHUB_OUTPUT` keys.
7. An exit-code decision that keeps "review failed" distinguishable from 1 and 2, e.g. keep 0 and carry the verdict in the output.
8. Budget and turns: add `maxBudgetUsd` through env, raise or make `MAX_TURNS` configurable, and handle `error_max_budget_usd`.
9. An oversize / non-text diff policy: truncate, filter files (lockfiles, `docs/` SDK copies), or add an explicit "skipped" outcome.
10. Keep `usage` for cost reporting. Consider `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` (impl-review F1, still open), via a deliberate env merge.
11. README update: it still says "no git hooks, no CI" (`README.md:6-8`).

### 2. Existing CI and repo conventions

**`.github/workflows/ci.yml` (188 lines, the only file in `.github`)**
- Triggers are `push: [master]` and `pull_request: [master]` with default types (`:3-7`).
- **No `permissions:` block and no `concurrency:`.**
- Jobs `ci`, `integration` and `e2e` run in parallel.
- `deploy` has `needs: [ci, integration, e2e]` with `if: github.ref == 'refs/heads/master' && github.event_name == 'push'` (`:145-147`). `needs` only works inside one workflow, so a separate review workflow cannot affect `deploy`.
- `actions/checkout@v5` runs with default depth 1. `actions/setup-node@v5` uses `node-version: 22` and `cache: npm`; it does not use `.nvmrc`.
- Actions are pinned to **major tags, not SHAs**.
- Secrets are only ever referenced in **step-level `env:`**, e.g. `:34-36` and `:178-188`.
- Non-obvious steps carry "why" comments, often citing test-plan sections (e.g. `:28-31`).
- An `id:` + `$GITHUB_OUTPUT` pattern already exists (`:120-130`).
- Failure artifacts are uploaded with `if: failure()` and `retention-days: 7` (`:138-143`).

**Root isolation of `packages/`**
- No npm workspaces. The root lockfile does not include the package, so it needs its own `npm ci`.
- `tsconfig.json:4` excludes `packages`. `eslint.config.js:100-102` ignores `packages/**`. Root `vitest.config.ts` only includes `src/**`. The package's own `vitest.config.ts` stops Vitest walking up to the root config.
- **Leaks:** `.prettierignore` only excludes `context/**`, so `npm run format` and lint-staged's `*.{json,css,md}` rule touch package files and any new `.github/**/*.yml`.
- Husky hooks never test or typecheck the package.

**Security principles already stated in the repo**
- **Secret narrowness:** "`PUBLIC_SENTRY_DSN` reaches the `deploy` job's build step and nothing else, and that narrowness is the point" (README CI section; `ci.yml:167-168`). The Anthropic key should reach only the review step's `env:`.
- **Omission as the guarantee:** tooling is silent because it has no key, not because a flag is off.
- **Fail-closed runners:** Playwright refuses to start if a DSN is set, and the integration suite has a fetch firewall.
- **No paid credits in CI:** `context/foundation/test-plan.md:401`. This change is an exception to that rule and must be documented as one.
- No `gh`, `GITHUB_TOKEN`, `pull_request_target` or label logic exists anywhere in code. The only `gh` usage is operator docs in README (`gh secret set`, `gh run rerun`).

### 3. GitHub Actions platform facts (external docs)

**Composite actions** ([metadata syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/metadata-syntax))
- Declared with `runs.using: composite`.
- `shell` is required on every `run` step.
- `uses:` is allowed inside steps, e.g. for `setup-node`.
- Each output needs a `value:`.
- **The `secrets` context is unavailable.** The API key must be passed as an `input` and mapped to `env:`.
- `${{ github.action_path }}` points at the action's directory.
- A local `uses: ./.github/actions/<name>` needs `actions/checkout` to run first.

**Triggers and forks** ([events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows))
- `pull_request` defaults to `opened|synchronize|reopened`; `labeled` has to be listed.
- `branches:` filters on the **base** branch.
- A PR with merge conflicts does not run `pull_request` workflows.
- **Fork PRs:** no secrets except `GITHUB_TOKEN`, and that token is read-only, so no labels or comments either.
- **Dependabot PRs** behave like forks and only see Dependabot secrets.
- `pull_request_target` has secrets and a write token, but running or checking out PR code there is the "pwn request" pattern.
- **Recommended:** `pull_request` plus a same-repo guard `github.event.pull_request.head.repo.full_name == github.repository`, skipping with a notice.
- `labeled` fires for any label, so use `if: github.event.action != 'labeled' || github.event.label.name == 'ai-cr:review'`.
- *(Inference)* On `pull_request` the reviewer and its prompt come from the PR's merge commit. A PR can therefore change the rubric that reviews it. That is fine for an advisory label, but it is not a trust boundary.

**Diff acquisition**
- `pull_request` checks out `refs/pull/N/merge`. With `fetch-depth: 2`, `git diff HEAD^1 HEAD` is exactly the PR's change against the current base tip. This is an inference from merge-commit parents.
- Alternative: `fetch-depth: 0` + `git diff origin/$BASE_REF...HEAD`.
- `gh pr diff` and `application/vnd.github.diff` return **406 `too_large`** above 300 files or 20,000 lines ([cli/cli#10712](https://github.com/cli/cli/issues/10712)). Anthropic's own security-review action silently reported 0 findings on that error ([claude-code-security-review#80](https://github.com/anthropics/claude-code-security-review/issues/80)).
- Local `git diff` plus the CLI's explicit size refusal is safer.

**Script injection** ([secure use](https://docs.github.com/en/actions/reference/security/secure-use))
- Never interpolate `github.event.pull_request.title/body` into `run:`. Pass them via `env:`.
- `body` is `null` for an empty description, so use `|| ''` and default in the CLI too.
- Write large inputs (diff, body) to files to avoid env and argv size limits.

**Labels** ([gh label create](https://cli.github.com/manual/gh_label_create), [REST labels](https://docs.github.com/en/rest/issues/labels))
- Idempotent creation: `gh label create ai-cr:passed --color 0E8A16 --force`, and `B60205` for red.
- Changing labels: `gh pr edit N --add-label … --remove-label …`. With REST, removing an absent label returns 404, so tolerate it.
- Permissions: `pull-requests: write` or `issues: write` covers labels, and `contents: read`. Add `issues: write` if creation returns 403 (not verified).
- **`GITHUB_TOKEN`-initiated events do not start new workflow runs** ([GITHUB_TOKEN](https://docs.github.com/en/actions/concepts/security/github_token)). So there is no feedback loop, and the retry label must be removed at the end of each run, including on error (`if: always()`). A PAT or App token would bring the loop risk back.

**PR comment**
- `gh pr comment N --body-file f --edit-last --create-if-none` edits the bot's *last* comment, which can collide with any other bot comments.
- More robust: a hidden marker `<!-- ai-cr -->`. Find it via `gh api …/issues/N/comments --paginate`, then PATCH, or POST if absent.
- Body limit is **65,536 characters**.
- `$GITHUB_STEP_SUMMARY` allows 1 MiB per step.

**Concurrency:** use `group: ai-cr-${{ github.event.pull_request.number }}` with `cancel-in-progress: true`. *(Inference)* Put it on the **job**, after the label filter, so an unrelated label event cannot cancel a running review.

**Hardening**
- SHA-pinning is "the only way to use an action as an immutable release". The repo currently uses tags, so decide whether this workflow sets a new standard.
- Top-level `permissions: { contents: read }`, widened only on the job.
- `persist-credentials: false`, with `GH_TOKEN: ${{ github.token }}` only on the `gh` steps.
- Job `timeout-minutes`.

**Claude Agent SDK in CI** ([TS reference](https://code.claude.com/docs/en/agent-sdk/typescript))
- The bundled native binary is an optional dependency; if it is missing you get `Native CLI binary for <platform> not found`.
- Auth is `ANTHROPIC_API_KEY`.
- Omitting `settingSources` loads CLAUDE.md. The docs say "Isolation is especially important for CI/CD pipelines", and the package already sets `[]`.
- The first real run needed a **workspace-scoped key** (`verification/first-run.md:14-20`).

**Alternative considered: `anthropics/claude-code-action@v1`**
- Inputs include `anthropic_api_key`, `prompt` and `claude_args` (`--json-schema`, `--max-turns`, `--model`), plus `use_sticky_comment`. It outputs `structured_output`.
- It could produce scores, with labels added in follow-up steps. But the rubric would live in YAML/prompt text, with no local tests, fixtures, diff-size policy or lockdown verification.
- The in-repo SDK CLI fits the "tested rubric + deterministic pass/fail" requirement better. The action remains a fallback.

### 4. Target shape implied by the findings (for `/10x-plan`, not a decision)

```
.github/workflows/ai-code-review.yml   (separate file; pull_request [opened, synchronize, reopened, ready_for_review, labeled] → master)
  job review:
    if: same-repo PR && (action != labeled || label == ai-cr:review)
    permissions: contents: read, pull-requests: write
    concurrency: ai-cr-<PR#>, cancel-in-progress
    timeout-minutes
    steps: checkout (fetch-depth 2, persist-credentials false)
           → git diff HEAD^1 HEAD > $RUNNER_TEMP/pr.diff
           → uses: ./.github/actions/ai-code-review  (inputs: api key, title, body, diff path, model)
           → sticky comment + labels (passed/failed/skip) + remove ai-cr:review  [if: always()]
.github/actions/ai-code-review/action.yml
  setup-node (cache-dependency-path packages/code_reviewer/package-lock.json)
  npm ci + npm test (package) → review CLI → outputs: result (passed|failed|skipped|error), report path, markdown path
```

The outcome states the plan needs to map explicitly:
- exit 0 + pass → `ai-cr:passed`
- exit 0 + fail → `ai-cr:failed`
- exit 1 (oversize or no hunks) → skipped comment, no pass/fail label
- exit 2 (agent or lockdown error) → error comment, **not** `ai-cr:failed`
- fork PR → skipped with a notice

## Code References

- [`packages/code_reviewer/src/cli.ts:9-11`](https://github.com/Marcin1850/10x-media/blob/59be923d10fd46c3f0aa2d3d8c5c01248deeaed4/packages/code_reviewer/src/cli.ts#L9-L11): exit-code contract
- [`packages/code_reviewer/src/cli.ts:77-95`](https://github.com/Marcin1850/10x-media/blob/59be923d10fd46c3f0aa2d3d8c5c01248deeaed4/packages/code_reviewer/src/cli.ts#L77-L95): meta assembly, stdout JSON, timestamped report file
- [`packages/code_reviewer/src/config.ts:5-26`](https://github.com/Marcin1850/10x-media/blob/59be923d10fd46c3f0aa2d3d8c5c01248deeaed4/packages/code_reviewer/src/config.ts#L5-L26): output dir, argv path, `ANTHROPIC_API_KEY`, `REVIEW_MODEL`
- [`packages/code_reviewer/src/diff-input.ts:7-38`](https://github.com/Marcin1850/10x-media/blob/59be923d10fd46c3f0aa2d3d8c5c01248deeaed4/packages/code_reviewer/src/diff-input.ts#L7-L38): 200 KB cap, unified-diff shape check
- [`packages/code_reviewer/src/prompt.ts:4-32`](https://github.com/Marcin1850/10x-media/blob/59be923d10fd46c3f0aa2d3d8c5c01248deeaed4/packages/code_reviewer/src/prompt.ts#L4-L32): correctness-only system prompt, delimited untrusted diff
- [`packages/code_reviewer/src/review.ts:9-42`](https://github.com/Marcin1850/10x-media/blob/59be923d10fd46c3f0aa2d3d8c5c01248deeaed4/packages/code_reviewer/src/review.ts#L9-L42): `MAX_TURNS = 3`, lockdown options, deliberate absence of `env`
- [`packages/code_reviewer/src/schema.ts:7-46`](https://github.com/Marcin1850/10x-media/blob/59be923d10fd46c3f0aa2d3d8c5c01248deeaed4/packages/code_reviewer/src/schema.ts#L7-L46): output schema + verdict/findings `superRefine`
- [`packages/code_reviewer/src/lockdown.ts:5`](https://github.com/Marcin1850/10x-media/blob/59be923d10fd46c3f0aa2d3d8c5c01248deeaed4/packages/code_reviewer/src/lockdown.ts#L5): exact `["StructuredOutput"]` requirement
- [`packages/code_reviewer/src/result.ts:24-53`](https://github.com/Marcin1850/10x-media/blob/59be923d10fd46c3f0aa2d3d8c5c01248deeaed4/packages/code_reviewer/src/result.ts#L24-L53): result interpretation; usage dropped
- [`packages/code_reviewer/package.json:8-14`](https://github.com/Marcin1850/10x-media/blob/59be923d10fd46c3f0aa2d3d8c5c01248deeaed4/packages/code_reviewer/package.json#L8-L14): engines, scripts
- [`packages/code_reviewer/README.md:6-8`](https://github.com/Marcin1850/10x-media/blob/59be923d10fd46c3f0aa2d3d8c5c01248deeaed4/packages/code_reviewer/README.md#L6-L8): "no git hooks, no CI" statement to update
- [`.github/workflows/ci.yml:3-7`](https://github.com/Marcin1850/10x-media/blob/59be923d10fd46c3f0aa2d3d8c5c01248deeaed4/.github/workflows/ci.yml#L3-L7): triggers
- [`.github/workflows/ci.yml:145-147`](https://github.com/Marcin1850/10x-media/blob/59be923d10fd46c3f0aa2d3d8c5c01248deeaed4/.github/workflows/ci.yml#L145-L147): `deploy` needs/if gating
- [`.github/workflows/ci.yml:120-143`](https://github.com/Marcin1850/10x-media/blob/59be923d10fd46c3f0aa2d3d8c5c01248deeaed4/.github/workflows/ci.yml#L120-L143): `$GITHUB_OUTPUT` pattern, failure artifact upload
- [`tsconfig.json:4`](https://github.com/Marcin1850/10x-media/blob/59be923d10fd46c3f0aa2d3d8c5c01248deeaed4/tsconfig.json#L4), [`eslint.config.js:100-102`](https://github.com/Marcin1850/10x-media/blob/59be923d10fd46c3f0aa2d3d8c5c01248deeaed4/eslint.config.js#L100-L102): root isolation of `packages/`
- [`context/foundation/test-plan.md:88`](https://github.com/Marcin1850/10x-media/blob/59be923d10fd46c3f0aa2d3d8c5c01248deeaed4/context/foundation/test-plan.md#L88): LLM-as-judge "never as a merge gate, never in CI"
- [`context/foundation/test-plan.md:401`](https://github.com/Marcin1850/10x-media/blob/59be923d10fd46c3f0aa2d3d8c5c01248deeaed4/context/foundation/test-plan.md#L401): no LLM credits in CI hard rule
- [`context/team/opportunity-map.md:13,60`](https://github.com/Marcin1850/10x-media/blob/59be923d10fd46c3f0aa2d3d8c5c01248deeaed4/context/team/opportunity-map.md#L60): review-runner "not a CI gate"

## Architecture Insights

- **Rules live in code, verdicts are recomputed.** The package already refuses a model verdict that contradicts its findings (F4). Pass/fail from the five scores should follow the same pattern: the model supplies scores and findings, and a pure, unit-tested function decides the label. The PR label then never depends on the model agreeing with itself.
- **Fail closed, and keep outcomes distinct.** The exit codes separate "no spend, bad input" (1) from "spent, untrustworthy" (2). The workflow should keep that separation all the way to the PR. An error must never look like `ai-cr:failed`, and a skip must never look like `ai-cr:passed`.
- **Keep secrets narrow.** Mirror the Sentry DSN discipline: the key goes to one step's `env:` in one job of one workflow. Fork and Dependabot runs stay silent because the key is absent.
- **Tool-less agent means the rubric carries the context.** Idiomaticity and test-coverage anchors (e.g. `cn()`, `astro:env`, the authorization roster, the two-sided e2e oracle) must be in the prompt, because the agent cannot read CLAUDE.md. Otherwise those criteria score blind. This is also the main cost lever, together with including the PR description and the model choice.
- **A separate workflow keeps the deterministic gates clean.** `ci.yml` contains only deterministic jobs, and every gate in test-plan §5 is deterministic. An advisory, paid, non-deterministic review belongs in its own file with its own permissions.
- **Comments explain why.** The existing YAML documents every non-obvious choice. The new workflow should do the same, especially the fork skip, the label filter, the `GITHUB_TOKEN` no-loop property, and the paid-key exception.

## Historical Context (from prior changes)

- `context/changes/code-reviewer/plan.md:15`: the package is "**not** the `review-runner` from the opportunity map"; it "only proves the SDK can host a reviewer".
- `context/changes/code-reviewer/plan.md:39-43`: explicitly out of scope: CI, git hooks, markdown rendering, reading from `git diff`, repo access ("context-dependent bugs are out of reach in v1 by design"). This change reverses several of those.
- `context/changes/code-reviewer/plan.md:28-35,53,55`: lockdown rationale (`tools: []` vs `allowedTools`, `settingSources: []`, no `env`, model from the init message rather than a hard-coded name, lockdown verified rather than assumed, two failure channels).
- `context/changes/code-reviewer/plan-brief.md:24`: structured output "gives a future runner a stable shape".
- `context/changes/code-reviewer/plan-brief.md:63-64`: one planted bug is "a feasibility proof, not a quality benchmark"; the SDK is pre-1.0.
- `context/changes/code-reviewer/reviews/impl-review.md`: F1 (auto-memory / `~/.claude.json` not isolated) **still open**; F2 (lockdown verification), F3 (diff input validation) and F4 (verdict consistency) fixed.
- `context/changes/code-reviewer/verification/first-run.md:14-20,49-53`: a workspace-scoped key is required. $0.066 / 19 s / 3-of-3 turns. Follow-ups: raise turns to about 5 if retries appear; a cheaper `REVIEW_MODEL` is the lever for repeated runs.
- `context/team/opportunity-map.md:49,55,60`: an independent reviewer "on a different model", model attribution from the run, "trigger and scope stay a human decision", "not a Review / CI gate". This was about the Codex runner.
- `context/team/mom-test-validation.md:17,32`: "A wrong range means a review of the wrong code that *looks* valid." That applies directly to choosing the diff base. No Mom Test results are recorded.
- `context/foundation/test-plan.md:88,101-112,401`: the LLM-judge and paid-credit rules. Every current gate is deterministic.
- `context/foundation/roadmap.md` / `prd.md`: no item covers code review. This is tooling outside the product roadmap, so the roadmap/Linear sync lessons apply only if an issue is created for it.

## Related Research

- No prior `research.md` exists for the reviewer. Closest artifacts: `context/changes/code-reviewer/plan.md`, `plan-brief.md`, `reviews/impl-review.md`, `verification/first-run.md`.
- `context/archive/2026-09-09-error-monitoring/`: precedent for the secret-narrowness and "absence is the guarantee" pattern in CI.
- `context/archive/2026-09-07-testing-phase-4-critical-flow-e2e/`: precedent for fail-closed CI job design and failure-artifact uploads.

## Open Questions

1. **Advisory or gate?** Should `ai-cr:failed` stay advisory (no required check), or does this change deliberately overturn test-plan §4:88 and the opportunity map? Either way, test-plan §5/§7 and the README CI section need an explicit entry for the paid-key exception.
2. **Pass/fail rule.** What threshold turns five scores (plus severities) into `passed`/`failed`, e.g. any score ≤ N, any critical/major finding, or a mean? How is it calibrated against the user's own judgment before anyone trusts the label (test-plan §4 "calibrated once")?
3. **PR description.** Include it always, cap its length, or leave it out? It is untrusted input like the diff, and it adds tokens (requirements.md "cost tradeoff").
4. **Repo context for criteria 3–4.** Embed a condensed rubric (from requirements.md and CLAUDE.md) in the prompt, or pass selected files as delimited input? Does either weaken the "no repository" lockdown story?
5. **Model, turns and budget for CI.** Which `REVIEW_MODEL` should be pinned? How high should `MAX_TURNS` go (3 is already at the limit), and what `maxBudgetUsd` per run?
6. **Oversize or empty diffs.** Refuse and comment "skipped", truncate, or filter paths (lockfiles, `packages/code_reviewer/docs/`)? Which label, if any?
7. **Which PRs are covered.** Skip draft PRs until `ready_for_review`? Skip fork and Dependabot PRs? Skip docs-only / `context/**`-only PRs, which would cut spend on most of this repo's PRs?
8. **Retry semantics.** `ai-cr:review` is added → run → remove it, even on error. Should a new push (`synchronize`) also clear a stale passed/failed label before re-review?
9. **Action pinning.** SHA-pin the new workflow's actions (security guidance) or follow the repo's major-tag convention?
10. **Sequencing.** Merge the `code-reviewer` branch first, since the package is not on `master`. Also close out or archive the `code-reviewer` change, and decide whether F1 (auto-memory isolation) is acceptable on hosted runners.
11. **Self-review.** A PR that edits `packages/code_reviewer` or the action is reviewed by its own modified rubric under `pull_request`. Is that acceptable for an advisory label?
