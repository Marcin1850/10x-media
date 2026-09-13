# Mom Test Validation Plan

## Input Idea

`review-runner` (from `context/team/opportunity-map.md`): one local command — `review plan` | `review impl <range>` — that resolves the plan from the current branch, runs `/10x-plan-review` or `/10x-impl-review` headless in `codex exec` with a fixed sandbox profile, and prepares the review commit in the established convention (model taken from the Codex config), applied after one confirmation.

## Hypotheses

- **User/role**: a solo developer running the 10x workflow with Claude Code as the implementer and Codex as an independent reviewer. Today that is exactly one person, the builder. The only other possible users are 10xDevs course participants who run the same cross-agent review.
- **Friction**: every review means switching tools, typing the plan path and phase range, approving sandbox prompts one at a time, and then hand-prompting a commit in a fixed convention.
- **Current workaround**: a manual Codex session plus a "MANDATORY" commit prompt re-typed each time.
- **Risky assumptions**:
  1. The ritual costs enough per run (minutes, attention) that ~50 runs a quarter add up to real time. *Estimated, not measured.*
  2. Most of the cost is the accidental part (typing, approvals, commit prompt), not waiting for the review itself. A runner cannot speed the review itself up.
  3. Sandbox denials really distort reports (false "fail" entries), and a fixed profile would fix that instead of just hiding it.
  4. Resolving the plan and range automatically is safe. A wrong range means a review of the wrong code that *looks* valid.
  5. Review volume stays about the same. Volume is tied to course pace (July 14 → August 20 → September 9 so far), and the course ends.
  6. A shell alias around `codex exec` would not already do most of it.
- **Evidence already present** (from the repo, checked 2026-09-13):
  - 39 `impl-review*` and 12 `plan-review*` reports in `context/archive/*/reviews/`, so the volume is real.
  - 43 commits carry a Codex trailer, with **two different spellings**: `gpt-5.6 sol` (31) and `gpt-5.6-sol high` (12). The hand-prompted attribution has already drifted, so "the trailer starts lying" is not hypothetical.
  - 51 reports but 43 attributed commits. About 8 reviews were committed some other way, bundled, or not committed at all. The reason is unknown.
  - 10 review reports mention the sandbox. Examples: "sandboxed attempts could not start Wrangler's Workers runtime", "the unrestricted retry did not complete and was stopped", "sandboxed attempts of Astro/Vitest/Wrangler failed before project execution". The sandbox-distortion risk is **observed**, not guessed.
  - Median gap between a review commit and the commit before it: ~22 min (min 3). This is only a weak proxy, because it mixes review runtime, reading, and unrelated work.

## Critique

- **Solution-first framing.** The map already names the command, its arguments, and its commit format. The evidence supports "the review ritual has friction". It does not yet show *which part* of the ritual costs the time. If most of those ~22 min is Codex thinking and running tests, the runner saves typing and approvals, maybe 2–4 min a run. That is ~2–3 h a quarter, which a 15-line script can win back but a "tool" cannot.
- **Builder-as-user bias.** The interviewee and the builder are the same person. Polite false positives come from yourself here: "I *would* use it every time". Treat your own answers as claims and check each one against git history and review reports, which are already on disk.
- **The strongest signal is not about speed.** It is correctness: attribution drift, and sandbox failures leaking into verification sections. These can be fixed without a runner. One `codex` profile file fixes the sandbox problem. A `prepare-commit-msg` template or a git alias that reads the model from `~/.codex/config.toml` fixes the attribution. That is the "try existing first" option, and it has to be ruled out before building.
- **Horizon.** The cadence is course-driven. If reviews drop sharply after the course, a tool built for ~50 runs a quarter serves ~10.
- **Auto-resolving the range is the riskiest convenience.** Today the typed range is also a deliberate decision. Check whether a wrong range has ever happened, and whether typing it was ever where you caught a mistake.
- **What would prove it is not worth building:** a timed ritual where the accidental steps take under ~3 min, or where most sandbox trouble goes away with a one-time profile.

## Interview Guide

Two tracks, about 25 min each. **A — self-retrospective:** answer in writing, with `git log` and `context/archive/*/reviews/` open, and cite a commit or report for every claim. **B — 3–5 course peers** who already run a second-agent review. They show whether the problem exists outside this repo; they are not customers.

1. **Warm-up.** How does a plan or phase get from "implemented" to "reviewed" in your workflow? Which agents are involved, and in what order?
   - *Follow-up:* How often did that happen in the last two weeks? Check the count against the log.
