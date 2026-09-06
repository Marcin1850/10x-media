---
change_id: delete-summary
title: Delete summary
status: implementing
created: 2026-09-06
updated: 2026-09-06
archived_at: null
---

## Notes

<!-- Free-form notes for this change: links, ad-hoc context, decisions that don't belong in research/frame/plan. -->

- **Mutation check, 2026-09-06 (ad-hoc, after Phase 2).** `npx stryker run --mutate "src/lib/services/summary-delete.ts"` — 11 mutants, 10 killed, 1 not covered. Stryker is wired to `vitest.unit.config.ts`, so `summary-delete.ts` is the only file this slice puts in its reach; `[id].ts` and both `*.int.test.ts` files are outside it by construction. The uncovered mutant was the `?? []` fallback and it was judged business-relevant rather than ignored — see `summary-delete.test.ts`'s header. Now 11/11.
