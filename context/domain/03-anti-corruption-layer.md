---
title: "10xMedia — warstwa antykorupcyjna dla dostawcy treści wideo (Supadata): plan refaktoru"
created: 2026-09-13
type: refactor-plan
---

# Warstwa antykorupcyjna dla dostawcy treści wideo (Supadata)

> To jest **plan refaktoru**. Kod produkcyjny nie był zmieniany. Każdy cytat `plik:linia` otworzyłem
> w tej sesji na `docs/domain-distillation` @ `d6c78ff`. Liczniki wystąpień pochodzą z
> `grep -ci` i obejmują komentarze. Tam, gdzie piszę „brak”, podaję, jak to sprawdziłem.
>
> Dokument 01 (`context/domain/01-domain-distillation.md`) sklasyfikował pozyskanie transkrypcji jako
> subdomenę Generic **„za ACL”**. Dokument 02 projektuje agregat `GenerationAttempt` w
> `src/lib/domain/`. Ten dokument sprawdza, czy ta ACL w ogóle istnieje. Nie istnieje. Projektuje ją
> tak, żeby pasowała do 02.

---

## Krok 0 — Kontekst

**Dokumenty bazowe (przeczytane):** `context/foundation/prd.md`, `tech-stack.md`,
`infrastructure.md`, `roadmap.md`, `test-plan.md`, `README.md`. Do tego archiwum zmiany, w której
wybrano vendorów (`context/archive/2026-07-04-transcript-llm-probe/`), i dokumenty domenowe 01 i 02.

**Stack:** Astro 6 SSR + React 19 islands, Supabase (Postgres, RLS, RPC `SECURITY DEFINER`),
Cloudflare Workers (workerd).

**Zależności zewnętrzne z manifestu, które niosą kontrakt obcego systemu** (`package.json`):

| Pakiet / usługa | Rola | Gdzie wchodzi |
| --- | --- | --- |
| `@supabase/supabase-js`, `@supabase/ssr` | auth + baza | klient w każdym serwisie |
| `@supadata/js` (`package.json:37`) + REST `api.supadata.ai` | transkrypcje, metadane, konto | serwisy, API, typy, DB, UI, build |
| `ai` + `@openrouter/ai-sdk-provider` | LLM | `src/lib/services/llm.ts` |
| `@sentry/astro`, `@sentry/cloudflare` | monitoring | seam `reporting.ts` + punkty wejścia |
| `react-markdown`, `zod`, `postgres` (dev) | render, walidacja, test | lokalnie |

**Warstwy:** UI (`src/components/**`) → API route (`src/pages/api/**`) → serwisy
(`src/lib/services/**`) → RPC/tabele (`supabase/migrations/**`), plus konfiguracja builda
(`astro.config.mjs`).

**Deklaracje o wymienialności i separacji (zacytowane w Kroku 3):**

- LLM: *„The rest of the code never names a provider.”*
  (`context/archive/2026-07-04-transcript-llm-probe/plan.md:190`, także `research.md:105`).
- Transkrypcje: lista zamienników *„Alternatives (same shape, if Supadata disappoints)”*
  (`context/archive/2026-07-04-transcript-llm-probe/docs/supadata.md:52-54`, tabela w
  `research.md:37-40`). Pre-mortem zakłada wymianę biblioteki transkrypcji
  (`context/foundation/infrastructure.md:69`). Roadmapa rozważała inne źródło metadanych, YouTube
  Data API (`roadmap.md:237`).
- Probe budował **„reusable seam”**: *„a transcript service, an LLM service isolated behind
  `getSummaryModel()`”* (`transcript-llm-probe/plan.md:7`).
- Domena: *„Pozyskanie transkrypcji i metadanych (Supadata) | Generic (za ACL) | … wartość jest w
  warstwie antykorupcyjnej”* (`context/domain/01-domain-distillation.md:119`).
- Monitoring: *„The change ID stays vendor-neutral … so swapping the receiver later does not orphan
  the change folder”* (`roadmap.md:384`).

---

## Krok 1 — Identyfikacja przeciekających zależności

### 1.1 Supadata (`@supadata/js` + REST)

Pliki, które dziś „znają” Supadatę, czyli jej typy, host, nagłówki, kody błędów, cennik, limity albo
nazwę:

| Warstwa | Plik:linia | Co zna |
| --- | --- | --- |
| **Build** | `astro.config.mjs:139-151` | alias `cross-fetch` + `optimizeDeps.exclude: ["@supadata/js"]`, istnieją tylko dla SDK |
| Build | `src/lib/shims/cross-fetch.mjs:4` | shim istnieje, bo *„`@supadata/js` only uses cross-fetch as a fallback”* |
| Build / env | `astro.config.mjs:160` | `SUPADATA_API_KEY` w schemacie env |
| **API route** | `src/pages/api/summaries/generate.ts:3`, `:8`, `:11-16` | klucz vendora, meter i budżet vendora w importach |
| API | `generate.ts:215`, `:227`, `:236`, `:256-259` | tworzy i flushuje `SupadataMeter`, przenosi `supadataKey` |
| API | `generate.ts:654`, `:977` | `reserveBudget(admin, supadataKey, TRANSCRIPT_BUDGET_CREDITS / METADATA_BUDGET_CREDITS)`, czyli cennik vendora w route |
| API | `generate.ts:709-729`, `:987-1000` | `meter.checkpoint()` / `meter.billedSince(mark, "transcript" / "metadata")`: nazwy operacji vendora i rozliczanie per wywołanie HTTP |
| API | `generate.ts:945-949` | kolejność wywołań podyktowana limitem *„1 req/s”* planu vendora |
| API | `generate.ts:307`, `:752` | semantyka nagłówka `x-billable-requests` i płatnego 206 |
| API | `generate.ts:466`, `:472` | `resolvedVia: "inline" \| "job"` (mechanizm vendora), `TRANSCRIPT_REQUESTED_LANG` |
| API | `src/lib/config-status.ts:4`, `:30` | `SUPADATA_API_KEY` jako warunek konfiguracji |
| **Serwis** | `src/lib/services/transcript.ts:1` | `SupadataError` (wartość), `Transcript`, `TranscriptOrJobId`, `JobResult` |
| Serwis | `transcript.ts:42`, `:106-108`, `:160-237`, `:253-266` | host, zawężenie ciała błędu, własny transport, `BilledSupadataError extends SupadataError` |
| Serwis | `transcript.ts:99`, `:316`, `:362-381` | `mode=native`, `text=true`, `lang`, kształt `jobId` / `content` |
| Serwis | `src/lib/services/metadata.ts:1` | `SupadataError` (wartość), `Metadata` |
| Serwis | `metadata.ts:14`, `:21`, `:41-43`, `:59-108` | limit 1 req/s, **drugi** host, **drugie** `isErrorBody`, **drugi** transport |
| Serwis | `metadata.ts:128-132`, `:190`, `:197`, `:199-206` | kody błędów, unia `media`, `additionalData.channelId`, mapowanie na DTO |
| Serwis | `src/lib/services/supadata-budget.ts:2`, `:52`, `:61`, `:114`, `:351-370`, `:436-440` | import `RETRY_DELAY_MS` z `metadata.ts`, cennik, **trzeci** host, `GET /v1/me`, klucz API |
| Serwis | `src/lib/services/supadata-ledger.ts:24`, `:155-175`, `:205-220` | nazwy operacji vendora, RPC `record_supadata_calls`, parser `x-billable-requests` |
| Serwis | `transcript-cache.ts:9`, `:24`, `:63`, `:119`; `transcript-guard.ts:6`, `:10`, `:27`; `metadata-cache.ts:90`, `:127`; `summaries.ts:19`, `:214`, `:219`, `:318-322`; `summary-list.ts:89` | nazwa vendora w kontraktach i komentarzach; mapowanie pola `thumbnailUrl` zapisanego w kształcie vendora |
| Serwis | `src/lib/services/reporting.ts:20-24` | rodziny kluczy `[supadata-budget]`, `[supadata-ledger:*]` |
| **Typy wspólne** | `src/types.ts:4-13`, `:24`, `:40-45`, `:58-69`, `:72-75`, `:104` | `"inline"/"job"` jako mechanizm Supadaty, *„Field names stay vendor-shaped (`thumbnailUrl`)”*, `additionalData.channelId`, `author.username` |
| **UI** | `src/components/summaries/VideoThumbnail.tsx:6`, `:12`, `:17-42` | *„`maxresdefault` — which is what Supadata reports”*, allowlista hostów i naprawa quirku vendora w przeglądarce |
| UI | `src/components/summaries/SummaryCard.tsx:160-162` | przekazuje surowe `thumbnailUrlReported` |
| **DB** | `supabase/migrations/20260728120000_generation_telemetry.sql:95` | tabela `supadata_calls` |
| DB | `20260731150000_supadata_budget.sql:52`, `:155`, `:266`, `:517`, `:598` | `supadata_budget`, `supadata_reservations`, `reserve_supadata_credits`, `settle_supadata_reservation`, `save_supadata_budget` |
| DB | `20260731100000_supadata_call_http_status.sql:34`, `:58` | `supadata_calls.http_status`, `record_supadata_calls` |
| **Testy** | `src/lib/services/__fixtures__/supadata-responses.ts`; `generate.int.test.ts:15`, `:26`; `supadata-budget.int.test.ts:9`; `supadata-ledger.int.test.ts:10` | fixture’y odpowiedzi HTTP vendora |
| Testy e2e | `tests/e2e/fixtures/ledger.ts:62-65`, `test.ts:17`, `account.ts:33`, `seed-cache.ts:5-21` | tabela `supadata_calls` |

