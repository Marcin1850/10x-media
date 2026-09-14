# Live verification — `ai-code-review` workflow

> Phase 4 of `context/changes/ci-cd-code-review/plan.md`. Evidence of each outcome path on real GitHub, plus a first
> calibration pass. **Public repo:** no account identifiers — no emails, usernames, key fragments or workspace ids.
> Describe roles ("the operator"), link runs by URL only.

- Date: _pending_
- PR under test: _pending_ — **not** the introducing PR. `code-reviewer` was merged into `master` locally (repo
  convention, no PR), and its diff against `master` is ~399 KB, over the reviewer's 200 KB cap, so it would only
  ever have produced `ai-cr:skipped`. Run the scenarios below on the next small, real PR to `master`.
- Model / caps: `claude-sonnet-5`, `max-turns: 5`, `max-budget-usd: 1.00`
- Secret: `ANTHROPIC_API_KEY` set by the operator as a repository secret — **done 2026-09-14** (item 4.4).

## Smoke run on a sandbox PR (2026-09-14) — done

A throwaway PR proved the happy path before merge: branch `ai-cr-sandbox` → base `code-reviewer`, with the
workflow's `branches` filter widened to `[master, code-reviewer]` in the sandbox branch only (a `pull_request` run
uses the workflow file from the PR's merge commit, and the filter matches the base branch). The sample was a
6-line `canAfford(balance, cost)` returning `balance < cost` against a docstring saying the opposite. PR #3 was
closed unmerged and the branch deleted; nothing from it reached `code-reviewer` or `master`.

| Event | Observed | Run | Cost |
|---|---|---|---|
| PR opened (non-draft) | `review` success, `invalidate` skipped; one sticky comment; label `ai-cr:failed`; `ci.yml` did not run (base was not `master`) | https://github.com/Marcin1850/10x-media/actions/runs/34896602739 | $0.0532, 2 turns |

Model scores: correctness 2, security 6, idiomaticity 5, test coverage 2, maintainability 6. Findings: **critical**
(correctness) — the inverted comparison, with a correct failure scenario (`canAfford(0, 5)` → true); **major** (test
coverage) — no test; **minor** (security) — claims the widened filter lets fork PRs spend the budget, which is
**wrong**: the `review` job's same-repo guard blocks forks, but only the one-line YAML change was in the diff, so the
model could not see it (a calibration data point: a tool-less reviewer over-reports risk in config it sees partially);
**nit** — top-level `sandbox/` folder.

### Defects found by the smoke run (open)

- **Model text reaches the comment unsanitized.** The rendered `summary` ended with a literal `</summary>\n</invoke>`
  leaked from the model's output. `packages/code_reviewer/src/render.ts` writes model strings into markdown as-is
  (only table cells escape `|` and newlines), so model text can also inject raw HTML, `@mentions`, or a second
  `<!-- ai-cr:sticky -->` marker that the upsert's `startswith` match would not catch but a human reader would see.
  Fix: strip trailing tool-call/XML-like tags from free-text fields and neutralize `<!--`, `@` and raw HTML in every
  model string before rendering; add `render.test.ts` rows for each.

## Scenarios

| # | Event | Expected | Observed (label / comment / job) | Run | Cost |
|---|---|---|---|---|---|
| 1 | PR opened (non-draft) | `review` runs; one sticky comment; exactly one of `ai-cr:passed`/`ai-cr:failed`; `ci`/`integration`/`e2e` run as before | _pending_ | _pending_ | _pending_ |
| 2 | Commit pushed (`synchronize`) | `invalidate` runs, `review` skipped; outcome label removed; comment gets the outdated banner; no paid run | _pending_ | _pending_ | $0 |
| 3 | `ai-cr:review` added | `review` runs; fresh comment (banner gone) and one outcome label; `ai-cr:review` removed afterward | _pending_ | _pending_ | _pending_ |
| 4 | Unrelated label added | both jobs skipped; nothing spent | _pending_ | _pending_ | $0 |
| 5 | Forced error (temporary `max-budget-usd: "0.001"`, then reverted) | `ai-cr:error`, red job, error comment — never `ai-cr:failed` | _pending_ | _pending_ | _pending_ |

## Calibration

Scores are 1–10; the result follows the code rule (every score ≥ 6 and no critical/major finding → `passed`).
The operator's ratings are made **before** reading the model's comment.

| PR | Rater | Correctness | Security | Idiomaticity | Test coverage | Maintainability | Result |
|---|---|---|---|---|---|---|---|
| _self-review PR_ | model | | | | | | |
| _self-review PR_ | operator | | | | | | |
| _second PR_ | model | | | | | | |
| _second PR_ | operator | | | | | | |

### Disagreements

- _pending — one line per criterion where model and operator differ by ≥ 3 points or on the result._

## Outcome

_pending — does the label stay advisory as planned (it does regardless), and is any rubric change warranted?_
