---
change_id: ci-cd-code-review
title: First CI/CD workflow for automated PR code reviews using packages/code_reviewer
status: implementing
created: 2026-09-14
updated: 2026-09-14
archived_at: null
---

## Notes

introducing first ci/cd workflow for pr code reviews based on c:\Users\marci\workspace\10xMedia\packages\code_reviewer

## Status snapshot (2026-09-14)

All four phases' code and docs are committed and `code-reviewer` is merged into `master`. The change stays
`implementing` because manual verification is still open — the `## Progress` section of `plan.md` is authoritative;
this is the short list of what is left:

1. **Phase 1–3 manual read-throughs** (1.4, 1.5, 3.5, 3.6) and **Phase 2 local paid runs** (2.5–2.7) — never done.
2. **Phase 4 live scenarios** (4.5–4.9) — run them on the next small real PR to `master`, not the introducing PR
   (see `verification/live-run.md` for why). 4.4 (secret) is done. The opened-PR happy path is already proven on a
   sandbox PR (PR #3, `ai-cr:failed`, $0.05) — record it but still tick 4.5 on a PR to `master`.
3. **4.10 calibration** — operator's own scores vs. the model's for at least two PRs, in `verification/live-run.md`.
4. **Defect to fix before calling it done:** unsanitized model text in the sticky comment (`render.ts`) — details
   in `verification/live-run.md`, "Defects found by the smoke run".

Then: flip the remaining Progress rows, `status: implemented`, epilogue commit, optional `/10x-impl-review`.