Skala: Supadatę wspominają 44 pliki produkcyjne, migracje i fixture’y e2e, a łącznie z testami Vitest 62 (`grep -rli supadata`).

**Weryfikacja ast-grep (0.45.3, 2026-09-13).** `grep -ci` liczy **linie** ze wzmianką, łącznie z
komentarzami. ast-grep liczy tylko tokeny kodu: identyfikatory, właściwości, typy i fragmenty
stringów pasujące do `(?i)supadata`, bez komentarzy.

| Plik | `grep -ci` (linie, z komentarzami) | ast-grep (tokeny kodu) |
| --- | --- | --- |
| `supabase/migrations/20260731150000_supadata_budget.sql` | 110 | — (ast-grep nie ma gramatyki SQL) |
| `src/lib/services/transcript.ts` | 45 | 26 |
| `src/pages/api/summaries/generate.ts` | 30 | 18 |
| `src/lib/services/supadata-budget.ts` | 26 | 14 |
| `src/lib/services/supadata-ledger.ts` | 25 | 19 |
| `src/lib/services/metadata.ts` | 24 | 16 |
| `src/types.ts` | 11 | **0** |

Referencję w kodzie ma **23** pliki z `src/` i `tests/` (6 produkcyjnych: `transcript.ts`, `metadata.ts`, `supadata-budget.ts`, `supadata-ledger.ts`, `generate.ts`, `config-status.ts`; reszta to testy i
fixture’y), a nie 44. Pozostałe pliki wspominają Supadatę tylko w komentarzach. Dotyczy to
`src/types.ts`, `VideoThumbnail.tsx`, `summaries.ts`, `transcript-cache.ts` i `transcript-guard.ts`.
Przeciek w typach wspólnych i w UI jest więc **strukturalny, a nie leksykalny**. Tworzą go nazwa
pola `thumbnailUrl` / `thumbnailUrlReported`, wartości `"inline"/"job"` i reguły quirku vendora.
Grep po nazwie go nie wykryje, dlatego kryterium z §6.1 trzeba uzupełnić o kształt DTO (§5.3).

Wywołania i konstrukcje z tego dokumentu, sprawdzone ast-grep na kodzie produkcyjnym (bez `*.test.ts`,
`__fixtures__`, `src/test`):

| Teza | Wynik |
| --- | --- |
| ``fetch(`${SUPADATA_BASE_URL}…`)`` ×3 | 3: `supadata-budget.ts:353`, `metadata.ts:62`, `transcript.ts:166` ✓ |
| `const SUPADATA_BASE_URL` ×3, `{ "x-api-key": … }` ×3 | 3 / 3 ✓ |
| `function isErrorBody` ×2 | 2: `transcript.ts:106`, `metadata.ts:41` ✓ |
| import z `@supadata/js` | 2: `transcript.ts:1`, `metadata.ts:1` ✓ |
| `SupadataError` jako wartość | `new` ×4 (`metadata.ts:79`, `:80`, `:89`, `:102`), `instanceof` ×2 (`metadata.ts:129`, `transcript.ts:333`), `extends` ×1 (`transcript.ts:253`) ✓ |
| `reserveBudget` w route ×2 | 2: `generate.ts:654`, `:977` ✓ |
| `settleBudget` w route | **3**, a nie 2: `generate.ts:675` (zwolnienie na 0), `:723`, `:999` |
| `checkpoint()` / `billedSince()` ×2 | 2 / 2 ✓ |
| stałe cennika w route | import `generate.ts:14-15` + użycie `:654`, `:977` ✓ |
| `supadataKey` w route | 7 referencji (`generate.ts:227`, `:256`, `:495`, `:654`, `:711`, `:977`, `:989`); `SUPADATA_API_KEY` 5 (`config-status.ts:4`, `:30`; `generate.ts:3`, `:144`, `:227`) |
| punkty wywołań vendora | `fetchTranscript` 1 (`generate.ts:711`), `fetchVideoMetadata` 1 (`:989`), `supadataGet` 2, `requestMetadata` 2 (retry), `pollTranscriptJob` 1, `readVendorBudget` 1 |
| zapisy metera `meter?.record(…)` | 15: `transcript.ts` 10, `metadata.ts` 5 |
| `RETRY_DELAY_MS` | 4: `metadata.ts:14`, `:183`, `supadata-budget.ts:2`, `:495` |
| mapowanie `p_thumbnail_url_reported` ×2 | 2: `metadata-cache.ts:127`, `summaries.ts:322` ✓ |
| `trim().length === 0` ×2 | 2: `generate.ts:796`, `:823` ✓ |

### 1.2 Pozostali kandydaci (dla porównania)

| Zależność | Pliki, które ją znają (poza testami) | Charakter |
| --- | --- | --- |
| **Supabase** | `SupabaseClient` w sygnaturach: `credits.ts:1`, `generation-lock.ts:1`, `metadata-cache.ts:1`, `summaries.ts:1`, `supadata-budget.ts:1`, `supadata-ledger.ts:1`, `transcript-cache.ts:1`, `transcript-guard.ts:1`, `supabase-admin.ts:1`; `@supabase/ssr` w `supabase.ts:1`; `User` w `env.d.ts:3`; `scripts/grant-credits.mjs:14` | szeroko w serwisach, ale **nie** w UI ani w DTO |
| **OpenRouter / AI SDK** | `llm.ts:1-2`, `:5`, `:15-17`; w route tylko nazwa `openrouterKey` (`generate.ts:228`, `:257`, `:496`); alias fake’a w `astro.config.mjs` | zamknięte w jednym module |
| **Sentry** | `reporting-sink.client.ts:1`, `reporting-sink.server.ts:1`, `sentry-worker-options.ts:7`, `worker.ts:30`, `sentry.client.config.ts:12`, `astro.config.mjs:10` | za seamem `reporting.ts`; reszta to wymagane punkty wejścia SDK |

