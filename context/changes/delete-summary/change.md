---
change_id: delete-summary
title: Delete summary
status: implemented
created: 2026-09-06
updated: 2026-09-07
archived_at: null
---

## Notes

<!-- Free-form notes for this change: links, ad-hoc context, decisions that don't belong in research/frame/plan. -->

- **Mutation check, 2026-09-06 (ad-hoc, after Phase 2).** `npx stryker run --mutate "src/lib/services/summary-delete.ts"` — 11 mutants, 10 killed, 1 not covered. Stryker is wired to `vitest.unit.config.ts`, so `summary-delete.ts` is the only file this slice puts in its reach; `[id].ts` and both `*.int.test.ts` files are outside it by construction. The uncovered mutant was the `?? []` fallback and it was judged business-relevant rather than ignored — see `summary-delete.test.ts`'s header. Now 11/11.

- **Phase 3 manual pass, 2026-09-07 (local stack, synthetic account).** All 8 manual rows (3.7-3.14)
  confirmed by the user against `localhost:4321`, including the paid row 3.12. The local database had
  no data at all when the pass began — schema fully migrated, every table empty — so the account and
  five `videos`/`summaries` rows were seeded first (one video under both characters, one all-null-metadata
  row in the pre-S-08 shape, distinct `created_at` so 3.11's restore-in-order actually discriminates).
  Ruled out the integration suite as the cause: `synthetic-account.ts:116` deletes only the account it
  created, by id, and `integration-setup.ts`'s stale-account guard reports without deleting.
  **Ledger evidence for the slice's headline invariant:** 6 summaries existed, 2 remained (4 deleted),
  and the balance moved 5 -> 4 against exactly one `settled` reservation — the generation. The four
  deletions moved the balance by **0**, observed rather than reasoned about.
- **Alignment fix after the manual pass.** The trash control sat 4px below the expand chevron: the
  container carried `mt-1` *and* the button carried `p-1`, while the chevron has only `mt-1`. Dropped
  the container's `mt-1` so both icon centres land at 12px; verified in-browser in both the idle and
  the confirming state, and that Escape returns focus to the trigger.
