# Lessons Learned

> Append-only register of recurring rules and patterns. Re-read at start by /10x-frame, /10x-research, /10x-plan, /10x-plan-review, /10x-implement, /10x-impl-review.

## Linear MCP: create_issue_label takes teamId (UUID), not team

- **Context**: Linear MCP calls that name a team. The field is not uniform — `create_issue_label` is the exception: it requires `teamId` (UUID). Most of the others (`save_issue`, `list_issue_statuses`, `save_document`) accept `team` (name/ID), and `save_project` uses `addTeams`/`setTeams`.
- **Problem**: Inconsistent team field — `create_issue_label` rejected the `team` key (validation error), because it expects `teamId`/UUID. 7 batched calls failed at once before the field name was corrected.
- **Rule**: Check the team field's schema before assuming its name — in Linear MCP it is not uniform (`create_issue_label` → `teamId`/UUID; most others → `team`/name or ID). When creating several objects, verify one call first, then batch the rest.
- **Applies to**: implement, impl-review (phases that reference the issue tracker)

## Update Linear status + comment at each lifecycle step

- **Context**: Any 10x change that maps to a Linear issue (10xMedia MVP project, MAR-*) — across the lifecycle: starting work, advancing it (plan written, phase implemented), or changing its state.
- **Problem**: The Linear board drifts from reality — issues sit in Todo/Backlog while work is actually planned or in progress — so the board can't be trusted to show what's live or done.
- **Rule**: At each lifecycle step (plan written, phase implemented, change archived), move the Linear issue to the matching status and log a one-paragraph comment summarizing the step before moving on.
- **Applies to**: new, plan, implement, impl-review, archive

## Sync roadmap.md and Linear on every status transition