---

## Krok 2 — Klasyfikacja i wybór #1

| Oś | Supadata | Supabase | OpenRouter/AI SDK | Sentry |
| --- | --- | --- | --- | --- |
| (a) warstwy / pliki | **6 warstw**: build, API, serwis, typy, UI, DB (+ testy e2e); 44 pliki (62 z testami) | 2 (serwis, entry); ~12 plików | 1 moduł (+ nazwa klucza w route) | 1 seam + entry pointy |
| (b) koszt wymiany dziś | **Wysoki.** Trzeba przepisać 3 transporty, meter, breaker (RPC + tabele z nazwą vendora), cennik w route, typ wspólny, komentarz UI, konfigurację builda i fixture’y 3 warstw testów | Bardzo wysoki, ale to platforma: RLS, RPC `SECURITY DEFINER` i auth są schematem, a nie zależnością do wymiany | Niski: jeden plik, jak zadeklarowano | Niski: nowy sink + entry |
| (c) deklaracja wymienialności | **Tak**, a kod jej nie dotrzymuje (`supadata.md:52-54`, `infrastructure.md:69`, `01:119` „za ACL”) | Nie: stack zablokowany (`tech-stack.md:24`) | Tak, i kod ją dotrzymuje (`plan.md:190` ↔ `llm.ts`) | Tak, i dotrzymana (`roadmap.md:384` ↔ `reporting.ts`) |
| Groźne przecieki | biblioteka trzymana **tylko dla klasy błędu** wymusza konfigurację bundlera Workera; kształt vendora w DTO czytanym przez UI; cennik i limit vendora w route | brak w UI | brak | ograniczenie bundla już udokumentowane (CLAUDE.md) |

**Wybór #1: Supadata.** Wygrywa na wszystkich trzech osiach naraz. Supabase ma podobny zasięg w
serwisach, ale jest świadomym wyborem platformy i nie przecieka do UI ani do DTO. Jego ACL byłaby
repozytorium z 02, a nie osobnym tematem. OpenRouter i Sentry pokazują, jak projekt **umie** to
robić: tam intencja i kod się zgadzają. Przy Supadacie rozjazd intencja-vs-kod jest największy, a
dotknięte są warstwy najdroższe w zmianie (DB, build, UI).

---

## Krok 3 — Diagnoza

### 3.1 Trzy ręcznie pisane transporty tego samego API

| Element | `transcript.ts` | `metadata.ts` | `supadata-budget.ts` |
| --- | --- | --- | --- |
| host | `:42` `"https://api.supadata.ai/v1"` | `:21` ten sam literał | `:114` ten sam literał, komentarz *„matching `metadata.ts`”* |
| nagłówki auth | `:167` `{ "x-api-key": apiKey, … }` | `:63` identyczne | `:354` identyczne |
| zawężenie ciała błędu | `:106-108` `isErrorBody` | `:41-43` **kopia 1:1** | brak (każdy błąd → `null`) |
| mapowanie non-2xx / non-JSON / parse → błąd | `:183-234` (`BilledSupadataError`) | `:76-107` (`SupadataError`) | `:358-369` (`null`) |
| deadline | `:62-63` | `:38` | `:111` |
| odczyt kosztu | `:179` `readBillableCredits` | `:73` to samo | nie dotyczy |

Te trzy kopie rozjechały się semantycznie. `transcript.ts` przenosi `httpStatus` na błędzie
(`:253-266`), a `metadata.ts` nie ma go wcale (`:69`, `:77`, `:88` zapisują `meter.record` bez
`httpStatus`). `supadata-budget.ts` połyka kod błędu, więc `limit-exceeded` z `/v1/me` jest
nieodróżnialny od awarii sieci. Roadmapa sama wskazała duplikację: *„the reader belongs in one
shared helper”* (`roadmap.md:222`). Wspólny okazał się tylko limit 1 req/s, i to przez import
`RETRY_DELAY_MS` z modułu metadanych do breakera (`supadata-budget.ts:2`, uzasadnienie w
`metadata.ts:5-12`). To stała **vendora** wystawiona z modułu **funkcji**.

### 3.2 Biblioteka trzymana dla jednej klasy, która wymusza konfigurację bundlera

- Fixture testowy deklaruje: *„`@supadata/js` being a types-only dependency now”*
  (`src/lib/services/__fixtures__/supadata-responses.ts:4-6`). To samo mówi research fazy 2:
  *„7.5 — `@supadata/js` is now a types-only dependency”*
  (`context/archive/2026-09-04-testing-phase-2-paid-path/research.md:180`).
- Kod tego nie dotrzymuje. `transcript.ts:1` i `metadata.ts:1` importują `SupadataError` jako
  **wartość**: `class BilledSupadataError extends SupadataError` (`transcript.ts:253`),
  `new SupadataError(body)` (`metadata.ts:79`) i `instanceof SupadataError` (`metadata.ts:129`,
  `transcript.ts:333`). Klasa trafia do bundla Workera. W lokalnym buildzie z 2026-09-10
  `dist/server/chunks/generate_DFm1thRj.mjs:15` zawiera ciało konstruktora `SupadataError`.
  **Do ponownej weryfikacji świeżym buildem w fazie A0.**
- Żeby ten import działał na workerd, build niesie dwa obejścia: alias `cross-fetch` → shim
  (`astro.config.mjs:139-143`, `src/lib/shims/cross-fetch.mjs:1-5`) oraz wykluczenie pakietu z
  optymalizatora (`astro.config.mjs:146-151`). Biblioteka **serwerowa** nie trafia do bundla
  klienta: grep `SupadataError|supadata` po `dist/client` nie zwrócił żadnego pliku JS. Przeciek
  dotyczy więc konfiguracji builda i bundla Workera, a nie przeglądarki.
- Typ biblioteki jest **nieaktualny** względem API. `SupadataError['error']` w SDK 1.4.0 to 7 kodów
  (`node_modules/@supadata/js/dist/index.d.ts:42`), a OpenAPI Supadaty (Context7, `/me` → schemat
  `Error`) wymienia 8, w tym `forbidden`. `isErrorBody` (`transcript.ts:106-108`, `metadata.ts:41-43`)
  sprawdza tylko `typeof error === "string"`, a potem **rzutuje** na unię SDK. `forbidden`
  przechodzi więc przez typ, który go nie zna.
- Typ `Metadata` z SDK kłamie dla YouTube: *„despite the SDK's `MetadataAuthor` type declaring it a
  required `string`, it is simply absent”* (`metadata.ts:192-196`).

### 3.3 Cennik, limit i rozliczanie vendora w warstwie API

`generate.ts` nie orkestruje „pobrania transkrypcji”. Orkestruje **księgowość HTTP Supadaty**:

```ts
// generate.ts:654
const transcriptBudget = await reserveBudget(admin, supadataKey, TRANSCRIPT_BUDGET_CREDITS);
// generate.ts:709-711
const transcriptBudgetMark = meter.checkpoint();
try { transcript = await fetchTranscript({ url }, supadataKey, meter); }
// generate.ts:722-727
if (transcriptBudget.outcome === "reserved") {
  await settleBudget(admin, transcriptBudget.reservationId,
    meter.billedSince(transcriptBudgetMark, "transcript"));
}
```

