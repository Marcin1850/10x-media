---
title: "10xMedia — destylacja domeny (Ubiquitous Language, subdomeny, agregaty, rozjazdy model↔kod)"
created: 2026-09-12
type: domain-distillation
---

# 10xMedia — destylacja domeny

> Produkt: **mapa domeny**, nie kod. Każdy cytat `plik:linia` został otwarty i sprawdzony w tej sesji
> (stan `master` @ `72863c1`). Tam, gdzie pojęcie z dokumentów nie ma odpowiednika w kodzie, jest
> jawna adnotacja **BRAK w kodzie**.

## Krok 0 — Kontekst projektu

### Materiał źródłowy (przeczytany)

| Dokument | Rola | Uwagi |
| --- | --- | --- |
| `context/foundation/prd.md` | wizja, FR, reguły biznesowe, non-goals | v1, `status: draft`; jedyne kryterium sukcesu = 75% „good enough” |
| `context/foundation/shape-notes.md` | notatki z discovery (wejście do PRD) | starsza wersja Business Logic (bez „stand-in for watching”) |
| `context/foundation/roadmap.md` | rozszerzona narracja/historia decyzji (F-01…S-13, D1–D14) | **najbogatsze źródło reguł domenowych** — większość reguł kredytowych i kosztowych jest tu, nie w PRD |
| `context/foundation/tech-stack.md` | wybór stacku | Astro + Supabase + Cloudflare Workers |
| `context/foundation/test-plan.md` | mapa ryzyk (§2) | ryzyka #1–#6 odwołują się do reguł domenowych |
| `context/foundation/lessons.md` | lekcje procesowe | głównie proces (Linear, porty), mało domeny |
| `README.md` | reguły kredytów, env, monitoring | sekcja *Summary credits* to de facto specyfikacja rozliczeń |

**Ograniczenie:** PRD nie zna w ogóle pojęć kredytu, rezerwacji, budżetu Supadata ani odmowy płatnej —
wszystkie powstały później w roadmapie (S-05, S-09 D14) i README. Reguły tej części domeny mają więc
źródło w dokumentach „drugiego rzędu”, a nie w PRD.

### Stack i warstwy

Astro 6 SSR + React 19 islands, Supabase (Postgres + RLS + `SECURITY DEFINER` RPC), Cloudflare Workers,
vendorzy: Supadata (transkrypcje, metadane), OpenRouter (LLM).

| Warstwa | Gdzie | Charakter |
| --- | --- | --- |
| API / orkestracja | `src/pages/api/summaries/generate.ts` (1146 linii) | *Transaction Script* — cały przepływ generacji w jednej funkcji `runGeneration` (`generate.ts:486`) |
| Serwisy | `src/lib/services/*.ts` | cienkie adaptery na RPC i vendorów (`credits.ts`, `summaries.ts`, `supadata-budget.ts`, `transcript*.ts`, `metadata*.ts`, `llm.ts`) |
| Reguły czyste | `src/lib/services/summaries.ts:159-201`, `src/lib/schemas/generate-summary.ts` | cena (`summaryCost`), walidacja URL |
| Persystencja + niezmienniki | `supabase/migrations/*.sql` (36 migracji) | **tu faktycznie żyje egzekwowanie** — CHECK, unique, FK, atomowe RPC |
| UI | `src/components/summaries/*`, `src/components/hooks/useGenerateSummary.ts` | formularz, karta oczekująca, lista |
| Typy domenowe | `src/types.ts` | DTO, brak zachowań |

Nie ma warstwy „domain” — model domenowy jest rozproszony między komentarze w `generate.ts`, funkcje
PL/pgSQL i dokumenty.

---

## Krok 1 — Ubiquitous Language

Konwencja: **Źródło** = gdzie pojęcie jest zdefiniowane w dokumentach; **Kod** = gdzie termin żyje.

### 1a. Rdzeń produktu

