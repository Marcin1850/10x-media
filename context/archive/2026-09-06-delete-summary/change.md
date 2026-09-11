---
change_id: delete-summary
title: Delete summary
status: archived
created: 2026-09-06
updated: 2026-09-11
archived_at: 2026-09-11T00:09:03Z
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

- **Review triage closed, 2026-09-07** (`877f017`). All three impl-review warnings were fixed rather
  than accepted. F1: a thrown `DELETE` fetch is no longer read as proof the row survived —
  `reconcileDelete` probes `GET /api/summaries` while the tombstone is still held, so an absent row
  keeps the card gone, a present row restores it with the (now verified) network message, and a
  failed probe restores it with new copy `summaryDeleteUnknown`. F2: this roadmap's stale S-03
  handoff and Parked entry. F3: `plan.md` + `plan-brief.md` resynced to the shipped rollback rule and
  the `initialSummaries` filter exception. **No automated test covers F1's three branches** — this
  repo has no component-test layer by design, so they rest on manual verification only.

- **Merged and deployed, 2026-09-07.** Merge `e7fe55c` into `master` (`--no-ff`, 13 commits, 18 files,
  +2608/-18), pushed as `02ece10..e7fe55c`. CI run 34069014104 green on all three jobs (`ci`,
  `integration`, `deploy`); Worker version `56e5a5ba-f78e-4f2d-b058-2d6ca38235bc` at
  `https://10x-media.nightshiftlab.workers.dev`. **Both halves of the deploy have run.** CI uploads
  the Worker only — it never runs `supabase db push` — so the comment-only migration
  `20260906170000` was pushed by hand the same day: `npx supabase db push --linked` applied exactly
  that one migration (confirmed by a `--dry-run` first), and `supabase migration list --linked` now
  reports local and remote in sync across all 35. Production's `begin_generation` therefore no longer
  carries the settled-with-no-summary claim the migration exists to retract. `status` stays
  `impl_reviewed` — there is no "merged" value in the vocabulary, and `/10x-archive` expects
  `implemented` or `impl_reviewed`. Archiving is deliberately deferred (user decision).