Ten sam wzór powtarza się dla metadanych (`generate.ts:977`, `:987-1000`). Trzecie `settleBudget`
zwalnia rezerwację na 0 przed fetchem (`generate.ts:675`). Route musi wiedzieć, że:
transkrypcja kosztuje ≤ 1 kredyt, bo `mode=native` (`supadata-budget.ts:48-52`); metadane ≤ 2,
bo `metadata.ts` robi retry (`supadata-budget.ts:54-61`); koszt jest w nagłówku, a nie w wyniku
(`generate.ts:704-707`); nazwy operacji to `"transcript"` i `"metadata"`
(`supadata-ledger.ts:24`); plan dopuszcza 1 req/s (`generate.ts:945-949`). Zmiana dostawcy albo
jego planu to zmiana w route.

### 3.4 Kształt vendora w kontrakcie wspólnym i w UI

- `src/types.ts:58-61`: *„Field names stay vendor-shaped (`thumbnailUrl`); mapping onto
  `thumbnail_url_reported` happens in the persist layer, where the column name records that the
  value is what Supadata said”*. DTO nazwane `VideoMetadata` (`src/types.ts:67`) jest w praktyce
  kształtem odpowiedzi Supadaty.
- Mapowanie DTO ↔ kolumny istnieje w **dwóch** miejscach, choć komentarz twierdzi, że w jednym:
  `metadata-cache.ts:85-94` (*„This is the one place the two meet”*) oraz
  `summaries.ts:318-322`.
- `src/types.ts:4-10`: `TranscriptResolvedVia = "inline" | "job" | "stored"`. `inline` i `job` to
  gałęzie odpowiedzi Supadaty (`transcript.ts:362-381`). Ten typ jest kolumną DB
  (`transcript-guard.ts:83`) i polem w route (`generate.ts:466`, `:550`).
- **UI naprawia quirk vendora.** `VideoThumbnail.tsx:12`: *„`maxresdefault` — which is what
  Supadata reports — does not exist for videos never uploaded above 480p”*. Komponent dostaje
  surowe `thumbnailUrlReported` (`SummaryCard.tsx:162`, produkowane w `summary-list.ts:89`) i sam
  w przeglądarce decyduje o zaufaniu do hosta (`VideoThumbnail.tsx:26-42`) oraz o fallbacku
  (`:17-19`). To reguła bezpieczeństwa i reguła domenowa, obie po złej stronie granicy.

### 3.5 Nazwa vendora w schemacie

Tabele `supadata_calls` (`20260728120000_generation_telemetry.sql:95`), `supadata_budget` i
`supadata_reservations` (`20260731150000_supadata_budget.sql:52`, `:155`) oraz trzy RPC z nazwą
vendora (`:266`, `:517`, `:598`) wiążą **persystencję** z dostawcą. Drugi dostawca oznaczałby
drugi komplet tabel albo kłamliwe nazwy. Klucze Sentry `[supadata-budget]`, `[supadata-ledger:*]`
(`reporting.ts:20-24`) robią to samo z monitoringiem.

### 3.6 Intencja kontra kod

| Deklaracja | Cytat | Stan kodu |
| --- | --- | --- |
| Zamienniki „same shape” | `transcript-llm-probe/docs/supadata.md:52-54` | kształt Supadaty w `types.ts:58-69`, w route (§3.3) i w DB (§3.5) |
| Wymiana biblioteki transkrypcji w pre-mortem | `infrastructure.md:69` | wymiana dotyka 6 warstw (Krok 1) |
| Reusable seam dla transkrypcji | `transcript-llm-probe/plan.md:7` | seam przecieka meterem, kluczem i cennikiem do route |
| „Generic (za ACL)” | `01-domain-distillation.md:119` | ACL nie istnieje; jej zaczątki są rozsiane po trzech modułach |
| „types-only dependency” | `supadata-responses.ts:4-6` | import wartości `SupadataError` (§3.2) |
| Wzorzec dotrzymany gdzie indziej | LLM: `plan.md:190`; Sentry: `roadmap.md:384` | `llm.ts`, `reporting.ts` |

---

## Krok 4 — Projekt ACL

### 4.1 Granica i nazwy

Pojęcie domenowe to **źródło treści wideo** (`VideoSource`): coś, co za opłatą operatora zwraca
transkrypcję i opis filmu YouTube. „Supadata” to jedna z implementacji.

```
src/lib/domain/video-source/          ← język domeny; zero importów vendora
  video-source.port.ts                ← WĄSKI port (4.3)
  transcript.ts                       ← VO Transcript, TranscriptLookup, TranscriptProvenance
  video-metadata.ts                   ← VO VideoMetadata, ReportedThumbnail
  provider-charge.ts                  ← VO ProviderCharge, Paid<T>  (4.2, rdzeń ACL)
  persistence.ts                      ← jedyne mapowanie VO ↔ kolumny/RPC
src/lib/acl/video-source/supadata/    ← JEDYNY katalog, który zna Supadatę
  supadata-video-source.ts            ← adapter implementujący port
  transport.ts                        ← jeden GET: host, x-api-key, deadline, nagłówek kosztu, rate gate
  errors.ts                           ← SupadataErrorCode (8 kodów + "unknown"), klasyfikacja
  mapping.ts                          ← wire JSON → VO; cennik; normalizacja
  env.server.ts                       ← kompozycja: czyta SUPADATA_API_KEY z astro:env
  __fixtures__/supadata-responses.ts  ← przeniesione fixture’y
```

Umiejscowienie `src/lib/domain/` jest zgodne z 02 (`GenerationAttempt`). Katalog `acl/` jest nowy: `find src -iname "*acl*" -o -iname "*adapter*"` nie zwraca nic.
Grep `acl|adapters` w `src/` nie zwrócił żadnych trafień.

### 4.2 Rdzeń: `ProviderCharge` i `Paid<T>`

Dzisiejsza wiedza o kształcie zależności, która przecieka najdalej, to **„ile kosztowało to jedno
wywołanie i skąd to wiemy”**. Siedzi w nagłówku (`supadata-ledger.ts:205-220`), w cenniku
(`supadata-budget.ts:48-61`), w komentarzu o 206 (`supadata-budget.ts:565-567`) i w logice okna
(`supadata-ledger.ts:80-95`). Przejmuje ją jeden VO.

```ts
// src/lib/domain/video-source/provider-charge.ts — bez importów vendora

export type ProviderOperation = "transcript" | "transcriptPoll" | "metadata";
export type CallOutcome = "ok" | "unavailable" | "error";

/** Skąd znamy koszt. Rozróżnienie jest load-bearing (supadata-ledger.ts:12-16). */
export type ChargeBasis =
  | { kind: "reported"; credits: number }        // dostawca podał wartość
  | { kind: "documented"; credits: number }      // cennik dostawcy (np. 206 = 1), bez odczytu
  | { kind: "unknown"; ceiling: number };        // brak odpowiedzi / timeout; maks. z cennika

export class ProviderCharge {
  private constructor(
    readonly operation: ProviderOperation,
    readonly outcome: CallOutcome,
    readonly basis: ChargeBasis,
    readonly httpStatus: number | null,          // dowód, nie źródło decyzji
    readonly provenance: TranscriptProvenance | null,
  ) {}

  static reported(op, outcome, credits, status, provenance?): ProviderCharge   // credits: int >= 0
  static documented(op, outcome, credits, status, provenance?): ProviderCharge
  static unknown(op, outcome, ceiling, status: number | null): ProviderCharge

  /** Wartość dla settle breakera. `null` = nieznane → RPC liczy maksimum rezerwacji. */
  forSettlement(): number | null {
    switch (this.basis.kind) {
      case "reported":
      case "documented": return this.basis.credits;
      case "unknown":    return null;
    }
  }

  /** Jedyny zapis do księgi. Kolumny neutralne (Krok 6, faza A4). */
  toLedgerRow(ctx: { userId: string | null; youtubeId: string | null; summaryId: string | null }): ProviderCallRow
}

/** Wynik płatnej operacji: wartość domenowa + wszystko, co zapłacono po drodze. */
export interface Paid<T> {
  readonly value: T;
  readonly charges: readonly ProviderCharge[];
}

/** Suma dla settle: nieznane jest zaraźliwe (supadata-ledger.ts:85-88), brak wywołań = 0. */
export function settlementOf(charges: readonly ProviderCharge[]): number | null {
  let total = 0;
  for (const c of charges) {
    const v = c.forSettlement();
    if (v === null) return null;
    total += v;
  }
  return total;
}
```

