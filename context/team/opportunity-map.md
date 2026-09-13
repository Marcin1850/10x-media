# Opportunity Map

## Context

- **Project / context**: 10xMedia — AI-assisted development workflow (10x skills), independent review of plans and implementation phases in a second agent (Codex)
- **Data constraint**: Mock / local / read-only / non-sensitive — repo code, `context/changes/` plans, git history; no production data
- **Date**: 2026-09-13

## Map

| Signal | Existing / default response | Thin complement | First useful version | Data risk | Direction if valuable |
|---|---|---|---|---|---|
| After a plan or a phase (group of phases): switch to Codex, type `/10x-plan-review <plan>` or `/10x-impl-review <plan> <range>`, babysit sandbox approvals, then hand-prompt a commit in the fixed convention (~50×/quarter) | `codex exec` headless (approval policy `never`, sandbox profile set once); skills already persist the report and stamp `change.md`; convention visible in `git log` | One manual command `review plan` \| `review impl <range>`: resolve plan from branch/change, run the skill in `codex exec` with a fixed permission profile, prepare the commit in the convention | Local script run by hand; tried on the next plan-review and 2 impl-reviews; commit confirmed by the user | Local / non-sensitive | Internal tool → Async / remote work (not a CI gate) |

## Recommended First Candidate

```text
Candidate:
  review-runner — one command for an independent Codex review

Reads:
  current branch → context/changes/<id>/{change.md, plan.md}; argument `plan` | `impl <range>`
  (e.g. `3`, `2-4`); git log (commit convention); Codex config (the model actually used)

Returns:
  report in reviews/ (written by the skill, as today), change.md stamp, and a ready commit
  message in the established convention — `docs(<change-id>): record <scope> review`,
  Verdict/Verification paragraph, `Refs: MAR-<n>`, `Co-Authored-By: OpenAI Codex (<model>)` —
  applied after one confirmation from the user

Does not do:
  decide WHETHER or for WHICH range to review; trigger from a hook or CI; triage findings;
  commit without confirmation; modify the /10x-*-review skills

Data risk:
  local / non-sensitive. Decide once, in the profile: sandbox network + Docker access, so
  integration/e2e verification does not produce false "fail" entries in the report

Direction if it proves valuable:
  Internal tool → Async / remote work (review runs in the background; user returns only for triage)
```

## Why This Candidate

The only signal on the map, and it passes all six criteria on its own: it repeats (~40 `impl-review*.md` and ~12 `plan-review*.md` in `context/archive/`, June–September 2026); it joins several sources and two agents (plan, git scope, Codex, Claude session, commit convention); the manual pain is concrete (context switch, typing path + range, approval prompts, a "MANDATORY" commit prompt re-stating a rule that is already stable in history); it runs locally; it wraps rather than replaces the skills and Codex; its later direction is clear.

Essential vs accidental complexity — keep the essential part manual:

- **Essential**: an independent reviewer on a different model; the user's deliberate choice to skip a review (e.g. a docs-only commit) or to merge several small phases into one review; human triage of findings.
- **Accidental**: switching tools, typing the plan path and phase range, per-run sandbox approvals, re-prompting the commit convention.

Risks the first version must check honestly:

- **Pre-commit hook** (lint-staged + `typecheck`, ~20s) may fail or be blocked inside the Codex sandbox → commit from the script after Codex exits, not from inside Codex.
- **Model attribution** must come from the model the review actually ran on, never a hard-coded `gpt-5.6 sol`, or the trailer starts lying after a config change.
- **Headless means no questions, not more permissions** — a sandbox denial silently becomes a failed verification step in the report.

## Next Direction If Valuable

Internal tool, growing toward **async / background review**: kick off the review and keep working; come back only for `/10x-impl-review <report-path>` triage. Explicitly **not** a Review / CI gate — trigger and scope stay a human decision.

Next step chosen: validate with `/10x-mom-test` (past behaviour: how long one ritual actually takes, how often approvals or the commit prompt went wrong), then `/10x-shape`.