| Pojęcie | Definicja | Źródło (dokument) | Kod |
| --- | --- | --- | --- |
| **Summary** (podsumowanie) | Polski tekst zbudowany z transkrypcji jednego filmu, o kształcie zależnym od charakteru kanału; służy decyzji watch/skip **oraz** zastępuje obejrzenie | `prd.md:77`, `prd.md:88` | `src/types.ts:113-147` (`Summary`); tabela `summaries` `supabase/migrations/20260613145120_videos_and_summaries.sql:34-42` |
| **Channel character** (charakter kanału) | Wybór użytkownika: `informational` albo `educational`; tylko te dwie wartości | `prd.md:58`, `prd.md:100` | `src/types.ts:1` (`ChannelCharacter`); CHECK `20260613145120_videos_and_summaries.sql:38`; kolumna nazywa się `character` — bez „channel” |
| **Informational summary** | Wyczerpująca lista kluczowych faktów | `prd.md:85` | tylko jako prompt: `src/lib/services/llm.ts:20-47` |
| **Educational summary** | Przegląd tematów i wiedzy do zdobycia | `prd.md:86` | tylko jako prompt: `src/lib/services/llm.ts:48-74` |
| **Channel** (kanał) | Źródło filmów, którego *charakter* się wybiera | `prd.md:22`, `prd.md:26` | **BRAK w kodzie jako bytu.** Istnieją tylko atrybuty filmu `channel_name`/`channel_id` (`src/types.ts:46-48`) |
| **Watch/skip decision** | Cel podsumowania: czy warto obejrzeć w całości | `prd.md:88`, `roadmap.md:20` | **BRAK w kodzie** poza treścią promptu (`llm.ts:20-21`) |
| **Stand-in for watching** | Drugi cel: podsumowanie przekazuje treść pominiętego filmu; długość wynika z treści, nie z limitu | `prd.md:88` | częściowo w prompcie („let the length follow…”, `llm.ts:39-42`, `llm.ts:69-71`); sam cel „zastąpienia” **BRAK** |
| **Good enough** (75%) | Podsumowanie trafne i użyteczne; ≥75% takich = sukces MVP | `prd.md:31`, `prd.md:108`, `roadmap.md:418` | **BRAK w kodzie** (brak oceny/ratingu; faza 5 test-planu `not started`, `test-plan.md:59`) |
| **Video** (film) | Film YouTube dodany przez użytkownika przez wklejenie URL | `prd.md:55` | `src/types.ts:33-56`; tabela `videos` `20260613145120_videos_and_summaries.sql:4-14` |
| **YouTube video URL** / **youtube id** | URL watch/shorts/embed/live/youtu.be z 11-znakowym id | `prd.md:55`, `prd.md:109` (reguły otwarte) | `src/lib/services/summaries.ts:167-201` (`extractYoutubeId`); `src/lib/schemas/generate-summary.ts:16-18` |
| **Transcript** (transkrypcja) | Wejście do podsumowania, pobierane automatycznie | `prd.md:61`, `prd.md:84` | `src/lib/services/transcript.ts` (`fetchTranscript`); `TranscriptResolvedVia` `src/types.ts:10` |
| **Summary list** | Lista podsumowań użytkownika | `prd.md:64` | `SummaryListItem` `src/types.ts:96-111`; `src/lib/services/summary-list.ts:58` |
| **Privacy guardrail** | Podsumowania i lista widoczne tylko dla zalogowanego właściciela | `prd.md:37`, `prd.md:92` | RLS `20260613145120_videos_and_summaries.sql:19-20`, `:49-51`; `src/middleware.ts` |

### 1b. Rozliczenia (kredyty) — pojęcia spoza PRD

