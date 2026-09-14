# Claude Agent SDK — reference notes

Material from the Claude Agent SDK documentation that this package depends on, saved so later sessions
don't need to fetch it again. These are excerpts, not a full mirror. Each file cites the page it came from;
go to that page when something here looks out of date.

|                       |                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------- |
| Context7 library ID   | `/websites/code_claude_en_agent-sdk`                                                  |
| SDK package / version | `@anthropic-ai/claude-agent-sdk` `0.3.270` (npm, as installed in `package-lock.json`) |
| Fetched               | 2026-09-14 (Context7, plus one direct fetch of _Use Claude Code features in the SDK_) |
| Upstream docs root    | https://code.claude.com/docs/en/agent-sdk/overview                                    |

## Files

| File                                                     | Covers                                                                                                                                                                                                           |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [overview-and-quickstart.md](overview-and-quickstart.md) | Install, ESM + `tsx`, auth, the basic `query()` loop                                                                                                                                                             |
| [query-options.md](query-options.md)                     | TypeScript `Options` this package uses: `tools` vs `allowedTools` vs `disallowedTools`, `settingSources`, `systemPrompt`, `maxTurns`, `model`, `env`, `cwd` — and what `settingSources: []` does **not** isolate |
| [permissions.md](permissions.md)                         | Permission modes, how a tool request is evaluated, allow and deny rules                                                                                                                                          |
| [structured-outputs.md](structured-outputs.md)           | `outputFormat: { type: "json_schema" }`, `structured_output`, zod bridge, retry-exhausted subtype                                                                                                                |
| [messages-and-errors.md](messages-and-errors.md)         | `SDKSystemMessage` (init), `SDKResultMessage` subtypes, throw-after-error, cost and session id                                                                                                                   |

## The facts this package is built on

1. `allowedTools` only **auto-approves** tools; it does not remove any. A tool-less agent needs `tools: []` (or
   `disallowedTools: ["*"]`) plus `permissionMode: "dontAsk"`.
2. Omitting `settingSources` loads user + project + local settings, including CLAUDE.md files, rules and hooks.
   `settingSources: []` loads none of them. It does **not** block managed policy, `~/.claude.json`, or
   **auto memory** (see `query-options.md`).
3. In TypeScript, `env` **replaces** the subprocess environment. If you pass it, spread `process.env` into it.
4. A single-shot `query()` **throws after yielding** an error result. A connection or process failure yields no
   result message at all.
5. An API failure on the final request arrives as `subtype: "success"` with `is_error: true` and a
   `terminal_reason` such as `"api_error"`. `subtype === "success"` alone does not mean the run worked.
