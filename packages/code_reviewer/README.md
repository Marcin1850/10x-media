# code_reviewer

A pull-request reviewer built on the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview). You
give it a unified diff plus the PR title and description. It scores the change on five criteria, lists
criterion-tagged findings, and returns JSON validated by zod. The pass/fail **result is decided in code**
(`src/decision.ts`), never by the model.

> **Status: advisory CI reviewer.** The `ai-code-review` GitHub Actions workflow runs it on pull requests to
> `master` through the composite action `.github/actions/ai-code-review`, and publishes a sticky PR comment plus
> one `ai-cr:*` label. It is **not** a merge gate. It is a standalone package, so the Astro app at the repo root
> does not depend on it, and the root's typecheck, lint and tests ignore it.

**Every review run calls the Anthropic API and spends real credit.** The unit tests (`npm test`) never do.

## Setup

Requires Node ≥ 22 (the repo's `.nvmrc` is fine) and an Anthropic API key.

Run everything from this directory, not the repo root. This package has its own `package.json`, lockfile and
`node_modules`.

```bash
cd packages/code_reviewer
npm ci
cp .env.example .env
```

Then edit `.env`:

| Variable                | Required | Meaning                                                                            |
| ----------------------- | -------- | ---------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`     | yes      | Anthropic API key. The run refuses to start without it, and no API call is made.   |
| `REVIEW_MODEL`          | no       | Model id override. Leave it unset for the SDK default (CI pins `claude-sonnet-5`). |
| `REVIEW_MAX_TURNS`      | no       | Maximum agent turns, a positive integer. Default `5`.                              |
| `REVIEW_MAX_BUDGET_USD` | no       | Spend cap per run in USD, a positive number (CI uses `1.00`). Unset means no cap.  |

An invalid `REVIEW_MAX_TURNS` or `REVIEW_MAX_BUDGET_USD` is a configuration error (exit `1`), never silently
replaced by the default. Hitting either limit ends the run as an agent error (exit `2`).

`.env` is gitignored by the root `.gitignore`. Only `.env.example` is committed.

## Run

```bash
npm run review -- <diff-path> [--title <text>] [--body-file <path>] [--report <path>] [--markdown <path>] [--reviewed-sha <sha>]
# e.g.
npm run review -- fixtures/planted-bug.diff --title "Add rate limiting" --report r.json --markdown r.md
```

| Flag             | Meaning                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------- |
| `--title`        | PR title. Default `""`.                                                                                             |
| `--body-file`    | File holding the PR description, passed by path so untrusted text never goes through argv. Cut at 8,000 characters. |
| `--report`       | Where to write the report JSON. Default `output/<ISO-timestamp>-<diff-basename>.json`.                              |
| `--markdown`     | Where to write the PR comment markdown. Written in **every** outcome: review, skipped, or error.                    |
| `--reviewed-sha` | Commit the diff was taken from, shown in the comment footer.                                                        |

Unknown flags are refused (exit `1`).

The input is a unified diff in a file, for example one written by `git diff > my.diff`. The CLI does not run
git itself.

Input limits, all checked before any API call:

- The path must be a regular file of at most **200,000 bytes** (`MAX_DIFF_BYTES` in `src/diff-input.ts`). The
  size is checked before the file is read.
- The content must look like a unified diff: a `---`/`+++` file header pair and at least one `@@` hunk. A file
  that isn't a diff (a mistyped `.env`, a config file) is refused, and so is a diff with only binary, rename or
  mode changes. Oversized diffs are skipped, never partially reviewed.
- The check cannot see secrets **inside** a valid diff. Everything in the file is sent to the Anthropic API, so
  look at the diff before you review it.

What the run does:

1. Logs the session's tool list and model, taken from the SDK's init message. It must be exactly `StructuredOutput`, the SDK's internal tool for delivering JSON-schema output. If the init message is missing or lists anything else, the CLI exits `2` and does not print or save the review.
2. Logs the run's cost in USD and its turn count.
3. Prints the report JSON to stdout and writes it to `--report` (or `output/…`, which is gitignored), and writes the comment markdown to `--markdown` when given.

All progress and diagnostic lines go to **stderr**; stdout carries only the report JSON, and only on exit `0`.

Exit codes:

| Code | Meaning                                                                                                                                                                                                        | CI label                        |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `0`  | Review completed and the output matched the schema. The report's `result` is `passed` or `failed`.                                                                                                             | `ai-cr:passed` / `ai-cr:failed` |
| `1`  | Configuration error: bad flags, missing API key, invalid limit, or a diff or body file that cannot be read. **No API call was made.**                                                                          | `ai-cr:error`                   |
| `2`  | The agent failed: an error result (including the turn or budget cap), output that doesn't match the schema, no result at all, or a session whose tool list could not be verified as exactly `StructuredOutput` | `ai-cr:error`                   |
| `3`  | Nothing reviewable: the diff is empty, over the size limit, not a unified diff, or has no text hunks. **No API call was made.**                                                                                | `ai-cr:skipped`                 |

A missing API key is exit `1`, never `3`: a misconfigured workflow must not read as "nothing to review".

Other scripts:

- `npm test`: unit tests for the schema, decision rule, prompt, config, rendering, input checks, lockdown check
  and result interpretation. Hermetic, with no network and no credit spent.
- `npm run typecheck`: `tsc --noEmit` for this package only.

## Review criteria and result

The model scores five criteria, each an integer from 1 (worst) to 10 (best). The rubric, with its 1 and 10
anchors, lives in `SYSTEM_PROMPT` (`src/prompt.ts`):

| Key               | Criterion                      |
| ----------------- | ------------------------------ |
| `correctness`     | Implementation correctness     |
| `security`        | Security and safety            |
| `idiomaticity`    | Idiomaticity                   |
| `testCoverage`    | Test/risk coverage             |
| `maintainability` | Complexity and maintainability |

`decideResult` turns a schema-valid review into the result:

- **`failed`** if any score is below **6**, or any finding is `critical` or `major` (whatever its criterion);
- **`passed`** otherwise. A 6 passes; the minimum score decides, never the mean.

## Output shape

```jsonc
{
  "summary": "one-paragraph overview",
  "scores": {
    "correctness": { "score": 8, "rationale": "…" },
    // likewise security, idiomaticity, testCoverage, maintainability — all five required
  },
  "findings": [
    {
      "file": "src/example.ts",
      "line": 12,                       // optional
      "severity": "critical" | "major" | "minor" | "nit",
      "criterion": "correctness" | "security" | "idiomaticity" | "testCoverage" | "maintainability",
      "title": "short label",
      "explanation": "what is wrong and why",
      "failureScenario": "concrete input → wrong output"
    }
  ],
  "result": "passed" | "failed",       // computed by decideResult, not by the model
  "reasons": ["security scored 4 (minimum 6)"],
  "meta": {
    "model": "…",                     // as reported by the run, never hard-coded
    "costUsd": 0.01,
    "durationMs": 4200,
    "sessionId": "…",
    "numTurns": 1,
    "tools": ["StructuredOutput"]      // tool list from the init message; nothing else expected
  }
}
```

`findings: []` is a valid answer. The reviewer is told to report only findings that come with a concrete
failure scenario.

## Isolation: what the agent can and cannot do

The reviewer should judge the pull request on its own, not your personal Claude Code setup. The repo conventions
it checks against are written into its system prompt as prose; it never reads them from the repository. It runs
with:

- **No tools.** `tools: []` and `permissionMode: "dontAsk"`. It cannot read files, grep, or run commands. It
  sees only the title, description and diff you pass. `allowedTools` is deliberately not used, because it only
  auto-approves tools and does not remove any.
- **No inherited settings.** `settingSources: []`. No `~/.claude` settings or rules, and no CLAUDE.md, hooks,
  skills or commands from this repo.
- **Its own system prompt.** A plain string that replaces the Claude Code preset.

What this means in practice:

- Bugs that are only visible with context from outside the diff (callers, types defined elsewhere, config) are
  out of reach by design.
- The title, description and diff each sit in their own delimited block in the prompt, every block marker is
  defused in every block, and the agent is told to treat all three as data rather than instructions. That
  reduces the risk of prompt injection from PR content, but does not remove it — one reason the result is
  advisory.
- `settingSources: []` does not cover everything the SDK reads. Managed policy settings and `~/.claude.json`
  are still read, and so is auto memory. See [docs/query-options.md](docs/query-options.md#what-settingsources-does-not-control).
  In CI, `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` is set in the step environment (the composite action does this); the
  SDK subprocess inherits it, because the CLI deliberately passes no `env` option.
- The init message's tool list is logged on every run and saved in `meta.tools`. A run whose tool list is
  missing or differs from `["StructuredOutput"]` fails with exit `2` rather than producing a report.

## Reference docs

[`docs/`](docs/README.md) holds the Agent SDK documentation this package was built from (fetched via Context7,
SDK `0.3.270`): options, permissions, structured outputs, and message and error handling.
