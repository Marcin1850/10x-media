# Live verification — `ai-code-review` workflow

> Phase 4 of `context/changes/ci-cd-code-review/plan.md`. Evidence of each outcome path on real GitHub, plus a first
> calibration pass. **Public repo:** no account identifiers — no emails, usernames, key fragments or workspace ids.
> Describe roles ("the operator"), link runs by URL only.

- Date: _pending_
- PR under test: _pending_ (the introducing PR, `code-reviewer` → `master`)
- Model / caps: `claude-sonnet-5`, `max-turns: 5`, `max-budget-usd: 1.00`
- Secret: `ANTHROPIC_API_KEY` set by the operator as a repository secret (workspace-scoped key with a console spend limit)

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