`Paid<T>` zastępuje `SupadataMeter.checkpoint/billedSince` (`supadata-ledger.ts:79-95`). Opłaty
wracają **z wynikiem wywołania**, więc filtrowanie po `operation` przestaje być potrzebne. Dziś
jest „load-bearing, not defensive” (`supadata-ledger.ts:91-93`), bo route zagnieżdża dwa okna na
jednym meterze. Po zmianie okien nie ma.

### 4.3 Wąski port

```ts
// src/lib/domain/video-source/video-source.port.ts

export interface VideoRef { readonly youtubeId: string; readonly url: string }

export type TranscriptLookup =
  | { kind: "found"; transcript: Transcript }
  | { kind: "noCaptions" }                              // trwałe; wolno cache’ować negatywnie
  | { kind: "transientFailure"; cause: "jobFailed" | "timedOut" | "sourceError" | "throttled" };

export interface BudgetReading { readonly maxCredits: number; readonly usedCredits: number }

export interface VideoSource {
  /** Stała tożsamość do księgi i breakera; jedyne miejsce, gdzie pada nazwa dostawcy. */
  readonly providerId: string;

  /** Nigdy nie rzuca: błąd transportu to `transientFailure` + opłata `unknown`. */
  fetchTranscript(video: VideoRef): Promise<Paid<TranscriptLookup>>;

  /** Nigdy nie rzuca (kontrakt z metadata.ts:156-171). Retry jest wewnątrz. */
  fetchMetadata(video: VideoRef): Promise<Paid<VideoMetadata | null>>;

  /** Maksymalny koszt operacji według cennika dostawcy; rezerwuje breaker. */
  ceilingFor(op: "transcript" | "metadata"): number;

  /** Odczyt licznika konta; `null` przy dowolnej awarii (fail-open, supadata-budget.ts:27-32). */
  readBudget(): Promise<BudgetReading | null>;
}
```

Port ma cztery metody i jedno pole. Nie ma w nim klucza API, `Response`, nagłówków, `mode`, `lang`,
`jobId` ani meteru. Klucz wiąże się raz, w kompozycji:

```ts
// src/lib/acl/video-source/supadata/env.server.ts
import { SUPADATA_API_KEY } from "astro:env/server";
export function createVideoSource(): VideoSource | null {
  return SUPADATA_API_KEY ? createSupadataVideoSource({ apiKey: SUPADATA_API_KEY }) : null;
}
```

`generate.ts` i `config-status.ts` wołają `createVideoSource()` i sprawdzają `null`. Nie znają
nazwy zmiennej.

### 4.4 Obiekty wartości opisu i transkrypcji

```ts
// src/lib/domain/video-source/transcript.ts
export type TranscriptProvenance = "fetchedSync" | "fetchedAsync" | "stored";

export class Transcript {
  static create(text: string, track: { lang: string | null; availableLangs: readonly string[] | null },
                provenance: TranscriptProvenance): Transcript
  get isBlank(): boolean                    // dziś generate.ts:823 i :796 osobno
  get length(): number
  withProvenance(p: "stored"): Transcript   // odczyt z cache
}

// src/lib/domain/video-source/video-metadata.ts
export class ReportedThumbnail {
  /** Wartość „jak zgłosił dostawca”, nigdy naprawiana (01 D3, types.ts:39-44). */
  static fromReported(url: string | null): ReportedThumbnail
  /** Gotowe dane dla UI: zaufany src albo null + zawsze istniejący fallback. */
  forDisplay(youtubeId: string): { src: string | null; fallbackSrc: string }
}

export class VideoMetadata {
  static create(p: { title: string | null; channelName: string | null; channelId: string | null;
                     durationSeconds: number | null; publishedAt: Date | null;
                     thumbnail: ReportedThumbnail }): VideoMetadata   // duration: int >= 0 albo null
}
```

`forDisplay` przejmuje `ALLOWED_THUMBNAIL_HOSTS` i `derivedThumbnailUrl`
(`VideoThumbnail.tsx:17-42`). Zamiast pola `thumbnailUrl` jest `thumbnail`, więc „vendor-shaped”
(`src/types.ts:60`) znika z kontraktu.

### 4.5 Jedyne mapowanie do i z persystencji

```ts
// src/lib/domain/video-source/persistence.ts
const PROVENANCE_COLUMN = { fetchedSync: "inline", fetchedAsync: "job", stored: "stored" } as const;
// Wartości kolumn zostają: to dane historyczne. Nazwy domenowe mapuje JEDNO miejsce.

export const transcriptCodec = {
  toCacheParams(video: VideoRef, lookup: TranscriptLookup, fetchMs: number): SaveTranscriptCacheParams,
  fromCacheRow(row: TranscriptCacheRow): TranscriptLookup | { kind: "tooLong" } | null,
};

export const metadataCodec = {
  toParams(m: VideoMetadata): { p_title; p_thumbnail_url_reported; p_channel_name; p_channel_id;
                                p_duration_seconds; p_published_at },   // PG_INT_MAX tutaj
  fromRow(row: VideoColumns): VideoMetadata,
};
```

`metadata-cache.ts:85-94`, `:120-130` i `summaries.ts:318-322` wołają `metadataCodec`. Dwa
równoległe mapowania znikają. Limit `PG_INT_MAX` (`metadata.ts:141-153`) to wiedza o **kolumnie**,
a nie o vendorze, więc przenosi się tutaj.

### 4.6 Adapter: pseudokod

