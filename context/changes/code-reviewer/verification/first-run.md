# First real run — planted-bug fixture

Date: 2026-09-14 · Phase 3 of `plan.md`.

## Setup

- Command (in `packages/code_reviewer`): `npm run review -- fixtures/planted-bug.diff`
- `@anthropic-ai/claude-agent-sdk` 0.3.270 · Node v22.18.0 · Windows 11
- Auth: `ANTHROPIC_API_KEY` from the package's `.env` (the init message reports `apiKeySource: ANTHROPIC_API_KEY`). No `REVIEW_MODEL` override.
- Answer key: `packages/code_reviewer/fixtures/planted-bug.expected.md`, written before either attempt.

## Attempts

### Attempt 1: plumbing failure (exit 2, $0.00)

- Init message: model `claude-opus-5[1m]`, tools `["StructuredOutput"]`.
- Result: `subtype=success`, `is_error=true`, `terminal_reason=api_error`, 1 turn, cost $0.0000, 528 ms.
- Cause: `API Error: 400 This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header…`. The key was the problem, not the agent.
- The CLI mapped it to exit 2 correctly, but printed an **empty** error. The `success` + `is_error` result shape has no `errors` array, and `interpretResult` dropped `result`, the only field that carries the API message. The cause was found with a throwaway diagnostic script (a no-cost minimal `query()`), and then fixed: `result.ts` now passes `result` through as the error text, with an assertion in `result.test.ts`.
- Fix on the operator side: the key was replaced with a workspace-scoped key. No code change was needed for auth.

### Attempt 2: the recorded run (exit 0)

| | |
| --- | --- |
| Exit code | 0 |
| Model (from init message) | `claude-opus-5[1m]` |
| Session tools (from init message) | `["StructuredOutput"]` (the expected lockdown list, nothing else) |
| Cost | $0.066499 |
| Duration | 19 269 ms |
| Turns | 3 |
| Verdict | `request_changes` |
| Findings | 1 |
| Report | `first-run.json` (a copy of `packages/code_reviewer/output/2026-09-13T23-17-33.975Z-planted-bug.json`) |

The saved report was also re-validated outside the CLI: it passes `ReviewOutput.strict()` (no extra keys in the report body), and `meta.tools` is exactly `["StructuredOutput"]`.

## Judgment against `planted-bug.expected.md`

**Found.** Both "found" conditions hold:

1. Location: `src/lib/rate-limit.ts`, `line: 11`, the exact planted line.
2. Same defect: "Off-by-one in canMakeRequest allows one request past REQUESTS_PER_WINDOW". It names `<=` vs `<`, the 21st request, and the contradiction with `remainingRequests(20) === 0`. That is the same failing input the answer key gives.

Severity `major` with verdict `request_changes` matches the rubric in the system prompt.

**False positives:** none. No finding on `remainingRequests`, input validation, callers or concurrency, and no style notes.

## Observations for future work

- **Turns ran up to the cap.** `num_turns` was 3, and `MAX_TURNS` is 3. Delivering the output through the `StructuredOutput` tool uses turns, so a run needing one structured-output retry could end in `error_max_turns`. If that shows up, raise `MAX_TURNS` in `review.ts` (for example to 5). It was not raised here because the run succeeded.
- **Cost:** about $0.07 for a 12-line diff on the SDK's default model (Opus 5, 1M context). A cheaper model through `REVIEW_MODEL` is the obvious lever for larger or repeated runs.
- **`sessionId`** in the report is a local SDK session UUID. It is not an account, workspace, or key identifier.
