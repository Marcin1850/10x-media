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

## Nigdy nie kasuj danych z lokalnej bazy bez zgody — najpierw nieniszcząca alternatywa

- **Context**: Każda komenda kasująca lub nadpisująca dane w lokalnym środowisku dev (`supabase db reset`, `drop`, `truncate`, nadpisanie pliku) — niezależnie od tego, czy jest częścią planu, czy doraźnym sprawdzeniem stanu.
- **Problem**: Lokalne dane (użytkownicy, `videos`, `summaries`) to zasób testowy zbudowany realnym kosztem — odtworzenie podsumowań kosztuje kredyty Supadata i OpenRouter oraz czas. Dodatkowo destrukcyjna komenda przerwana w połowie zostawia bazę niespójną (tu: schemat cofnięty do pierwszej migracji), więc naprawa wymaga kolejnego pełnego resetu.
- **Rule**: Nigdy nie uruchamiaj destrukcyjnej komendy na lokalnej bazie bez wyraźnej zgody. Najpierw sięgnij po nieniszczącą alternatywę (`supabase migration up`, zapytanie do `pg_catalog`); jeśli krok naprawdę wymaga czystej bazy, poproś o zgodę i wyjaśnij, co zostanie utracone.
- **Applies to**: implement, impl-review

## Nigdy nie commituj identyfikatorów kont z przebiegu na prawdziwym środowisku

- **Context**: Każdy record weryfikacyjny, nota w `change.md`/`plan.md`, komentarz w Linear lub treść commita powstająca po przebiegu na **prawdziwym** środowisku (produkcja, współdzielony staging) — w odróżnieniu od lokalnego.
- **Problem**: Konwencja „w recordach używamy kont syntetycznych" (`verify-s09@local.test`) istniała od S-07, ale nigdy nie została zapisana — działała sama, bo wszystkie przebiegi były lokalne. Pierwszy przebieg produkcyjny (S-09 P7) nie miał syntetycznego odpowiednika, więc prawdziwy adres e-mail i UUID użytkownika trafiły do trzech plików i zostały zacommitowane. Repo jest **publiczne**. Złapane pytaniem użytkownika jeden krok przed pushem; wymagało przepisania dwóch commitów, co unieważniło już wpisany SHA i zmusiło do powtórzenia write-backu.
- **Rule**: Zanim zacommitujesz cokolwiek z przebiegu na prawdziwym środowisku, usuń identyfikatory kont — e-mail, `user_id`, tokeny, klucze. Opisuj **rolę**, nie osobę („konto operatora"). Zakładaj, że repo jest publiczne. Moment, w którym lokalna konwencja „konta syntetyczne" przestaje mieć zastosowanie, to moment, w którym zasadę trzeba zastosować **świadomie** — a nie moment, w którym ona wygasa.
- **Applies to**: implement, impl-review, archive