```ts
// src/lib/acl/video-source/supadata/transport.ts — JEDEN GET zamiast trzech
const BASE_URL = "https://api.supadata.ai/v1";
const MIN_SPACING_MS = 1200;                       // plan Free: 1 req/s (dziś metadata.ts:14)

export async function supadataGet<T>(path, apiKey, timeoutMs, isValid): Promise<WireResult<T>> {
  await rateGate.wait(MIN_SPACING_MS);             // spacing w adapterze, nie w route/breakerze
  let res: Response;
  try {
    res = await fetch(BASE_URL + path, { headers: { "x-api-key": apiKey }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    return { kind: "noResponse", timedOut: isTimeout(e) };           // bez statusu, bez kosztu
  }
  const reported = readBillableCredits(res);                         // przeniesione 1:1
  if (!res.ok)          return { kind: "vendorError", code: classify(await safeJson(res)), status: res.status, reported };
  if (!isJson(res))     return { kind: "vendorError", code: "internal-error", status: res.status, reported };
  const body = await safeJson(res);
  if (!isValid(body))   return { kind: "vendorError", code: "internal-error", status: res.status, reported };
  return { kind: "ok", body, status: res.status, reported };
}
// Wynik jest unią, a nie wyjątkiem, więc `BilledSupadataError` i `SupadataError` przestają istnieć.

// src/lib/acl/video-source/supadata/errors.ts
export type SupadataErrorCode =
  | "invalid-request" | "internal-error" | "forbidden" | "unauthorized" | "upgrade-required"
  | "transcript-unavailable" | "not-found" | "limit-exceeded" | "unknown";
export function classify(body: unknown): SupadataErrorCode   // nieznany string → "unknown", nie rzutowanie

// src/lib/acl/video-source/supadata/mapping.ts
const PRICE = { transcriptNative: 1, transcriptUnavailable206: 1, metadata: 1, poll: 0 } as const;

export function chargeFor(op, wire: WireResult<unknown>, outcome: CallOutcome, provenance?): ProviderCharge {
  if (wire.kind === "noResponse")
    return ProviderCharge.unknown(op, "error", ceilingOf(op), null);         // timeout nadal płatny
  if (wire.reported !== null)
    return ProviderCharge.reported(op, outcome, wire.reported, wire.status, provenance);
  if (op === "transcript" && wire.status === 206)
    return ProviderCharge.documented(op, "unavailable", PRICE.transcriptUnavailable206, 206);
  return ProviderCharge.unknown(op, outcome, ceilingOf(op), wire.status);
}

// src/lib/acl/video-source/supadata/supadata-video-source.ts
export function createSupadataVideoSource({ apiKey }): VideoSource {
  return {
    providerId: "supadata",
    ceilingFor: (op) => (op === "transcript" ? 1 : 2),     // native = 1; metadata z retry = 2
    async fetchTranscript(video) {
      const q = `?url=${enc(video.url)}&text=true&mode=native&lang=en`;
      const wire = await supadataGet(`/transcript${q}`, apiKey, 90_000, isTranscriptOrJobId);
      if (wire.kind !== "ok")
        return paid({ kind: "transientFailure", cause: causeOf(wire) }, [chargeFor("transcript", wire, "error")]);
      if ("jobId" in wire.body) return pollJob(wire, apiKey);                // fetchedAsync
      if (typeof wire.body.content !== "string")
        return paid({ kind: "noCaptions" }, [chargeFor("transcript", wire, "unavailable")]);
      return paid(
        { kind: "found", transcript: Transcript.create(wire.body.content, wire.body, "fetchedSync") },
        [chargeFor("transcript", wire, "ok", "fetchedSync")],
      );
    },
    async fetchMetadata(video) { /* 1 retry na limit-exceeded / noResponse; mapping → VideoMetadata */ },
    async readBudget() { /* GET /me, isCreditFigure, null przy każdej awarii */ },
  };
}
```

`TRANSCRIPT_MODE` z uzasadnieniem D1/D2 (`transcript.ts:72-99`) i `lang=en` z dowodem
(`transcript.ts:283-305`) przenoszą się do adaptera **razem z komentarzami**. To są decyzje o
kontrakcie vendora, a nie o domenie.

### 4.7 Co zostaje w domenie i w aplikacji (nie w adapterze)

- **Breaker** (`reserve`/`settle`, singleton, sweep): logika operatora niezależna od vendora.
  Przyjmuje `VideoSource`, bo z portu bierze `ceilingFor` i `readBudget`, oraz `settlementOf(charges)`.
  Spacing po `/v1/me` (`supadata-budget.ts:461-465`, `:491-493`) przejmuje `rateGate` w transporcie.
  Breaker przestaje importować `metadata.ts`.
- **Cache transkrypcji i metadanych**: reguły TTL i negatywnego cache’owania są domenowe. Mapują
  przez `transcriptCodec` / `metadataCodec`.
- **Guard/quote** (`transcript-guard.ts`): domenowy. Typ provenance bierze z VO.

---

## Krok 5 — Dowód izolacji i before/after

### 5.1 Wymiana Supadaty na innego dostawcę (np. TranscriptAPI.com z `research.md:38`)

| Dotknięte | Zmiana |
| --- | --- |
| `src/lib/acl/video-source/<nowy>/**` | nowy adapter: transport, błędy, mapping, cennik, `env.server.ts` |
| `astro.config.mjs` (schemat env) | nowa nazwa sekretu, jedna linia; to konfiguracja, a nie kod |
| Import w jednym pliku kompozycji | `createVideoSource` wskazuje nowy adapter |

| **Niedotknięte** | Dlaczego |
| --- | --- |
| `generate.ts` | zna tylko `VideoSource`, `Paid<T>`, `TranscriptLookup`, `settlementOf` |
| breaker, cache, guard, `credits.ts`, `summaries.ts`, `summary-list.ts` | pracują na VO i kodekach |
| `src/types.ts`, DTO `SummaryListItem`, `GET /api/summaries` | pola `thumbnail.src` / `fallbackSrc`, bez nazw vendora |
| `VideoThumbnail.tsx`, `SummaryCard.tsx` | dostają gotowe `{ src, fallbackSrc }` |
| tabele `provider_calls`, `provider_budget`, `provider_reservations` i ich RPC | kolumna `provider` = `providerId`; wartości `resolved_via` mapowane w kodeku |
| `reporting.ts`, klucze Sentry | `[provider-budget]`, `[provider-ledger:*]` |
| testy integracyjne endpointu, e2e | fake’ują port albo seedują cache (bez nazw vendora) |
| konfiguracja bundlera | alias `cross-fetch` i `optimizeDeps.exclude` usunięte razem z pakietem |

Uwaga do granic dowodu: dwa dostawców równolegle (np. fallback) wymagałoby rozszerzenia breakera o
wiele singletonów. Kolumna `provider` przygotowuje na to schemat, ale nie jest to cel tego planu.

### 5.2 Before / after dla zduplikowanych miejsc

| Miejsce | Before | After |
| --- | --- | --- |
| host ×3 (`transcript.ts:42`, `metadata.ts:21`, `supadata-budget.ts:114`) | trzy literały | `transport.ts: BASE_URL` |
| `x-api-key` ×3 (`transcript.ts:167`, `metadata.ts:63`, `supadata-budget.ts:354`) | trzy nagłówki | `supadataGet` |
| `isErrorBody` ×2 (`transcript.ts:106-108`, `metadata.ts:41-43`) | rzutowanie na unię SDK | `errors.classify` z `"unknown"` |
| mapowanie błędów ×3 (`transcript.ts:183-234`, `metadata.ts:76-107`, `supadata-budget.ts:358-369`) | wyjątki SDK / `null` | `WireResult` union |
| `RETRY_DELAY_MS` import (`supadata-budget.ts:2` ← `metadata.ts:14`) | stała vendora w module funkcji | `rateGate` w transporcie |
| cennik (`supadata-budget.ts:52`, `:61`) importowany przez route (`generate.ts:14-15`) | stałe w route | `videoSource.ceilingFor(op)` |
| okna metera ×2 (`generate.ts:709-727`, `:987-1000`) | `checkpoint` + `billedSince(mark, op)` | `settlementOf(result.charges)` |
| try/catch → 502 (`generate.ts:710-716`) | wyjątek z adaptera | `lookup.kind === "transientFailure" && cause === "sourceError"` |
| mapowanie metadanych ↔ kolumny ×2 (`metadata-cache.ts:85-94`, `summaries.ts:318-322`) | dwa miejsca, komentarz twierdzi „one place” | `metadataCodec` |
| `"inline"/"job"` (`types.ts:10`, `generate.ts:466`) | mechanizm vendora jako typ wspólny | `TranscriptProvenance` + kodek |
| blank check ×2 (`generate.ts:796`, `:823`) | dwa `trim().length === 0` | `transcript.isBlank` |

Route, fragment transkrypcji (szkic):