| Pojęcie | Definicja | Źródło (dokument) | Kod |
| --- | --- | --- | --- |
| **Credit** / **Balance** | Budżet użytkownika chroniący płatny pipeline; start 5; uzupełnianie tylko ręczne | `README.md:272`, `roadmap.md:165` | `user_credits.balance` `20260712175240_user_credits.sql:5-9`; `getBalance` `src/lib/services/credits.ts:30-39` |
| **Summary cost** | 1 kredyt; 2 za „długi film” po potwierdzeniu | `README.md:272` | `summaryCost` `src/lib/services/summaries.ts:159-165` — „długi” = **transkrypcja > 40 000 znaków** |
| **Long video confirmation** (`allowLong`) | Zgoda na wyższy koszt przed debetem | `README.md:272`, `roadmap.md:175` | 409 `generate.ts:848-868`; `allowLong` `generate-summary.ts:20` |
| **Hard cap / too long** | Transkrypcja > 200 000 znaków jest odrzucana | `roadmap.md:214` (cytuje stałe) | `HARD_MAX_TRANSCRIPT_CHARS` `summaries.ts:160`; 413 `generate.ts:836-841` |
| **Credit reservation** | Debet przed płatną pracą; potem `settled` albo `refunded` | `roadmap.md:175` („Superseded 2026-09-04”) | `credit_reservations` `20260720160000_credit_reservations.sql:22-29`; `BeginGenerationResult` `credits.ts:55-70` |
| **Settle** / **Refund** | Zamknięcie rezerwacji: praca dostarczona / nieudana | `roadmap.md:175` | settle atomowo z zapisem podsumowania `summaries.ts:282-370`; refund `credits.ts:437-472` |
| **Refusal charge** (odmowa płatna) | 4 z 5 odmów 422 kosztują 1 kredyt; przejściowa awaria pobrania — nie | `roadmap.md:296` (D14), `README.md:274` | `refuseAndCharge` `generate.ts:341-366`; `RefusalReason` `credits.ts:191`; CHECK `20260731110000_charge_failed_transcript.sql:48` |
| **Charged / ambiguous charge** | Informacja w odpowiedzi, czy kredyt pobrano; „ambiguous” = nie da się udowodnić | `README.md:274` | `refusalResponse` `generate.ts:291-298`; `ChargeFailedTranscriptResult` `credits.ts:211-216` |
| **Request identity** (`requestId`) / **Replay** | Klucz jednej generacji inicjowanej przez użytkownika, powtarzany przy retry; replay zwraca pierwotny wynik bez drugiego obciążenia | `roadmap.md:296` („keyed by the request's own `requestId`”) | `generate-summary.ts:26`; partial unique index `20260723130000_idempotent_generation.sql:48-50`; `respondToRepeatedRequest` `generate.ts:380-433` |
| **Grant credits** | Ręczne uzupełnienie przez operatora | `README.md:278-285`, `roadmap.md:174` | `grant_credits` `20260714094500_grant_credits_rpc.sql:12-43`; `scripts/grant-credits.mjs` |
| **Reconciliation** | Rozstrzygnięcie „wiszących” rezerwacji | `README.md:309` (rodzina zdarzeń) | `reconcile_reservation` `20260722120000_link_summary_to_reservation.sql:37-47` (wywołanie ręczne) |
| **Operator** | Właściciel instancji, płaci vendorom, uzupełnia kredyty | `README.md:272`, `roadmap.md:258` | brak bytu; rola service-role (`src/lib/supabase-admin.ts`) |

### 1c. Koszt vendora i ochrona (operator-side)

| Pojęcie | Definicja | Źródło (dokument) | Kod |
| --- | --- | --- | --- |
| **Supadata budget** / **breaker** | Flotowy limit kredytów Supadata; bramkuje *wydatek*, nie żądanie | `roadmap.md:267`, `roadmap.md:272` (D5) | `supadata-budget.ts:46-73`; singleton `20260731150000_supadata_budget.sql:52-53` |
| **Stop reserve** | Odmowa, gdy po wywołaniu zostałoby < 3 kredyty (1 transkrypcja + 2 metadane) | `roadmap.md:292` | `BUDGET_STOP_RESERVE` `supadata-budget.ts:73` |
| **Native-only transcript** (lever A) | Brak Whisper; każda transkrypcja = 1 kredyt | `roadmap.md:288` | `TRANSCRIPT_MODE = "native"` `transcript.ts:99` |
| **Transcript cache** / **negative cache** | Współdzielony cache per film; `unavailable` tylko 2 h | `roadmap.md:271` (D4) | `transcript-cache.ts:26`, `transcript-cache.ts:54` |
| **Metadata cache** | Współdzielony cache metadanych per `youtube_id`, 30 dni, bez cache'owania porażek | `roadmap.md:275-278` (D6, D8, D9) | `metadata-cache.ts:40`; zapis tylko sukcesu `generate.ts:1013-1015` |
| **Video metadata** | Tytuł, miniatura, kanał, długość, data — kontekst decyzji watch/skip; dekoracyjne, nie może zepsuć generacji | `roadmap.md:228`, `roadmap.md:242` | `VideoMetadata` `src/types.ts:67-80`; `metadata_via` `src/types.ts:31` |
| **Generation lease** | Jedna generacja w toku na użytkownika | `roadmap.md:334-339` | `generate.ts:182-210`; `generation_locks` `20260720133000_generation_locks.sql` |
| **Transcript rate limit** | ≤10 płatnych pobrań / 10 min na użytkownika | `roadmap.md:296` („10-per-10-minute rate limit”) | `transcript-guard.ts:30-31` |
| **Quote** | Transkrypcja zachowana między 409 a potwierdzeniem | `roadmap.md:217` („double transcript fetch on confirm”) | `getTranscriptQuote` `generate.ts:569`; TTL `transcript-guard.ts:33` |
| **Injection screen** | Transkrypcja sprawdzana pod kątem prompt injection przed LLM, fail-closed | `roadmap.md:303`, `roadmap.md:313` | **BRAK w kodzie** (S-10 `proposed`) |
| **Share link** | Czasowy link z darmową kopią u odbiorcy | `roadmap.md:356` | **BRAK w kodzie** (S-12 `proposed`; konflikt z `prd.md:98`) |

---

## Krok 2 — Subdomeny: Core / Supporting / Generic

Punkt odniesienia: wizja (`prd.md:18-22`), jedyne kryterium sukcesu (`prd.md:31`), guardrail
(`prd.md:37`), non-goals (`prd.md:94-103`).

| Obszar | Kategoria | Uzasadnienie |
| --- | --- | --- |
| **Podsumowanie dopasowane do charakteru kanału** (prompty, kształt wyniku, język polski) | **Core** | To *jest* wyróżnik: „no tool … accounting for the channel's character” (`prd.md:22`); jedyne kryterium sukcesu mierzy właśnie jakość podsumowań (`prd.md:31`). |
| **Pomiar „good enough”** | **Core** (brakujący) | Bez niego nie da się stwierdzić, czy MVP spełnia swój jedyny cel (`roadmap.md:418`). |
| **Wsparcie decyzji watch/skip** (lista + metadane) | **Supporting** | Lista to mechanizm oceny 75% (`roadmap.md:133`), metadane dają kontekst decyzji (`roadmap.md:228`) — ale nie są przewagą samą w sobie. |
| **Kredyty i rozliczenia** (rezerwacje, odmowy płatne, idempotencja) | **Supporting** | Brak w PRD; to guardrail kosztowy wokół FR-005 (`roadmap.md:167`). Krytyczny dla zaufania (ryzyko #1, `test-plan.md:27`), ale nie jest powodem istnienia produktu. |
| **Ochrona kosztów vendora** (budżet Supadata, cache, rate limit, lease) | **Supporting** | „roadmap-originated cost guardrail” (`roadmap.md:260`); strona operatora (`roadmap.md:283`). |
| **Pozyskanie transkrypcji i metadanych** (Supadata) | **Generic** (za ACL) | Kupowane od vendora; wartość jest w warstwie antykorupcyjnej (cache, tryb `native`, `lang`), nie w samym pobraniu. |
| **Generowanie tekstu LLM** (OpenRouter) | **Generic** | Model kupiony (`llm.ts:5`); rdzeniem są prompty, nie wywołanie. |
| **Integralność promptu** (injection screen) | **Supporting** (brakujący) | Chroni rdzeń przed sterowaniem przez autora filmu (`roadmap.md:321`). |
| **Tożsamość, rejestracja, logowanie, usunięcie konta** | **Generic** | FR-001/002 (`prd.md:49-52`) — Supabase Auth; RODO (`roadmap.md:151`). |
| **Prywatność / multi-tenancy** (RLS) | **Generic** mechanizm, wymóg z PRD | Jedyny guardrail (`prd.md:37`), realizowany standardowym RLS. |
| **Monitoring błędów** (Sentry) | **Generic** | S-13, „operability slice” (`roadmap.md:379`). |
| **Design system** | **Generic** | S-06, „product polish” (`roadmap.md:183`). |

**Obserwacja strukturalna.** Rdzeń domeny to ~55 linii tekstu promptów (`llm.ts:19-75`) bez żadnego
modelu, pomiaru ani testu jakości, podczas gdy subdomena *Supporting* (rozliczenia + koszt vendora)
zajmuje `generate.ts` (1146 l.), `credits.ts` (472), `supadata-budget.ts` (609) i większość z 36
migracji. Inwestycja projektowa jest odwrócona względem mapy subdomen — co jest racjonalne dla MVP,
w którym pieniądze operatora są realnym ryzykiem, ale oznacza, że **rdzeń nie ma żadnego egzekwowanego
niezmiennika poza CHECK na dwóch wartościach `character`**.

---

## Krok 3 — Kandydaci na agregaty i ich niezmienniki

Statusy: **egzekwuje** (kod/DB uniemożliwia naruszenie) · **deklaruje** (komentarz/prompt/dokument, bez
mechanizmu) · **ignoruje** (reguła istnieje w źródle, kod jej nie odwzorowuje).

### A. `Generation` (próba generacji, tożsamość `(user_id, request_id)`) + encja `CreditReservation`

| # | Niezmiennik | Źródło | Status | Dowód |
| --- | --- | --- | --- | --- |
| A1 | Jeden `requestId` ⇒ co najwyżej jeden debet i jedno podsumowanie; retry dostaje replay | `roadmap.md:296` | **egzekwuje** | partial unique `20260723130000_idempotent_generation.sql:48-50`; `requestId` wymagany `generate-summary.ts:26`; probe + debet `generate.ts:509-523`, `generate.ts:887-890` |
| A2 | Nieudana praca nigdy nie kosztuje użytkownika | `roadmap.md:175`; `credits.ts:8-10` (kontrakt) | **egzekwuje częściowo** | refund po awarii LLM `generate.ts:937` i zapisu `generate.ts:1074` jest *best-effort* (`credits.ts:432-436`); przy porażce refundu wiersz zostaje `reserved`, a jego rozstrzygnięcie jest **ręczne** (`20260722120000_link_summary_to_reservation.sql:37-46`) |
| A3 | Rezerwacja jest `settled` ⇔ podsumowanie zapisane; jedna rezerwacja ⇒ ≤1 podsumowanie | `roadmap.md:175` | **egzekwuje** | `persist_summary` w jednej transakcji `summaries.ts:268-281`; `unique (reservation_id)` `20260722120000_link_summary_to_reservation.sql:31` |
| A4 | Odmowa płatna: `unavailable`/`empty`/`whitespace` = 1 kredyt; `failed`/`timeout` = 0 | `roadmap.md:296` (D14), `README.md:274` | **egzekwuje, ale rozproszone** | 4 osobne call-site'y `generate.ts:626`, `:629`, `:753`, `:824`; wyjątek `:764-767`; kwota stała `:127`; brak jednego miejsca, które „wie”, że to jedna reguła |
| A5 | Długi film (koszt > 1) wymaga potwierdzenia przed debetem | `README.md:272` | **egzekwuje** | `generate.ts:848-868`; ale `allowLong: true` bez pytania = świadoma pre-autoryzacja (`test-plan.md:65`) |
| A6 | Odpowiedź nigdy nie twierdzi `charged: false`, gdy nie da się tego udowodnić | `README.md:274` | **egzekwuje** | `generate.ts:291-298`, `credits.ts:258-264` |

### B. `CreditAccount` (`user_credits`)

| # | Niezmiennik | Źródło | Status | Dowód |
| --- | --- | --- | --- | --- |
| B1 | Saldo ≥ 0 | `README.md:272` („blocked … below the cost”) | **egzekwuje** | `check (balance >= 0)` `20260712175240_user_credits.sql:7`; warunkowy debet (`begin_generation`, `generate.ts:870-873`) |
| B2 | Każde nowe konto startuje z 5 kredytami | `README.md:272`, `roadmap.md:165` | **egzekwuje** | trigger `20260712175240_user_credits.sql:21-38` |
| B3 | Uzupełnienie wyłącznie ręczne, przez operatora | `README.md:272` | **egzekwuje** | `grant_credits` tylko `service_role` `20260714094500_grant_credits_rpc.sql:40-43` |
| B4 | Klient nie może zmienić salda | `roadmap.md:173` | **egzekwuje** | tylko polityka SELECT `20260712175240_user_credits.sql:16-18` |
| B5 | Saldo da się odtworzyć z księgi | *(implikowane słowem „ledger”, `credits.ts:8-14`)* | **ignoruje** | `grant_credits` zmienia saldo bez wiersza w `credit_reservations` (`grant_credits_rpc.sql:25-28`), a seed 5 kredytów też nie ma wiersza — księga nie jest źródłem prawdy o saldzie |

### C. `Summary`

| # | Niezmiennik | Źródło | Status | Dowód |
| --- | --- | --- | --- | --- |
| C1 | Charakter ∈ {informational, educational} | `prd.md:100` | **egzekwuje** | CHECK `20260613145120_videos_and_summaries.sql:38`; zod `generate-summary.ts:19` |
| C2 | Widoczne tylko dla właściciela; film i podsumowanie mają tego samego właściciela | `prd.md:37` | **egzekwuje** | RLS `:49-51`; kompozytowy FK `:41` |
| C3 | Podsumowanie po polsku | `prd.md:61` | **deklaruje** | wyłącznie instrukcja w prompcie `llm.ts:31`, `llm.ts:60`; brak weryfikacji wyniku |
| C4 | Kształt zależny od charakteru (lista faktów vs przegląd nauki) | `prd.md:85-86` | **deklaruje** | prompty `llm.ts:35-44`, `llm.ts:64-68` |
| C5 | Tylko treść z transkrypcji; wynik kształtuje aplikacja, nie autor filmu | `llm.ts:45-46`; `roadmap.md:303` | **deklaruje / ignoruje** | transkrypcja idzie jako `prompt` (pozycja „użytkownika”) `llm.ts:142-143`; brak screeningu (S-10 `proposed`) |
| C6 | Niezmienne po zapisie (klient może tylko czytać i usuwać) | `roadmap.md:245` (single writer) | **egzekwuje** | `20260731130000_summaries_single_writer.sql:27`, `:31` |
| C7 | „Good enough” w ≥75% | `prd.md:31` | **ignoruje** | brak mechanizmu (patrz Krok 1a) |

### D. `Video` (wpis w bibliotece użytkownika)

| # | Niezmiennik | Źródło | Status | Dowód |
| --- | --- | --- | --- | --- |
| D1 | Jeden wpis na (użytkownik, film) | *(implikowane, `roadmap.md:217`)* | **egzekwuje** | `unique (user_id, youtube_id)` `20260613145120_videos_and_summaries.sql:12` |
| D2 | Nieudane pobranie metadanych nie kasuje wcześniej zapisanych | `roadmap.md:242` | **egzekwuje** | coalesce w RPC, kontrakt `summaries.ts:214-217` |
| D3 | Miniatura to „co zgłosił vendor”, nigdy naprawiana | `src/types.ts:39-45` | **deklaruje** | nazwa kolumny `thumbnail_url_reported`; reguła fallbacku tylko w komentarzu |
| D4 | Usunięcie ostatniego podsumowania usuwa dane filmu | *(brak źródła — pytanie otwarte)* | **ignoruje** | `deleteSummary` usuwa tylko `summaries` (`summary-delete.ts:25-36`); brak triggerów `after delete` w migracjach; lista czyta od `summaries` (`summary-list.ts:58`), więc sierota jest niewidoczna |

### E. `SupadataBudget` (singleton operatora)

| # | Niezmiennik | Źródło | Status | Dowód |
| --- | --- | --- | --- | --- |
| E1 | Żadna generacja nie wyprowadzi planu poniżej zera (rezerwa 3) | `roadmap.md:292` | **egzekwuje, fail-open** | atomowy reserve pod blokadą wiersza; `supadata-budget.ts:63-73`; przy nieczytelnym liczniku wynik `untracked` = przepuść (`supadata-budget.ts:27-32`, `:153-166`) |
| E2 | Budżet bramkuje wydatek, nie żądanie (cache hit nie jest blokowany) | `roadmap.md:272` (D5) | **egzekwuje** | reserve tylko w gałęzi miss `generate.ts:640-657`, `:968-977` |
| E3 | Odmowa budżetu na metadanych nie odrzuca gotowego podsumowania | `roadmap.md:242` („a fetch failure must not fail a paid generation”) | **egzekwuje** | `skipped_budget` `generate.ts:979-985` |
| E4 | Koszt jednej generacji znany z góry (≤3) | `roadmap.md:292` | **egzekwuje** | `TRANSCRIPT_MODE = "native"` `transcript.ts:99` |

### F. `GenerationLease` (per użytkownik)

| # | Niezmiennik | Źródło | Status | Dowód |
| --- | --- | --- | --- | --- |
| F1 | Jedna generacja w toku na użytkownika | `roadmap.md:334-339` | **egzekwuje (z oknem 600 s)** | `generate.ts:190-210`; sweep `20260720170000_generation_lock_lease.sql:44`; backstop w księdze `generate.ts:396-402` |

---

## Krok 4 — Rozjazdy MODEL vs KOD

Uporządkowane od najpoważniejszego.

| # | Dokument mówi (X) | Kod robi (Y) | Dowód | Waga |
| --- | --- | --- | --- | --- |
| 1 | **Rejestracja zamknięta** w MVP; jedynym użytkownikiem jest twórca (`prd.md:92`). Kalibracja ryzyk #1–#2 jako `Medium` zależy od tego wprost: „the moment registration opens, risks 1 and 2 return to High” (`test-plan.md:34`). | Endpoint rejestracji woła `supabase.auth.signUp` bez żadnej bramki (bez allowlisty, bez flagi, bez walidacji zod wbrew konwencji z CLAUDE.md); lokalna konfiguracja ma `enable_signup = true`. Ustawienia projektu chmurowego nie da się zweryfikować z repo. | `src/pages/api/auth/signup.ts:15-21`; `supabase/config.toml:169` | **Wysoka** — założenie, na którym stoi mapa ryzyk, nie jest egzekwowane w kodzie |
| 2 | Refund po nieudanej pracy jest domykany przez **„hourly reconciliation sweep”** / „one-hour reconciliation sweep” | Nie istnieje żaden zaplanowany sweep. `reconcile_reservation` to funkcja uruchamiana **ręcznie** przez operatora według runbooka w komentarzu migracji; brak `pg_cron`, brak `triggers` w `wrangler.jsonc`, brak skryptu w `scripts/`. | twierdzenie: `src/lib/services/credits.ts:250-251`, `src/pages/api/summaries/generate.ts:1028-1029`, `src/lib/services/llm.ts:82-83`; rzeczywistość: `20260722120000_link_summary_to_reservation.sql:37-47`; `scripts/` = `check-tokens.mjs`, `grant-credits.mjs`, `sync-prod-to-local.mjs` | **Wysoka** — niezmiennik A2 wygląda na egzekwowany automatycznie, a zależy od człowieka |
| 3 | **Charakter kanału** to cecha *kanału* (`prd.md:22`, `prd.md:58`, „channel character”) | Brak bytu `Channel`. Charakter jest atrybutem pojedynczego podsumowania (`summaries.character`) i wybierany przy każdym filmie; ten sam kanał może dostać oba charaktery; formularz ma domyślnie zaznaczony `informational`. `channel_id` jest zapisywany, ale służy tylko do linku. | `20260613145120_videos_and_summaries.sql:38`; `src/types.ts:46-48`; `src/components/summaries/DashboardSummaries.tsx:53` | Średnia — zgodne z FR-004 („when adding a video”), ale język „kanału” nie ma w modelu kotwicy |
| 4 | Podsumowanie ma **dwa cele**: decyzja watch/skip *i* zastąpienie obejrzenia (`prd.md:88`) | Oba prompty definiują cel wyłącznie jako decyzję („helps a user decide whether a YouTube video is worth watching in full”). Reguła długości jest zgodna, cel „stand-in” nie jest nazwany. | `src/lib/services/llm.ts:20-21`, `:27-28`, `:48-49`, `:55-57` | Średnia — dotyczy rdzenia; `shape-notes.md:93` ma jeszcze starą, jednocelową wersję |
| 5 | Jedyne kryterium sukcesu: **75% „good enough”** (`prd.md:31`), pytanie otwarte o mechanizm (`prd.md:108`) | Brak jakiegokolwiek mechanizmu oceny (rating, flaga, zestaw golden); faza 5 test-planu nie rozpoczęta. | `test-plan.md:59`; brak trafień dla rating/feedback w `src/` i `supabase/migrations/` | Średnia–wysoka — rdzeń niemierzalny |
| 6 | Podsumowanie **po polsku**, **wyczerpujące** dla informational (`prd.md:61`, `prd.md:85`) | Polski wymuszany tylko instrukcją promptu; odpowiedź ucięta (`finishReason: "length"`) jest świadomie zachowywana **i rozliczana** jak pełna. | `llm.ts:31`; `llm.ts:147-153`; persist+settle `generate.ts:1044` | Średnia |
| 7 | Transkrypcja nie może sterować modelem; fail-closed (`roadmap.md:303`, `roadmap.md:313`) | Transkrypcja trafia jako `prompt` (pozycja wypowiedzi użytkownika), bez screeningu. Opisane w roadmapie jako znany defekt (`roadmap.md:321`), slice `proposed`. | `llm.ts:142-143` | Średnia — zadeklarowane, nieegzekwowane |
| 8 | README: transkrypcje pobierane **`lang: "pl"`, `mode: "auto"`**, z pollingiem Whisper (`README.md:251`) | Kod: `lang = "en"`, `mode = "native"` (Whisper nieosiągalny od S-09 D1). | `src/lib/services/transcript.ts:70`, `:99` | Średnia — dokument operacyjny opisuje wycofany model kosztów |
| 9 | README: 2 kredyty za **„long video”** (`README.md:272`) | „Długi” = transkrypcja > 40 000 **znaków**; długość filmu (`duration_seconds`) nie wpływa na cenę. Roadmapa sama nazywa to strukturalnym niedopasowaniem (`roadmap.md:283`). | `src/lib/services/summaries.ts:159-165`; `roadmap.md:253` | Niska–średnia — termin z UL znaczy co innego w kodzie |
| 10 | S-05 outcome: „each generation **spends one** credit, and generation is **blocked at zero**” (`roadmap.md:165`, powtórzone w `roadmap.md:436`) | Koszt 1 lub 2; odmowy płatne (D14); blokada przy saldzie < koszt, nie „przy zerze”. Supersesja opisana tylko w linii o mechanizmie (`roadmap.md:175`), linia *Outcome* nieaktualna. | `generate.ts:127`, `:542-544`, `:892-907` | Niska — dryf dokumentu |
| 11 | FR-003: użytkownik **dodaje film** (`prd.md:55`); FR-007: **usuwa podsumowanie** (`prd.md:67`) | Film nie istnieje niezależnie: wiersz `videos` powstaje wyłącznie jako efekt uboczny udanej generacji (jedyny pisarz `persist_summary`). Usunięcie podsumowania zostawia wiersz `videos` z metadanymi (sierota, niewidoczna na liście). | `roadmap.md:245`; `summaries.ts:268-281`; `summary-delete.ts:25-36`; `summary-list.ts:58` | Niska — ale „Video” w UL to w kodzie raczej *artefakt podsumowania* niż byt dodawany przez użytkownika |
| 12 | Kredyty są prowadzone w **księdze** (`credits.ts:8-14`) | Księga rejestruje debety generacji i odmów, ale nie seed (5) ani ręczne granty — saldo nie jest wyprowadzalne z księgi. | `grant_credits_rpc.sql:25-28`; `user_credits.sql:21-38` | Niska (dziś); rośnie z otwarciem rejestracji |

**Zgodności potwierdzone (dla kontrastu):** 4 z 5 odmów 422 pobiera kredyt, przejściowa awaria nie
(`README.md:274` ↔ `generate.ts:626`, `:629`, `:753`, `:764-767`, `:824`); start 5 kredytów
(`README.md:272` ↔ `user_credits.sql:7`, `:21-38`); prywatność per użytkownik (`prd.md:37` ↔ RLS);
dwa charaktery (`prd.md:100` ↔ CHECK); brak udostępniania (`prd.md:98` ↔ brak kodu S-12).

---

## Krok 5 — Ranking refaktoru

Skala: **Wartość** — jak rdzeniowy / kosztowny jest niezmiennik; **Ryzyko** — jak słabo jest dziś
egzekwowany lub jak kruche jest egzekwowanie.

| Poz. | Kandydat | Wartość | Ryzyko | Uzasadnienie |
| --- | --- | --- | --- | --- |
| **1** | **A. `Generation` + `CreditReservation`** | Wysoka | Wysoka | Chroni pieniądze użytkownika w jedynym przepływie produktu (ryzyka #1 i #6, `test-plan.md:27`, `:32`). Atomy są mocne (RPC, unique, FK), ale **niezmiennik jako całość nie ma właściciela**: cykl życia `probe → reserve → (refuse-charge \| settle \| refund)` jest rozpisany na ~10 punktów wyjścia w 1146-liniowym transaction scripcie, reguła D14 na 5 call-site'ów, a domknięcie A2 opiera się na ręcznym runbooku, który komentarze opisują jako automatyczny sweep (rozjazd #2). |
| 2 | C. `Summary` (kształt, język, integralność) | Najwyższa (rdzeń) | Wysoka | C3/C4/C5/C7 są tylko *zadeklarowane* w promptach albo ignorowane. Ale to w większości **brakująca zdolność** (pomiar jakości — faza 5; screening — S-10; byt `Channel`), a nie restrukturyzacja istniejącego kodu — dlatego nie #1 *do refaktoru*. |
| 3 | B. `CreditAccount` | Średnia | Niska–średnia | B1–B4 twardo w DB. B5 (księga niekompletna) i otwarta rejestracja (rozjazd #1) zmienią wagę, gdy użytkowników będzie więcej niż jeden. |
| 4 | E. `SupadataBudget` | Średnia (operator) | Średnia | Egzekwowany atomowo; fail-open świadomy (`supadata-budget.ts:27-32`) i monitorowany. Niezweryfikowany w produkcji (`test-plan.md:29`). |
| 5 | D. `Video` | Niska | Niska | Unique + coalesce działają; sieroty po usunięciu podsumowania to kwestia porządkowa. |
| 6 | F. `GenerationLease` | Niska | Niska | Egzekwowany, z backstopem w księdze; zmieni się dopiero przy S-11. |

### #1 do refaktoru: agregat `Generation`

**Dlaczego ten.** Stoi na przecięciu największej wartości i największej kruchości: to jedyne miejsce,
gdzie błąd natychmiast zabiera użytkownikowi kredyty, a reguły są dziś wiedzą *rozproszoną* — w
komentarzach `generate.ts`, w ośmiu funkcjach PL/pgSQL i w decyzjach roadmapy (D14, F22, F23). Każdy
kolejny slice na tej ścieżce (S-10 dokłada bramkę przed debetem, S-11 zdejmuje lease) musi zrozumieć
cały skrypt, żeby nie naruszyć niezmiennika, którego nikt nie trzyma w jednym miejscu.

**Co refaktor powinien uczynić jawnym** (kierunek, nie kod):

1. **Maszyna stanów próby generacji** jako jeden byt z nazwanymi przejściami:
   `fresh → reserved → settled | refunded`, plus stany końcowe bez debetu (`refused-free`) i z debetem
   (`refused-charged`) oraz `replay` / `inProgress` / `closed-by-operator`. Dziś te stany istnieją jako
   wartości `outcome` w dwóch unionach (`credits.ts:55-70`, `credits.ts:211-216`) i jako rozgałęzienia w
   `generate.ts`.
2. **Polityka odmów (D14) w jednym miejscu** — mapowanie *przyczyna → (czy płatna, kod, copy)*, zamiast
   trzech równoległych map (`REFUSAL_COPY`, `REFUSAL_CODE`, `REFUSAL_CHARGE`, `generate.ts:86-127`) i
   osobnej, ręcznie kodowanej wyjątkowej gałęzi `failed`/`timeout` (`generate.ts:755-767`).
3. **Domknięcie A2 bez człowieka albo uczciwy komentarz.** Albo zaplanowane wywołanie
   `reconcile_reservation` dla rezerwacji starszych niż okno, albo usunięcie z komentarzy twierdzenia o
   „hourly sweep”. Dziś kod obiecuje więcej, niż robi.
4. **Endpoint jako cienki adapter** — orkestracja vendorów (cache, budżet, metadane) zostaje w API, ale
   decyzja „ile i czy pobrać od użytkownika” przestaje być efektem ubocznym kolejności `return`-ów.

**Czego nie ruszać:** atomowości w bazie (`begin_generation`, `persist_summary`,
`charge_failed_transcript`) — to działa i jest pokryte testami integracyjnymi i e2e; refaktor ma
nadać tym atomom *model*, a nie je zastąpić.

**Warunek wstępny spoza refaktoru:** rozstrzygnąć rozjazd #1 (otwarta rejestracja). Jeżeli rejestracja
jest faktycznie otwarta w produkcji, wartość agregatu `Generation` rośnie z `Medium` do `High` wg
kalibracji `test-plan.md:34`, co tylko wzmacnia jego pozycję #1.
