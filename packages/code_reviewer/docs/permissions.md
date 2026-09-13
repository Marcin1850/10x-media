# Permissions

Source: https://code.claude.com/docs/en/agent-sdk/permissions (plus `PermissionMode` from
https://code.claude.com/docs/en/agent-sdk/python)

## Permission modes

```typescript
for await (const message of query({
  prompt: "Help me refactor this code",
  options: { permissionMode: "default" },
})) {
  if ("result" in message) console.log(message.result);
}
```

| Mode                | Description                  | Tool behavior                                                                                                                                                                                                                                                                |
| :------------------ | :--------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `default`           | Standard permission behavior | No auto-approvals; unmatched tools trigger your `canUseTool` callback                                                                                                                                                                                                        |
| `dontAsk`           | Deny instead of prompting    | Anything not pre-approved by `allowedTools` or rules is **denied**. Tools that require user interaction are denied even if pre-approved, and so are connector tools your org set to `ask` and `rm`/`rmdir` removals targeting a critical path. `canUseTool` is never called. |
| `acceptEdits`       | Auto-accept file edits       | File edits and filesystem operations (`mkdir`, `rm`, `mv`, …) are auto-approved                                                                                                                                                                                              |
| `bypassPermissions` | Bypass permission checks     | Tools run without prompts, except actions no mode auto-approves. Use with caution.                                                                                                                                                                                           |
| `plan`              | Planning mode                | Explores without editing; file edits are never auto-approved and go to `canUseTool`                                                                                                                                                                                          |
| `auto`              | Model-classified approvals   | A classifier approves or denies permission prompts                                                                                                                                                                                                                           |

Locked-down example from the docs:

```typescript
const options = {
  allowedTools: ["Read", "Glob", "Grep"],
  permissionMode: "dontAsk",
};
```

## How a tool request is evaluated

When Claude requests a tool, the SDK checks, in order:

1. **Hooks.** A hook can deny outright or pass the call on. A hook `allow` does **not** skip the deny and ask
   rules below.
2. **Deny rules** (`disallowedTools` and settings.json). A match blocks the call, even in `bypassPermissions`.
   Bare-name deny rules (`Bash`) remove the tool from context before evaluation starts, so only scoped
   rules (`Bash(rm *)`) are checked here.
3. **Ask rules** (settings.json). A match falls through to `canUseTool`, even in `bypassPermissions`.
   `AskUserQuestion` and MCP tools flagged `_meta["anthropic/requiresUserInteraction"]` always fall through.
   In `dontAsk` these are denied.
4. **Permission mode.** `bypassPermissions` approves everything that reaches this step, except critical-path
   removals. `acceptEdits` approves file operations. `plan` routes writes to `canUseTool`. Other modes fall
   through.
5. **Allow rules** (`allowedTools` and settings.json). A match approves the call. Critical-path removals are
   never approved by an allow rule.
6. **`canUseTool` callback.** Called if nothing above resolved the request. **In `dontAsk` mode this step is
   skipped and the tool is denied.** With `permissionPrompts: 'none'` (TypeScript) the callback is not
   called either: a `PermissionRequest` hook may decide, and otherwise the call is denied.

## Allow and deny rules

`allowedTools` / `disallowedTools` add entries to the allow and deny lists above. Naming a task-tracking tool in
`allowedTools` also opts the session into task tracking. **Any tool not listed in `allowedTools` is still
available to Claude** and falls through to the permission mode.

| Option                            | Effect                                                                                                                 |
| :-------------------------------- | :--------------------------------------------------------------------------------------------------------------------- |
| `allowed_tools=["Read", "Grep"]`  | `Read` and `Grep` are auto-approved. Other tools still exist and fall through to the permission mode and `canUseTool`. |
| `disallowed_tools=["Bash"]`       | The `Bash` tool definition is removed from the request. Claude does not see it and cannot attempt it.                  |
| `disallowed_tools=["Bash(rm *)"]` | `Bash` stays available; matching calls are denied in every mode, including `bypassPermissions`.                        |
| `disallowed_tools=["*"]`          | Every tool definition is removed. `"*"` matches every tool, and `"mcp__*"` matches every MCP tool.                     |

## Consequence for a tool-less reviewer

- `allowedTools: []` removes nothing, because it only approves.
- `tools: []` restricts the built-in set to nothing. `permissionMode: "dontAsk"` makes any tool that still
  exists (MCP, injected) get denied instead of prompting.
- Belt and braces: `disallowedTools: ["*"]` removes every tool definition from the request.
- Settings-borne rules (settings.json allow/ask) only load through `settingSources`, which should be `[]` here.
