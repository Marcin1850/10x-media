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
