# `query()` options (TypeScript)

Sources:

- https://code.claude.com/docs/en/agent-sdk/typescript (Options, SettingSource)
- https://code.claude.com/docs/en/agent-sdk/permissions (Allow and deny rules)
- https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts
- https://code.claude.com/docs/en/agent-sdk/claude-code-features (settingSources, what it does not control)
- https://code.claude.com/docs/en/agent-sdk/subagents, https://code.claude.com/docs/en/agent-sdk/hosting (`env`, `cwd`)
- https://code.claude.com/docs/en/agent-sdk/migration-guide (settingSources default)

Only the options this package cares about are covered here. The full table is on the TypeScript reference page.

## Tools: `tools` vs `allowedTools` vs `disallowedTools`

These three look alike but do different things.

| Option            | Type                                                    | Effect                                                                                                                                                                                                                                               |
| ----------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tools`           | `string[] \| { type: 'preset'; preset: 'claude_code' }` | Sets which tools exist. Pass an array of tool names, or the preset for Claude Code's defaults. `[]` means no built-in tools.                                                                                                                         |
| `allowedTools`    | `string[]`                                              | Adds **allow rules**, which auto-approve the listed tools. Tools not listed **still exist** and fall through to the permission mode and `canUseTool`.                                                                                                |
| `disallowedTools` | `string[]`                                              | Adds **deny rules**. A bare name (`"Bash"`) removes that tool's definition from the request. A scoped rule (`"Bash(rm *)"`) keeps the tool and denies matching calls in every mode. `"*"` removes every tool, and `"mcp__*"` removes every MCP tool. |

From the permissions page:

| Option                            | Effect                                                                                                                                                                    |
| :-------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `allowed_tools=["Read", "Grep"]`  | `Read` and `Grep` are auto-approved. Other tools not listed here still exist and fall through to the permission mode and `canUseTool`.                                    |
| `disallowed_tools=["Bash"]`       | The `Bash` tool definition is removed from the request. Claude does not see the tool and cannot attempt it.                                                               |
| `disallowed_tools=["Bash(rm *)"]` | `Bash` stays available. Calls matching `rm *` are denied in every permission mode, including `bypassPermissions`. Other `Bash` calls fall through to the permission mode. |
| `disallowed_tools=["*"]`          | Every tool definition is removed from the request. Tool-name globs are supported in deny rules.                                                                           |

The docs' "locked-down agent" example is `allowedTools: [...]` plus `permissionMode: "dontAsk"`. It
approves the listed tools and denies everything else **at call time**. The other tools are still
visible to the model.

**For this package:** `tools: []` + `permissionMode: "dontAsk"`. If structured output turns out to need an
internal tool that `tools: []` removes, the fallback is a deny list (`disallowedTools`), never the default tool
set. Verify the result from the `tools` array of the `system`/`init` message (`messages-and-errors.md`).

## `settingSources`

`SettingSource = "user" | "project" | "local"`.

Omitting `settingSources` or passing `undefined` loads the same filesystem settings as the CLI,
equivalent to `["user", "project", "local"]`. That includes `~/.claude/settings.json`,
`.claude/settings.json`, `.claude/settings.local.json`, CLAUDE.md files, rules, hooks, skills and custom
commands. (The default was briefly "none" in v0.1.0 and was then reverted.)

```typescript
// Do not load user, project, or local settings from disk
const result = query({ prompt: "Analyze this code", options: { settingSources: [] } });
```

| Source      | What it loads                                                                                                      | Location                                                                                                                                                                |
| :---------- | :----------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `"project"` | Project `settings.json` and hooks; project CLAUDE.md and `.claude/rules/*.md`; project skills, commands, subagents | `<cwd>/.claude/` for settings and hooks; `<cwd>` **and every parent directory** for CLAUDE.md and rules; `<cwd>` up to the repo root for skills, commands and subagents |
| `"user"`    | User `settings.json`; `~/.claude/CLAUDE.md` and `~/.claude/rules/*.md`; user skills, commands, subagents           | `~/.claude/`                                                                                                                                                            |
| `"local"`   | `CLAUDE.local.md`, `.claude/settings.local.json`                                                                   | `<cwd>/.claude/`; `<cwd>` and every parent for `CLAUDE.local.md`                                                                                                        |

`cwd` decides where project inputs are looked up. This package lives inside a repo whose parent directories
contain a `CLAUDE.md` and a `.claude/`, so the default would pull them in. That is why it passes `[]`.

### What `settingSources` does NOT control

These are read **regardless** of `settingSources`:

| Input                                                                  | Behavior                                                                                                                                                                                                                                                                 | To disable                                                                                                                        |
| :--------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------- |
| Managed policy settings                                                | Endpoint-managed policy (MDM plist, registry policy, managed settings file) loads from the host. Server-managed settings are fetched when the session authenticates with a qualifying credential, including a directly configured API key, on an eligible configuration. | Endpoint: remove the policy from the host. Server-managed: only an org Owner controls them; they cannot be disabled from the SDK. |
| `~/.claude.json` global config                                         | Always read                                                                                                                                                                                                                                                              | Relocate with `CLAUDE_CONFIG_DIR` in `env`                                                                                        |
| **Auto memory** at `~/.claude/projects/<project>/memory/`              | **Loaded into the system prompt at session start.** Writing new memories needs `Write`/`Edit`.                                                                                                                                                                           | `autoMemoryEnabled: false` in settings, or `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` in `env`                                           |
| claude.ai MCP connectors                                               | Loaded when the session authenticates with a claude.ai login (not the case for an API key). `mcpServers: {}` does not suppress them.                                                                                                                                     | `strictMcpConfig: true`, `disableClaudeAiConnectors: true` in settings, or `ENABLE_CLAUDEAI_MCP_SERVERS=false` in `env`           |
| `sandbox.credentials` deny / mask entries in `~/.claude/settings.json` | Applied as restrictions when the command sandbox runs                                                                                                                                                                                                                    | Remove the entries                                                                                                                |

> Do not rely on default `query()` options for multi-tenant isolation. […] set `settingSources: []` plus
> `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` in `env`.

Hosting example:

```typescript
for await (const message of query({
  prompt,
  options: {
    cwd: tenantDir,
    settingSources: [],
    env: { ...process.env, CLAUDE_CONFIG_DIR: configDir, CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" },
  },
})) {
  // ...
}
```

**Relevance here:** the developer machine has auto memory for this repo's working directory. With
`settingSources: []` alone, that memory would still reach the reviewer's system prompt.

## `systemPrompt`

- Omitted: minimal SDK system prompt (not Claude Code's).
- `{ type: "preset", preset: "claude_code" }`: Claude Code's full system prompt.
- A plain `string` replaces the system prompt with your text.

```typescript
const customPrompt = `You are a Python coding specialist. …`;
for await (const message of query({
  prompt: "Create a data processing pipeline",
  options: { systemPrompt: customPrompt },
})) {
  // ...
}
```

## `env`

`env` **replaces** the subprocess environment. It is not merged. Spread `process.env` to keep `PATH`, the API
key, etc.:

```typescript
env: { ...process.env, CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: "1" }
```

Environment knobs documented alongside `env`:

- `API_TIMEOUT_MS`: per-request timeout (default 600000)
- `CLAUDE_CODE_MAX_RETRIES`: max API retries (default 10, max 15)
- `CLAUDE_STREAM_IDLE_TIMEOUT_MS`: stream watchdog idle timeout (default 300000)
- `CLAUDE_ENABLE_STREAM_WATCHDOG`: default 1

## `cwd`

The working directory of the Claude Code process. It decides where project settings and CLAUDE.md are
looked up, and the file root the tools see. It defaults to the current process directory.

## Other options used or considered

| Option              | Notes                                                                                                            |
| ------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `model`             | Model id string. Omit it to use the default. The model actually used is reported in the `system`/`init` message. |
| `maxTurns`          | Turn cap. Hitting it ends the run with `subtype: "error_max_turns"`.                                             |
| `maxBudgetUsd`      | Spend cap. Hitting it gives `subtype: "error_max_budget_usd"`.                                                   |
| `permissionMode`    | See `permissions.md`.                                                                                            |
| `outputFormat`      | See `structured-outputs.md`.                                                                                     |
| `skills`            | `"all"`, a list of names, or `[]`. When set, the SDK adds `Skill` to `allowedTools`.                             |
| `permissionPrompts` | `'none'` stops `canUseTool` from being called (Claude Code ≥ v2.1.259).                                          |