- **Context**: Roadmap-tracked work — any change that corresponds to a roadmap item (F-/S-) in `context/foundation/roadmap.md` and is mirrored as a Linear issue.
- **Problem**: Without it, `roadmap.md` status and Linear issue state drift out of sync with the actual work — items stay `ready`/`Todo` long after work started or finished, and the board becomes unreliable.
- **Rule**: When starting AND when finishing a change, update both `context/foundation/roadmap.md` (the item's Status) and the matching Linear issue (its state) in the same session — don't defer.
- **Applies to**: all

## Multi-phase changes: one Linear comment per phase completion; status stays In Progress until the last phase

- **Context**: A change with a multi-phase plan (`plan.md` split into Phase 1..N) mirrored to a Linear issue — e.g. `transcript-llm-probe` (MAR-6), 4 phases. Each phase is implemented and impl-reviewed on its own.
- **Problem**: The generic "comment at each lifecycle step" rule got satisfied by a single comment at phase **start** ("Phase 1 … in progress"). Phase 1's **completion** and its impl-review (commits `cdc3a14`, `33857a8`, status `implementing → impl_reviewed`) then landed with no Linear trace — the board froze at "started" while work moved on. Separately, the issue **description** kept a stale `Next: /10x-plan …` pointer long after planning was done.
- **Rule**: For a multi-phase change, treat **completion of each phase** (not just the overall implement step) as its own lifecycle event: post a Linear comment summarizing what that phase landed + its impl-review verdict, in the same session the phase closes. Keep the issue **In Progress / implementing until the final phase is done** — do NOT flip to Done/Reviewed on an intermediate phase (`change.md` per-phase `impl_reviewed` is fine locally, but the Linear issue state reflects the whole change). Also keep the issue **description** current: update or remove stale `Next:` / `Roadmap status:` pointers when the phase they name is complete.
- **Applies to**: implement, impl-review

## Sync Backlog Handoff when a slice's status changes

- **Context**: Any edit to `context/foundation/roadmap.md` that changes a slice's Status (or completes/unblocks a prerequisite) — the At a glance table, slice status lines, and Backlog Handoff must stay in sync.
- **Problem**: The Backlog Handoff drifted out of sync: F-01/F-02 were `impl_reviewed` but the table still said "ready to plan", and it missed that S-01/S-04 had become unblocked — so it would misroute the next pick.
- **Rule**: Whenever a slice's status changes (or a prerequisite completes), update the Backlog Handoff section in the same edit — re-derive each row's "Ready for `/10x-plan`" and Notes, including any newly-unblocked downstream slices. Keep it consistent with the At a glance table and slice status lines.
- **Applies to**: implement, impl-review, plan

## Prefer curl.exe with PowerShell-friendly syntax

- **Context**: Any shell command suggested to the user during conversation on a Windows/PowerShell host.
- **Problem**: I'm not able to simply copy/paste multiline command to PowerShell terminal.
- **Rule**: When giving shell commands on Windows/PowerShell, use curl.exe with PowerShell-friendly quoting instead of the Invoke-WebRequest alias.
- **Applies to**: implement, impl-review

## Create a new branch when starting a change with /10x-new

- **Context**: Any /10x-new invocation
- **Problem**: Work lands on master
- **Rule**: Always create a new branch when /10x-new skill is used
- **Applies to**: new

## Never wipe data from the local database without consent — reach for a non-destructive alternative first

- **Context**: Any command that deletes or overwrites data in the local dev environment (`supabase db reset`, `drop`, `truncate`, overwriting a file) — whether it is part of the plan or an ad-hoc state check.
- **Problem**: The local data (users, `videos`, `summaries`) is a test asset built at real cost — regenerating the summaries costs Supadata and OpenRouter credits as well as time. On top of that, a destructive command interrupted halfway leaves the database inconsistent (here: the schema rolled back to the first migration), so repairing it requires another full reset.
- **Rule**: Never run a destructive command against the local database without explicit consent. Reach for a non-destructive alternative first (`supabase migration up`, a query against `pg_catalog`); if the step genuinely requires a clean database, ask for consent and explain what will be lost.
- **Applies to**: implement, impl-review

## Never commit account identifiers from a real-environment pass

- **Context**: Any verification record, note in `change.md`/`plan.md`, Linear comment, or commit message produced after a pass against a **real** environment (production, shared staging) — as opposed to a local one.
- **Problem**: The convention "we use synthetic accounts in records" (`verify-s09@local.test`) had existed since S-07 but was never written down — it held on its own, because every pass was local. The first production pass (S-09 P7) had no synthetic equivalent, so a real email address and user UUID landed in three files and were committed. The repo is **public**. Caught by a user's question one step before the push; it required rewriting two commits, which invalidated an already-recorded SHA and forced the write-back to be redone.
- **Rule**: Before committing anything from a real-environment pass, strip account identifiers — email, `user_id`, tokens, keys. Describe the **role**, not the person ("the operator's account"). Assume the repo is public. The moment the local "synthetic accounts" convention stops applying is the moment the rule has to be applied **deliberately** — not the moment it expires.
- **Applies to**: implement, impl-review, archive

## Sync plan-brief and other derived docs in the same pass as the plan edit

- **Context**: Any derived document in `context/changes/<change-id>/` — `plan-brief.md`, `change.md`, `reviews/` — whenever `plan.md` changes: `/10x-plan-review` triage, mid-implementation corrections, manual fixes.
- **Problem**: The drift is silent and durable. In `app-design-system` step 4, triage fixed 8 findings in `plan.md` while the brief drifted on seven separate points — its scope line still scoped the `charged` signal to "the two 422 sites" after triage had established three, plus a stale decisions table and phase-risk cells. Nothing in the triage loop would have caught it; it surfaced only because the user asked. The brief is the short doc read first, so a stale one hands the implementer the pre-review design.
- **Rule**: Whenever a fix changes `plan.md`, propagate it to `plan-brief.md` — and to any other derived doc in the change folder — in the same pass. Never leave the brief for later.
- **Applies to**: plan, plan-review, implement, impl-review

## Check for an already-running dev server before starting a new one

- **Context**: Any local dev-server session (`npm run dev` or equivalent) started during a working session — especially on Windows where an old process can keep running invisibly across conversation turns.
- **Problem**: A dev server from a prior session was already listening on :4321. Starting a second `npm run dev` silently fell back to :4322 while the browser kept hitting the stale original — which then didn't pick up a `middleware.ts` edit. Time was spent debugging why an injected fault "wasn't working" before discovering two processes were running.
- **Rule**: Before starting a dev server, check whether one is already listening on the target port (`netstat`/`Get-NetTCPConnection` on Windows, `lsof`/`ss` elsewhere) and reuse it. Only start a new instance if none is running, or after deliberately stopping the old one.
- **Applies to**: implement, impl-review