```ts
// BEFORE (generate.ts:654-729, skrót)
const transcriptBudget = await reserveBudget(admin, supadataKey, TRANSCRIPT_BUDGET_CREDITS);
const mark = meter.checkpoint();
try { transcript = await fetchTranscript({ url }, supadataKey, meter); }
catch { return Response.json({ error: "The transcript service failed…" }, { status: 502 }); }
finally { if (transcriptBudget.outcome === "reserved")
  await settleBudget(admin, transcriptBudget.reservationId, meter.billedSince(mark, "transcript")); }

// AFTER
const budget = await breaker.reserve(videoSource, "transcript");
const { value: lookup, charges } = await videoSource.fetchTranscript(video);
ledger.append(charges);                                   // flush w POST.finally jak dziś
await breaker.settle(budget, settlementOf(charges));      // adapter nie rzuca → brak try/finally
if (lookup.kind === "transientFailure" && lookup.cause === "sourceError") return upstreamFailed();
```

### 5.3 UI dostaje dane domenowe, a nie surowy obiekt vendora

```ts
// BEFORE — src/types.ts:104-105, summary-list.ts:89, VideoThumbnail.tsx:56-59
thumbnailUrlReported: string | null;                       // „What Supadata last reported”
const trusted = reportedUrl && isTrustedThumbnailUrl(reportedUrl) ? reportedUrl : null;

// AFTER — SummaryListItem
thumbnail: { src: string | null; fallbackSrc: string };    // ReportedThumbnail.forDisplay(youtubeId)
// VideoThumbnail: stage "reported" → "derived" → "placeholder" zostaje (onError jest obserwowalny
// tylko w przeglądarce, VideoThumbnail.tsx:48-51); allowlista i fallback przychodzą gotowe.
```

Kolumna `videos.thumbnail_url_reported` zostaje. Jej nazwa mówi „zgłoszone przez dostawcę”, a nie
„przez Supadatę”, więc jest już neutralna.

### 5.4 Otwarte pytania zależne od kontraktu Supadaty: rozstrzygnięcia

Źródło: dokumentacja Supadaty przez Context7 (`/llmstxt/supadata_ai_llms_txt`: *get-transcript
§Pricing*, *§Latency*, *api-reference/account/me*, *errors/list*, *errors/limit-exceeded*) oraz
pomiary zapisane w repo.

| # | Pytanie (gdzie dziś otwarte) | Co mówi dokumentacja | Decyzja | Gdzie zakodować |
| --- | --- | --- | --- | --- |
| Q1 | Czy 206 `transcript-unavailable` kosztuje, skoro nie ma nagłówka? (`supadata-budget.ts:565-567`, `supadata-ledger.ts:85-88`) | *„a 1-credit charge applies if a request returns a 206”* | `ProviderCharge.documented(1)`. Settle dostaje **1**, a nie `null` (dziś wynik ten sam przez maksimum rezerwacji, ale z mylącym „unknown”). Księga zachowuje `basis`, więc „measured vs documented” zostaje rozróżnialne | `mapping.ts: chargeFor` |
| Q2 | Czy timeout z naszego `AbortSignal` jest płatny? (`transcript.ts:149-154` zapisuje `null`) | *„timed-out requests still consume credits”* | `ProviderCharge.unknown(ceiling)`, czyli nie „0” i nie „brak odpowiedzi = darmo”. Settle `null` → maksimum rezerwacji (zachowanie dzisiejsze, teraz nazwane) | `mapping.ts` |
| Q3 | Czy opłatę niesie `202` czy polling? (`transcript.ts:363-364`, `:385-387`) | *„Checking job status is free”*; 202 dotyczy AI-transkrypcji > 20 min | Poll = `documented(0)`, gdy brak nagłówka. Pod `mode=native` gałąź jest nieosiągalna (`transcript.ts:90-92`), więc pytanie zamknięte, a nie odłożone | `mapping.ts: PRICE.poll` |
| Q4 | Czy `limit-exceeded` to rate limit, czy wyczerpany plan? (`metadata.ts:110-132` retry) | *„either the rate limit has been surpassed or the monthly quota has been exhausted”* | Kod jest niejednoznaczny, więc: (a) retry metadanych **raz**, jak dziś; (b) adapter mapuje to na `transientFailure: "throttled"`; (c) breaker traktuje `throttled` jako sygnał do unieważnienia odczytu budżetu (wymusza `/me` przy następnej rezerwacji). Punkt (c) to **nowe zachowanie**: osobna faza z testem | (a)(b) `supadata-video-source.ts`; (c) breaker (reakcja na domenowe `throttled`, bez kodu vendora) |
| Q5 | Pełna lista kodów błędów (SDK 1.4.0 ma 7) | OpenAPI: 8, w tym `forbidden` | Własna unia + `"unknown"`; `forbidden` jak `unauthorized` (trwałe, bez retry) | `errors.ts` |
| Q6 | Czy `x-billable-requests` to kredyty, czy żądania? | Brak w publicznej dokumentacji (zapytanie Context7 o nagłówek nie zwróciło wzmianki) | Zostaje rozstrzygnięcie z pomiaru: jednostka to kredyty (`supadata-ledger.ts:198-203`). Nagłówek to wiedza **wyłącznie** adaptera | `transport.ts: readBillableCredits` |
| Q7 | `maxCredits`/`usedCredits`: liczby czy całkowite? (`supadata-budget.ts:344-349`) | OpenAPI: `type: number` | Nasze zawężenie do nieujemnych całkowitych jest świadomie **ostrzejsze** od kontraktu. Zostaje, udokumentowane jako decyzja ACL | `supadata-video-source.ts: readBudget` |
| Q8 | `author.username` wymagane w typie SDK, nieobecne dla YouTube (`metadata.ts:192-196`) | — | Nie używamy typu SDK: wire JSON zawężany ręcznie w `mapping.ts` | `mapping.ts` |

Żadne z tych rozstrzygnięć nie trafia do `generate.ts`. Route widzi tylko `TranscriptLookup` i
`settlementOf`.

---

## Krok 6 — Weryfikacja i plan

### 6.1 Kryterium sukcesu (grep)

```bash
# 1. Kontrakt vendora: tylko adapter
rg -l "@supadata/js|api\.supadata\.ai|x-billable-requests|x-api-key|SupadataError|jobId|limit-exceeded" \
   src tests scripts astro.config.mjs
#   → oczekiwane: wyłącznie src/lib/acl/video-source/supadata/**

# 2. Nazwa vendora w kodzie
rg -il "supadata" src tests --glob '!src/lib/acl/video-source/supadata/**'
#   → oczekiwane: pusto

# 3. Pakiet usunięty
rg '"@supadata/js"' package.json          # → pusto
rg "cross-fetch" astro.config.mjs src     # → pusto (shim usunięty)
```

Grep po nazwie nie złapie przecieku strukturalnego (patrz weryfikacja ast-grep w §1.1). Drugie
kryterium: `rg "thumbnailUrl\b|thumbnailUrlReported|\"inline\" \| \"job\"" src --glob '!src/lib/domain/video-source/persistence.ts'`
zwraca pusto, bo DTO i UI używają `thumbnail.src` / `fallbackSrc` oraz `TranscriptProvenance`.

Świadome wyjątki: `astro.config.mjs` (jedna linia schematu env, nazwa sekretu),
**zastosowane** migracje sprzed zmiany nazw (historii się nie edytuje, tak jak w 02 §5.1) oraz
`context/**`.

### 6.2 Kto dziś zna zależność, a kto po refaktorze

