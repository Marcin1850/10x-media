# AI Code Review in CI — Plan Brief

> Full plan: `context/changes/ci-cd-code-review/plan.md`
> Research: `context/changes/ci-cd-code-review/research.md`

## What & Why

Every non-draft PR to `master` gets an automated second reader: `packages/code_reviewer` scores the change on five criteria (correctness, security, idiomaticity, test/risk coverage, maintainability). It posts one summary comment and one label. The label is advisory. It gives a consistent signal on each PR without overturning the repo's rule that LLM judges are never merge gates.

## Starting Point

The reviewer package exists only on the `code-reviewer` branch. It is a locked-down, tool-less Agent SDK CLI that reviews one diff file for correctness bugs only. It has no scores, no title/description input, a verdict chosen by the model, and stdout that mixes logs with JSON. The repo has one deterministic workflow (`ci.yml`) and no label, comment or `gh` automation.

## Desired End State

Opening, reopening or marking a PR ready produces a sticky comment (score table, findings, cost) and exactly one of `ai-cr:passed` / `failed` / `skipped` / `error`. Pushing a commit clears the label and marks the comment outdated. Adding `ai-cr:review` re-runs the review. `ci.yml` and `deploy` are unchanged, and the Anthropic key reaches a single step.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) | Source |
| --- | --- | --- | --- |
| Pass/fail rule | Fail if any score < 6 (6 passes) or any critical/major finding; computed in code | One weak criterion can't be averaged away, and the label never depends on the model agreeing with itself | Plan |
| Gate status | Advisory label, not a required check; scoped exception written into test-plan §4/§5/§7 | Keeps the rule "no uncalibrated LLM judge as a gate" intact | Research → Plan |
| Coverage | Same-repo, non-draft PRs, all paths; forks and Dependabot skipped | Fork runs get no secrets; docs PRs still get criterion-5 review | Plan |
| On push | No auto re-review; clear the label and mark the comment outdated | Spend is human-triggered after the first review, and a label never describes unreviewed code | Plan |
| PR description | Included, capped at 8k characters, delimited as untrusted | Criterion 1 needs the stated intent, and the cap bounds cost | Plan |
| Repo context | No repo files passed in; rubric anchors live as prose in the prompt; CLAUDE.md/test-plan refs removed from requirements | Preserves the tool-less lockdown and bounded tokens | Plan (user edit) |
| Non-review outcomes | `ai-cr:skipped` (no reviewable diff, no spend) and `ai-cr:error` (red job) | An error never reads as failed, and a skip never reads as passed | Plan |
| Cost controls | `claude-sonnet-5`, 5 turns, $1 `maxBudgetUsd` per run | Bounded worst case and cheap enough to run on every PR | Plan |
| Sequencing | One PR from this branch; it reviews itself on open | The first real run is the acceptance test | Research → Plan |
| Action layout | Composite action for install + self-test + review; workflow handles triggers, comment, labels | Matches the requirement that the main workflow is easy to reason about | Requirements |

## Scope

**In scope:** package schema/decision/prompt/config/CLI/renderer changes with unit tests; `.github/actions/ai-code-review/action.yml`; `.github/workflows/ai-code-review.yml` (`review` + `invalidate` jobs); test-plan, README and CLAUDE.md/AGENTS.md updates; live verification and a first calibration record.

**Out of scope:** merge gating, auto re-review on push, agent repository access, diff truncation, path filters, fork/`pull_request_target` support, SHA-pinning, parked criteria (business alignment, architectural fit), package tests in `ci.yml`.

## Architecture / Approach

`pull_request` event → `review` job (guards: same-repo, not Dependabot, open, not draft or explicit `ai-cr:review`) → checkout (depth 2) → `git diff HEAD^1 HEAD` + PR body written to files → composite action (`npm ci` → package typecheck/tests → CLI → exit code mapped to `passed|failed|skipped|error`) → publish: upsert the sticky comment (hidden marker), then apply the outcome label only if the PR head hasn't moved → always remove `ai-cr:review`. The `invalidate` job on `synchronize` shares the per-PR concurrency group. It cancels an in-flight review, clears labels and flags the comment outdated.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Review contract | Five-criteria schema, `decideResult`, rubric prompt with title/body, turns/budget config | Rubric prose too vague and scores become noise (checked in Phase 4 calibration) |
| 2. CLI for CI | Flags, JSON-only stdout, exit 3 = skipped, markdown renderers, package README | Structured output fails more often with the richer schema (5-turn cap, measured in the local paid run) |
| 3. Action + workflow | Composite action, `review` + `invalidate` jobs, four labels, sticky comment | Script injection or push/review race (env-only inputs, shared concurrency + head-SHA check) |
| 4. Docs + live verification | test-plan/README exception, live event-matrix pass, calibration record | Label permission (403) or secret misconfig only shows up on real GitHub |

**Prerequisites:** a workspace-scoped `ANTHROPIC_API_KEY` with a console spend limit, set as a repository secret by the operator; work continues on the `code-reviewer` branch.
**Estimated effort:** ~3–4 sessions across 4 phases, with two small paid runs locally and a handful live.

## Open Risks & Assumptions

- `issues: write` is assumed sufficient for idempotent label creation (not verified; the live run in Phase 4 confirms it).
- Sonnet 5 depth on subtle paid-path bugs is unproven; the model is one input to change if calibration disagrees.
- Under `pull_request`, a PR that edits the rubric is reviewed by its own edited rubric. That is acceptable only because the label is advisory.
- A PR with merge conflicts triggers no `pull_request` runs, so it shows no review until the conflicts are resolved.

## Success Criteria (Summary)

- The introducing PR shows a correct sticky comment and exactly one outcome label, and push/retry/error paths behave as specified on real GitHub.
- No product test layer holds or needs the Anthropic key, and `ci.yml`/`deploy` are unchanged.
- A first calibration comparison (model scores vs. the author's) is recorded.
