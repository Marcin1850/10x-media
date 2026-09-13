# planted-bug.diff — expected answer

Written before the first run, so the run cannot shape it.

## The planted bug

- **File:** `src/lib/rate-limit.ts`
- **Line:** 11 (new file) — `return used <= REQUESTS_PER_WINDOW;`
- **Defect:** off-by-one boundary. `used` is the number of requests _already made_, so one more request is
  allowed only while `used < REQUESTS_PER_WINDOW`. With `<=`, an account that has already made the full 20
  requests is still allowed a 21st.
- **Concrete failing input:** `canMakeRequest(20)` returns `true`; the contract in its doc comment requires
  `false`. It also contradicts its sibling in the same diff: `remainingRequests(20)` returns `0`.
- **Fix (for reference only):** `return used < REQUESTS_PER_WINDOW;`

## What counts as "found"

A finding counts when **both** hold:

1. It points at line 11, or at the `canMakeRequest` function / its hunk if the line number is missing or off
   by a line or two.
2. It describes the same defect: the comparison lets one request too many through at the limit (off-by-one,
   `<=` should be `<`, the 21st request is allowed, inconsistent with `remainingRequests`).

Wording, title and severity may differ. Any severity counts, though `major` or `critical` is what the
system prompt's rubric implies, with a `request_changes` verdict.

## False positives worth noting

The rest of the diff is correct as far as the diff alone can tell. Record, but do not count as "found", any
finding that:

- flags `remainingRequests` (its `Math.max(..., 0)` clamp is correct);
- flags negative or non-integer `used` with no concrete scenario inside the diff (input validation is
  outside what the diff shows);
- speculates about callers, window reset, or concurrency — context the agent was not given;
- is a style/naming note (the prompt forbids those unless they cause a bug).