2. **Last occurrence.** Walk me through the most recent review you ran, step by step, from the moment you decided to run it until it was committed.
   - *Follow-up:* Which step took longest? Which one did you have to come back to?
3. **Accidental steps, timed.** For that same review, roughly how long did switching tools, finding the plan path and range, approving prompts, and writing the commit take? Leave out the time Codex spent working.
   - *Follow-up (A):* Time the next real review with a stopwatch, split into these buckets.
4. **Approvals.** Tell me about the last time a sandbox prompt or denial interrupted a review. What did you do?
   - *Follow-up:* Did the report still record a failed or skipped verification? Did you re-run it? (Tie this to one of the 10 reports that mention the sandbox.)
5. **Commit.** How did the last review commit get its message and trailer? Has one ever come out wrong: wrong scope, wrong model, missing `Refs`?
   - *Follow-up (A):* Why do two model spellings exist? Was it a config change, or a different prompt?
6. **Missing reviews.** Think of a review that did *not* get its own attributed commit. What happened there?
7. **Skipped reviews.** When did you last decide not to review, or to merge several phases into one review? What made you decide?
   - *Follow-up:* Was the effort of the ritual part of that decision? This is the key signal: friction that changes behavior.
8. **Wrong scope.** Has a review ever covered the wrong plan or range? How did you notice?
9. **Workarounds tried.** What have you already done to shorten this: aliases, saved prompts, Codex profiles, snippets? What happened to them?
   - *Follow-up:* If you never tried anything, why not?
10. **Cost of pain.** In the last month, what did the ritual cost you besides time: a lost train of thought, a re-run, a wrong report you trusted?
11. **Horizon (A).** How many reviews do you expect in the four weeks after the course ends? What is that number based on?
12. **Closing.** (B) May I see one anonymized review report and the commit it produced? (A) Keep a stopwatch log for the next 3 reviews.

## Survey

For course peers. It gives a broad signal and can only narrow or confirm what the interviews show; it cannot decide the go/no-go alone.

1. **Screener.** In the last 4 weeks, have you had a *second* AI agent or model review a plan or implementation written by your main agent?
   - No → end survey
   - Yes, once or twice
   - Yes, weekly
   - Yes, several times a week
2. How many such reviews did you run in the last 7 days? (0 / 1–2 / 3–5 / 6+)
3. For your most recent review, how long did everything *except* the reviewer's own work take (setup, pointing it at the right files, approvals, recording the result)? (<2 min / 2–5 / 5–10 / >10 / don't know)
4. In your last 5 reviews, how many were interrupted by permission or sandbox prompts? (0 / 1–2 / 3–5)
5. In your last 5 reviews, did any report include a failure caused by the environment rather than the code, such as a blocked network, Docker, or file access? (Yes / No / Not sure)
6. How do you record a review's result today? (Commit / file only / chat only / not recorded / other)
7. In the last month, did you ever skip a review or merge several into one *because running it was a hassle*? (Yes, more than once / Once / No)
8. What have you already set up to make running reviews faster? (open)
9. Describe the last time running a review went wrong or took longer than expected. (open)

## Decision Criteria

- **Proceed** (build the runner as mapped) if **all** of these hold:
  - Stopwatch data from 3 real reviews shows the accidental steps (switching, path/range, approvals, commit) take **≥ 5 min per run** on average.
  - The expected review volume after the course is **≥ 6 per month**.
  - At least one review in the retrospective was **skipped, merged, or delayed because of the effort**, or produced a **wrong or untrustworthy report** (sandbox false-fail, wrong scope).
- **Narrow scope** (build only the commit/attribution helper, or only the headless profile) if:
  - Accidental time is 2–5 min, **or**
  - The pain sits in one step. For example, approvals are the only real cost, or the commit is the only step that goes wrong.
- **Do not build yet** if **any** of these hold:
  - Accidental time is **< 2 min**.
  - No review was ever skipped, delayed, or wrong because of the ritual.
  - Expected volume after the course is **< 4 per month**.
  - In peer interviews, fewer than 2 of 3–5 peers describe the same workaround unprompted. This one blocks only a shared tool, not a personal script.
- **Try existing tool/process first** if:
  - A one-time `codex` profile (approval `never`, network + Docker allowed) removes the sandbox mentions from the next 3 reports, **and**
  - A git alias or `prepare-commit-msg` template that reads the model from the Codex config produces the correct trailer.

  If both together leave < 3 min of manual work per run, stop there. The runner has nothing left to earn.
