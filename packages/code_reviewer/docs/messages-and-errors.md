# Messages, result subtypes, errors, cost

Sources:

- https://code.claude.com/docs/en/agent-sdk/typescript (SDKResultMessage, SDKSystemMessage)
- https://code.claude.com/docs/en/agent-sdk/sessions (capturing session id)
- https://code.claude.com/docs/en/agent-sdk/agent-loop (message types)
- https://code.claude.com/docs/en/agent-sdk/cost-tracking (cost on failed runs)
- https://code.claude.com/docs/en/agent-sdk/python (ResultMessage field semantics, error types; the TypeScript
  `SDKResultMessage` mirrors them)

## `SDKSystemMessage`: `type: "system"`, `subtype: "init"`

The first message of a session. It is the proof of what the session actually got:

- `session_id`, `uuid`
- **`tools: string[]`**: tools available in this session
- **`model: string`**: model identifier actually in use
- `permissionMode`, `cwd`, `apiKeySource`, `claude_code_version`
- `mcp_servers: { name, status }[]`, `slash_commands`, `skills`, `plugins`, `agents?`, `betas?`
- `output_style`, `effort?`, `capabilities?`, `fast_mode_state?`

## `SDKResultMessage`: `type: "result"`

```typescript
type SDKResultMessage =
  | {
      type: "result";
      subtype: "success";
      uuid: UUID;
      session_id: string;
      duration_ms: number;
      duration_api_ms: number;
      is_error: boolean;
      api_error_status?: number | null;
      num_turns: number;
      result: string;
      stop_reason: string | null;
      total_cost_usd: number;
      usage: NonNullableUsage;
      modelUsage: { [modelName: string]: ModelUsage };
      permission_denials: SDKPermissionDenial[];
      structured_output?: unknown;
      terminal_reason?: TerminalReason;
      // … timing / fast-mode / origin fields omitted
    }
  | {
      type: "result";
      subtype:
        | "error_max_turns"
        | "error_during_execution"
        | "error_max_budget_usd"
        | "error_max_structured_output_retries";
      uuid: UUID;
      session_id: string;
      duration_ms: number;
      duration_api_ms: number;
      is_error: boolean;
      num_turns: number;
      stop_reason: string | null;
      total_cost_usd: number;
      usage: NonNullableUsage;
      modelUsage: { [modelName: string]: ModelUsage };
      permission_denials: SDKPermissionDenial[];
      errors: string[];
      terminal_reason?: TerminalReason;
      // …
    };
```

### Field semantics

- **`is_error`**: `true` on every `error_*` subtype. **On `subtype: "success"` it is `true` when the final model
  request failed**: the loop completed, but the last API call returned an error.
- `api_error_status`: HTTP status of the terminating API error. Only set on `success`.
- `result`: final assistant text on `success`. When `success` and `is_error` are both true it may hold the API
  error string, or be empty.
- `errors`: loop-level error strings (e.g. max turns). Only set on `error_*`.
- **`terminal_reason`**: why the loop ended. Values include `"completed"`, `"max_turns"`, `"api_error"`,
  `"aborted_streaming"` and `"aborted_tools"`. It may be absent on older CLIs and on synthesized fatal-error
  results.
- `permission_denials`: tool calls that were denied. Useful to see whether a tool-less agent tried to use one.

> When the final request fails, such as on an API error, Claude Code reports subtype `"success"` with the cause
> in `terminal_reason`, for example `"api_error"`. When a limit you set ends the run, such as `max_turns` or
> `max_budget_usd`, it reports an `error_*` subtype. **Check `terminal_reason` before `subtype`.**

## Throw-after-error and no-result failures

```typescript
let sessionId: string | undefined;

try {
  for await (const message of query({
    prompt: "…",
    options: {
      /* … */
    },
  })) {
    if (message.type === "result") {
      sessionId = message.session_id;
      if (message.subtype === "success") console.log(message.result);
    }
  }
} catch (error) {
  // A single-shot query() throws after yielding an error result. If the
  // failure was an error result, the loop above already captured sessionId;
  // connection or process failures yield no result message, so sessionId stays undefined.
  console.error(`Session ended with an error: ${error}`);
}
```

So there are two failure channels:

1. **Error result, then throw.** The `result` message is yielded (subtype, cost, session id available), then
   iteration throws.
2. **Throw with no result.** Process or connection failure. Nothing to interpret.

The loop ending normally does not mean success. Decide the outcome from the captured result message.

Python exposes typed errors (`CLINotFoundError`, `ProcessError`, `ResultError` ⊂ `ProcessError`,
`CLIJSONDecodeError`). The TypeScript docs fetched here only show a generic `catch`.

## Cost tracking

- Both success and error results carry `usage` and `total_cost_usd`. Read the cost from **every** result
  message: a failed run still spent tokens.
- `error_during_execution` after a session crash may report every cost field as zero.
- `error_max_budget_usd`: `usage` omits the response that crossed the budget, but `total_cost_usd` and
  `modelUsage` include it.
- Prefer `total_cost_usd` or `modelUsage` over `usage` for accounting.
