## Overall concept

- GHA workflow run for every new pull request to master
- composite action for the review itself so that main workflow is easy to reason about

## Input parameters

- pull request title
- pull request description (?? cost tradeoff)
- git diff

## Code Review Criteria

Each criterion is scored on a 1–10 scale, where 1 is the worst outcome and 10 is the best.

### 1. Implementation correctness

The change does exactly what the PR title and description claim, including on edge paths — errors, retries, races, and the paid path (credit reservation, settlement, refund).

- **(1)** The code does not achieve its stated goal or breaks existing behavior — e.g. charges a credit for failed work, loses a refund, or returns a multi-cause error status without a `code`.
- **(10)** Every path, happy and failing, produces an outcome consistent with the sources (PRD, README credit rules, the function's documented contract), and ambiguous cases (`ambiguousCharge`) are handled explicitly rather than glossed over.

### 2. Security and safety

The change does not widen access to data or secrets, and does not open a path to uncontrolled spend on paid vendors.

- **(1)** A new table without RLS or missing `revoke ... service_role`, the service-role key reachable from client code, a DSN or secret committed to the repo, user identifiers in a Sentry payload, or a test that can spend real Supadata/OpenRouter credits.
- **(10)** Privileges are minimal and classified in the `authorization-invariants` roster, secrets are read only through `astro:env/server`, events go through `reporting.ts` without identifiers, and the paid vendor boundary is faked in every test layer.

### 3. Idiomaticity

The code reads like the rest of the repository — it uses the project's existing seams, aliases, and patterns instead of inventing its own.

- **(1)** Hand-concatenated class strings instead of `cn()`, hand-written shadcn components, an API route without `prerender = false` or zod validation, `import.meta.env` instead of `astro:env`, a second reporting mechanism beside `reporting.ts`, or a React island where `.astro` would do.
- **(10)** Everything lands in its established place (`src/lib/services`, `src/types.ts`, `src/components/hooks`); naming, comment density, and error handling (outcomes over thrown exceptions) are indistinguishable from the surrounding code, and any new deviation from convention is justified.

### 4. Test/risk coverage

A change touching a risk from `test-plan.md` is covered at the cheapest layer that still gives a signal, with the oracle taken from sources rather than from the implementation.

- **(1)** No tests for a change to the paid path or the data boundary; tests that recompute the expected value the way the code does; UI-only assertions without the ledger in e2e; `waitForTimeout`, CSS selectors, or visibility probes through an RLS-bypassing connection.
- **(10)** Every touched risk has a test at the right layer (pure/hermetic, integration with a real balance, or e2e with a two-sided oracle), each `it.each` row catches a different regression, and the tests are shaped so a deliberate break would turn them red.

### 5. Complexity and maintainability

The solution is the simplest one that meets the requirements, the diff's scope matches the task, and load-bearing documentation keeps pace with the code.

- **(1)** Speculative abstractions, duplicated logic, unrelated changes bundled into the PR, functions that cannot be followed without a debugger, or README / CLAUDE.md / header comments left contradicting the new behavior.
- **(10)** The diff is small and focused, every new layer is justified by a concrete need, the code reads linearly, and README, CLAUDE.md, `test-plan.md`, and header comments are updated exactly where the change altered behavior.

## Parked for later

- business alignment (require broader context)
- architectural fit (require broader context)

## Expected side-effects

- PR comment with summary
- labels: `ai-cr:failed` (red) OR `ai-cr:passed` (green)

## Expected behavior

- on-demand retry when label `ai-cr:review` is added
