# Code Reviewer (Claude Agent SDK) — Plan Brief

> Full plan: `context/changes/code-reviewer/plan.md`

## What & Why

A first, runnable code-review agent built on `@anthropic-ai/claude-agent-sdk`, living as its own package in `packages/code_reviewer/`. The goal is to prove the SDK can host an independent reviewer: hand it a diff, get back validated findings — demonstrated on a tiny LLM-generated diff with a planted bug. SDK docs are saved locally for later sessions.

## Starting Point

`packages/code_reviewer/` is empty and the repo root is a single Astro app package with no workspaces. Its `tsconfig` (`include: **/*`) and type-aware `eslint .` would silently adopt any `.ts` placed under `packages/`, and the SDK by default loads the user's `~/.claude` rules, the repo `CLAUDE.md` and hooks.

## Desired End State

`npm run review -- <diff>` inside the package runs a tool-less, settings-less agent with an API key from the package `.env`, prints and saves a zod-validated JSON report (verdict, findings, model, cost), and exits non-zero on any failure. One recorded run shows it finding the planted bug. The root app's typecheck, lint and CI are provably untouched.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) |
| --- | --- | --- |
| Relation to root toolchain | Fully standalone package; root `tsconfig`/ESLint exclude `packages/**` | Keeps the SDK out of the Worker's dependency tree and the app's gates unchanged. |
| Agent capabilities | Diff in prompt; `tools: []`, `settingSources: []`, `permissionMode: "dontAsk"` | Hermetic and cheap — output depends only on diff + prompt, and nothing is inherited from the machine. |
| Tool lockdown mechanism | `tools: []`, not `allowedTools: []` | `allowedTools` only auto-approves; unlisted tools still exist. |
| Output | Zod schema → JSON Schema via `outputFormat`; `safeParse` the result | Makes "it worked" checkable and gives a future runner a stable shape. |
| Auth | `ANTHROPIC_API_KEY` from package `.env`, fail fast if unset | Explicit, per-run cost visible, the SDK's documented auth path. |
| Test input & oracle | A few-line diff with one planted bug + `expected.md` written before the run; manual match | A known answer proves reviewing, not just plumbing, without a flaky LLM assertion. |
| Model attribution | Taken from the SDK's init message, never hard-coded | The Codex review trailer already drifted between two spellings. |
| Docs location | `packages/code_reviewer/docs/`, one file per topic, from Context7 | Lives with the package it documents. |

## Scope

**In scope:**
- Package scaffold (package.json, tsconfig, .env.example, README) + two root ignore entries
- SDK docs from Context7 in `docs/`
- Schema, prompt, config guard, result interpretation, `query()` call site, CLI
- Hermetic unit tests for the pure modules
- Planted-bug fixture, expectation file, one real run recorded in the change folder

**Out of scope:**
- Integration with 10x skills, git hooks, CI or commits (the unvalidated `review-runner` idea)
- Repo access for the agent (Read/Grep/Bash) — context-dependent bugs are out of reach in v1
- npm workspaces, root lockfile or CI changes
- Automated assertion that the LLM found the bug; markdown rendering; `git diff` input; subscription-login auth

## Architecture / Approach

`cli.ts` → `config.ts` (pure guard, exit 1 before any SDK call) → reads diff → `review.ts` (the only `query()` call: custom system prompt, no tools, no settings, json_schema output) → `result.ts` (pure: success + valid schema = ok; everything else is `invalid-output`, `agent-error`, or `no-result`) → stdout + `output/<timestamp>.json`, exit 0/2. The init message's tool list and model are logged so the lockdown is verified, not assumed.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Scaffold, root isolation, docs | Installable package invisible to root gates; SDK docs saved | A missed root config still picks up `packages/**` in pre-commit/CI |
| 2. Reviewer agent | Pure modules + tests, `query()` wrapper, CLI with exit codes | `tools: []` could interfere with structured output — fallback is explicit `disallowedTools`, never the default tool set |
| 3. Fixture and first run | Planted-bug diff, expectation, recorded run in `verification/` | The agent misses the bug or runs out of turns; costs real credit |

**Prerequisites:** An Anthropic API key with credit; Node 22; Context7 MCP available for the docs step.
**Estimated effort:** ~1–2 sessions across 3 phases.

## Open Risks & Assumptions

- Assumes `tools: []` + `outputFormat` coexist; verified on the first real run via the init message.
- One diff with one bug says nothing about general recall — this is a feasibility proof, not a quality benchmark.
- SDK is pre-1.0 (`0.3.x`); option names may change — the saved docs pin the version they describe.

## Success Criteria (Summary)

- `npm run review -- fixtures/planted-bug.diff` exits 0 with an empty tool list and a schema-valid report that contains the planted bug.
- Root `typecheck`, `typecheck:astro` and `lint` pass unchanged; root lockfile untouched.
- The next session can build on the package using only `docs/` and the README.
