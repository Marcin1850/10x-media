# code_reviewer

A code-review agent built on the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview). You give
it a unified diff. It reviews the diff for correctness bugs and returns JSON findings validated by zod.

> **Status: first version / spike.** It runs one diff file at a time, and nothing else uses it yet: no git
> hooks, no CI, no 10x skills. It is a standalone package, so the Astro app at the repo root does not depend
> on it, and the root's typecheck, lint and tests ignore it.

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

| Variable            | Required | Meaning                                                                          |
| ------------------- | -------- | -------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY` | yes      | Anthropic API key. The run refuses to start without it, and no API call is made. |
| `REVIEW_MODEL`      | no       | Model id override. Leave it unset for the SDK default.                           |

`.env` is gitignored by the root `.gitignore`. Only `.env.example` is committed.

## Run

```bash
npm run review -- <path-to-diff-file>
# e.g.
npm run review -- fixtures/planted-bug.diff
```

The input is a unified diff in a file, for example one written by `git diff > my.diff`. The CLI does not run
git itself.

Input limits, all checked before any API call:

- The path must be a regular file of at most **200,000 bytes** (`MAX_DIFF_BYTES` in `src/diff-input.ts`). The
  size is checked before the file is read.
- The content must look like a unified diff: a `---`/`+++` file header pair and at least one `@@` hunk. A file
  that isn't a diff (a mistyped `.env`, a config file) is refused, and so is a diff with only binary, rename or
  mode changes.
- The check cannot see secrets **inside** a valid diff. Everything in the file is sent to the Anthropic API, so
  look at the diff before you review it.

What the run does:

1. Prints the session's tool list and model, taken from the SDK's init message. It must be exactly `StructuredOutput`, the SDK's internal tool for delivering JSON-schema output. If the init message is missing or lists anything else, the CLI exits `2` and does not print or save the review.
2. Prints the report and the run's cost in USD.
3. Writes the report to `output/<ISO-timestamp>-<diff-basename>.json`. `output/` is gitignored.

Exit codes:

| Code | Meaning                                                                                                                                                                                     |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | Review completed and the output matched the schema                                                                                                                                          |
| `1`  | Configuration or input error, such as a missing diff argument, missing API key, or a diff file that is missing, empty, over the size limit or not a unified diff. **No API call was made.** |
| `2`  | The agent failed: an error result, output that doesn't match the schema, no result at all, or a session whose tool list could not be verified as exactly `StructuredOutput`                 |

Other scripts:

- `npm test`: unit tests for the schema, prompt, config, input checks, lockdown check and result interpretation. Hermetic, with no network
  and no credit spent.
- `npm run typecheck`: `tsc --noEmit` for this package only.

## Output shape

```jsonc
{
  "verdict": "approve" | "request_changes" | "comment",
  "summary": "one-paragraph overview",
  "findings": [
    {
      "file": "src/example.ts",
      "line": 12,                       // optional
      "severity": "critical" | "major" | "minor" | "nit",
      "title": "short label",
      "explanation": "what is wrong and why",
      "failureScenario": "concrete input → wrong output"
    }
  ],
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

`findings: []` with `verdict: "approve"` is a valid answer. The reviewer is told to report only defects that
come with a concrete failure scenario.

## Isolation: what the agent can and cannot do

The reviewer should judge the diff on its own, not the repo's conventions or your personal Claude Code setup.
It runs with:

- **No tools.** `tools: []` and `permissionMode: "dontAsk"`. It cannot read files, grep, or run commands. It
  sees only the diff you pass. `allowedTools` is deliberately not used, because it only auto-approves tools and
  does not remove any.
- **No inherited settings.** `settingSources: []`. No `~/.claude` settings or rules, and no CLAUDE.md, hooks,
  skills or commands from this repo.
- **Its own system prompt.** A plain string that replaces the Claude Code preset.

What this means in practice:

- Bugs that are only visible with context from outside the diff (callers, types defined elsewhere, config) are
  out of reach by design.
- The diff is wrapped in a delimited block in the prompt, and the agent is told to treat its content as data
  rather than instructions. That reduces the risk of prompt injection from diff content, but does not remove
  it.
- `settingSources: []` does not cover everything the SDK reads. Managed policy settings and `~/.claude.json`
  are still read, and so is auto memory. See [docs/query-options.md](docs/query-options.md#what-settingsources-does-not-control).
- The init message's tool list is logged on every run and saved in `meta.tools`. A run whose tool list is
  missing or differs from `["StructuredOutput"]` fails with exit `2` rather than producing a report.

## Reference docs

[`docs/`](docs/README.md) holds the Agent SDK documentation this package was built from (fetched via Context7,
SDK `0.3.270`): options, permissions, structured outputs, and message and error handling.