| Plik | Dziś | Po |
| --- | --- | --- |
| `astro.config.mjs` | alias, exclude, env | tylko env |
| `src/lib/shims/cross-fetch.mjs` | tak | **usunięty** |
| `src/pages/api/summaries/generate.ts` | tak | nie |
| `src/lib/config-status.ts` | tak | nie (`createVideoSource() !== null`) |
| `src/lib/services/transcript.ts` | tak | **usunięty** → adapter |
| `src/lib/services/metadata.ts` | tak | **usunięty** → adapter |
| `src/lib/services/supadata-budget.ts` | tak | → `provider-budget.ts`, nie |
| `src/lib/services/supadata-ledger.ts` | tak | → `provider-ledger.ts`, nie (parser nagłówka → adapter) |
| `transcript-cache.ts`, `transcript-guard.ts`, `metadata-cache.ts`, `summaries.ts`, `summary-list.ts` | tak (komentarze, kształt DTO) | nie |
| `src/lib/services/reporting.ts` | klucze `[supadata-*]` | nie |
| `src/types.ts` | tak | nie |
| `src/components/summaries/VideoThumbnail.tsx`, `SummaryCard.tsx` | tak | nie |
| `sentry.client.config.ts:8` | komentarz | nie |
| `src/lib/services/__fixtures__/supadata-responses.ts` | tak | → `acl/video-source/supadata/__fixtures__/` |
| `generate.int.test.ts`, `supadata-budget.int.test.ts`, `supadata-ledger.int.test.ts` | fixture’y HTTP | fake portu (endpoint, breaker) + testy kontraktowe adaptera przy fixture’ach |
| `tests/e2e/fixtures/{ledger,test,account,seed-cache}.ts` | `supadata_calls` | `provider_calls` |
| `src/test/authorization-invariants.int.test.ts` | roster z `supadata_*` | roster z `provider_*` |
| `src/lib/acl/video-source/supadata/**` | — | **jedyny** |

### 6.3 Fazy (konwencja: `/10x-new` → `/10x-plan` → `/10x-tdd` / `/10x-implement`; oznaczenia jak w 02)

**[TF]** = test-first, **[G]** = refaktor pod zielonymi testami (zachowanie bez zmian).

| Faza | Zakres | Tryb | Warstwa testów (test-plan §6) |
| --- | --- | --- | --- |
| **A0** | Świeży `npm run build` + grep `dist/server` na `SupadataError` (potwierdzenie §3.2). Testy kontraktowe **obecnych** `fetchTranscript`/`fetchVideoMetadata`/`readVendorBudget` na fixture’ach, obejmujące Q1–Q5 (206 bez nagłówka, timeout, `forbidden`, `limit-exceeded`). Opisują dzisiejsze wyjścia, żeby A2 był dowodem zachowania | **[G]** | integration stub (§6.2), `stubSupadataFetch` |
| **A1** | `src/lib/domain/video-source/`: `ProviderCharge`, `settlementOf`, `Transcript`, `VideoMetadata`, `ReportedThumbnail.forDisplay`, kodeki. Wyrocznia: README *Summary credits*, cennik z §5.4, `01` D3 — **nie** implementacja | **[TF]** | unit, czyste (§6.1); `it.each` per `ChargeBasis` i per host allowlisty |
| **A2** | Adapter `acl/video-source/supadata/` (transport, errors, mapping) implementujący port. Testy A0 przepięte na adapter: te same fixture’y, asercje na `Paid<T>` | **[G]** + **[TF]** dla Q1/Q5 | integration stub; fixture’y przeniesione, cytaty pomiarów bez zmian |
| **A3** | Route + breaker + ledger + cache na port i kodeki; `createVideoSource` w kompozycji; usunięcie `transcript.ts`, `metadata.ts`, metera z `checkpoint/billedSince`. `generate.int.test.ts` i `generate.db.int.test.ts` bez zmian asercji; e2e bez zmian | **[G]** | integration (oba layery) + e2e (3 specyfikacje) |
| **A4** | Migracja (`/new-migration`): `provider_calls` (+ `provider text not null`), `provider_budget`, `provider_reservations`, RPC `record_provider_calls` / `reserve_provider_credits` / `settle_provider_reservation` / `save_provider_budget`; ekspand z wrapperami starych nazw na czas deployu, potem kontrakt. Tabele wewnętrzne: zero polityk + `revoke all … from public, anon, authenticated, service_role` (CLAUDE.md). Roster autoryzacji i fixture’y e2e | **[TF]** | integration, prawdziwa baza (§6.2) + roster (§6.3) |
| **A5** | DTO UI: `SummaryListItem.thumbnail` z `forDisplay`; `VideoThumbnail` bez allowlisty; `types.ts` bez nazw vendora | **[TF]** dla `forDisplay`, **[G]** dla UI | unit + e2e (karta renderuje miniaturę albo placeholder) |
| **A6** | Usunięcie `@supadata/js`, shimu i konfiguracji Vite; klucze Sentry `[provider-*]` z testami promocji (`setReportingSink`); README → *Error monitoring*; test-plan §4/§6.2 (nowa ścieżka fixture’ów); `01:119` oznaczone jako zrealizowane; grep z §6.1 jako krok weryfikacji | **[TF]** dla kluczy | unit (promocja) + build (grep `dist/` w obie strony, jak §6.4 dla fake’a LLM) |
| **A7** (opcjonalna) | Q4(c): `throttled` unieważnia odczyt budżetu | **[TF]** | integration stub |

Zależność od 02: A3 dotyka tych samych linii `generate.ts` co P4 z 02. **Kolejność:** A0–A2
najpierw (niezależne od 02), potem A3 przed P4 z 02 albo razem z nim. Agregat `GenerationAttempt`
dostaje wtedy od razu `Paid<TranscriptLookup>` zamiast metera.

**Ryzyka:** (1) zmiana kluczy Sentry otwiera nowe issues i zeruje historię. Akceptowane, odnotowane
w README. (2) Rename tabel na chmurze wymaga ekspandu, bo działający Worker woła stare RPC. (3)
Mutation testing (Stryker) na `mapping.ts: chargeFor` i `settlementOf` po A2: to moduły
ryzyka #1/#2, ale bez progu, zgodnie z CLAUDE.md.

---

## Podsumowanie

Spośród czterech zależności z kontraktem obcego systemu wybrałem **Supadatę**. Przecieka przez sześć
warstw (build, API, serwisy, typy wspólne, UI, schemat DB) w 44 plikach (62 z testami), a dokumenty deklarują jej
wymienialność: zamienniki „same shape”, pre-mortem, „Generic (za ACL)” w 01. Kod tej deklaracji nie
dotrzymuje, choć dla OpenRoutera i Sentry projekt zrobił to poprawnie. Diagnoza pokazała trzy ręcznie
pisane, już rozjechane transporty tego samego API (`transcript.ts:160`, `metadata.ts:59`,
`supadata-budget.ts:351`). Pokazała też bibliotekę rzekomo „types-only”, która jest importowana jako
wartość i wymusza shim oraz wykluczenie w konfiguracji bundlera Workera. Cennik, limit 1 req/s i
rozliczanie per wywołanie HTTP siedzą w route, a UI sam naprawia quirk miniatur vendora. Projekt ACL
opiera się na VO `ProviderCharge`/`Paid<T>`, jedynym miejscu wiedzy „ile kosztowało wywołanie i
skąd to wiemy”, oraz na wąskim porcie `VideoSource` z czterema metodami. Adapter w
`src/lib/acl/video-source/supadata/` implementuje port, a kodeki w domenie są jedynym mapowaniem
do persystencji. Osiem pytań kontraktowych (206 = 1 kredyt, płatny timeout, darmowy polling,
niejednoznaczne `limit-exceeded`, brakujący `forbidden` i inne) rozstrzygnąłem na podstawie
dokumentacji i zakodowałem w adapterze, nie w API. Plan ma fazy A0–A7. Kryterium sukcesu: grep po
kontrakcie vendora zwraca tylko katalog adaptera, a pakiet `@supadata/js` znika z manifestu.
