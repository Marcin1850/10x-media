# Lessons Learned

> Append-only register of recurring rules and patterns. Re-read at start by /10x-frame, /10x-research, /10x-plan, /10x-plan-review, /10x-implement, /10x-impl-review.

## Linear MCP: create_issue_label używa teamId (UUID), nie team

- **Context**: Wywołania Linear MCP wskazujące zespół. Pole nie jest jednolite — `create_issue_label` jest wyjątkiem: wymaga `teamId` (UUID). Większość pozostałych (`save_issue`, `list_issue_statuses`, `save_document`) przyjmuje `team` (nazwa/ID), `save_project` używa `addTeams`/`setTeams`.
- **Problem**: Niespójne pole zespołu — `create_issue_label` odrzuciło klucz `team` (błąd walidacji), bo oczekuje `teamId`/UUID. 7 zbatchowanych wywołań padło naraz, zanim nazwa pola została poprawiona.
- **Rule**: Sprawdź schemat pola zespołu zanim założysz jego nazwę — w Linear MCP nie jest jednolite (`create_issue_label` → `teamId`/UUID; większość innych → `team`/nazwa lub ID). Przy tworzeniu wielu obiektów zweryfikuj jedno wywołanie, potem batchuj resztę.
- **Applies to**: implement, impl-review (fazy odwołujące się do issue trackera)

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
