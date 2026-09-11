# Browse Summary List (S-02) Implementation Plan

## Overview

Turn `/dashboard` into the surface where the user browses their saved summaries (FR-006). This is the first read-side UI in the app: an RLS-scoped read path, a card list with a character filter and inline expand, generation relocated into a dismissable dialog, and in-progress generations shown as live cards in the list.

Everything the list renders already exists in the database. S-01 writes summaries, S-08 persists the video metadata, and both tables keep `select` for `authenticated` behind owner-scoped RLS. **No migration, no RPC, and no change to the paid generation path.** The work is entirely in the read path and the UI.

## Current State Analysis

**Data — complete, and nothing renders it.**

- `summaries` holds `character`, `content`, `created_at`, plus S-07 telemetry and S-09 provenance. `videos` holds `title`, `thumbnail_url_reported`, `channel_name`, `duration_seconds`, `published_at`, `youtube_id` (`src/lib/services/summaries.ts:4-47`).
- Both tables were made single-writer (`supabase/migrations/20260726120000_videos_single_writer.sql`, `20260731130000_summaries_single_writer.sql`). `authenticated` keeps `select` and `delete`; the owner-scoped `videos_select_authenticated` / `summaries_select_authenticated` policies from `20260613145120` remain in force. An RLS-scoped read from the SSR client is the entire data layer.
- `summaries` is append-only per generation: `persist_summary` upserts `videos` on `(user_id, youtube_id)` but inserts a new `summaries` row unconditionally (`supabase/migrations/20260731120000_metadata_cache.sql:304-339`). There is no unique key on `(video_id, character)`.

**UI — a single card, no navigation, no read surface.**

- `/dashboard` is one centered `max-w-lg` glass card holding `GenerateSummaryForm` plus two links (`src/pages/dashboard.astro:30-59`). `Topbar.astro` exists but the dashboard does not use it.
- `GenerateSummaryForm` owns the whole generation lifecycle in local state: the idempotency key held across a network error, the long-video confirm quote, the `requestSeq` staleness guard, and the success result (`src/components/summaries/GenerateSummaryForm.tsx:104-237`).
- The hardened Markdown renderer lives inside that same file (`GenerateSummaryForm.tsx:38-60`): an allow-list that deliberately excludes `img` and `a` because LLM output is transcript-steered and untrusted.

**Real local data confirms the edge cases are not theoretical.** 16 summaries across 11 `videos` rows, verified via PostgREST during planning:

- Two rows carry all-null metadata (`dQw4w9WgXcQ`, `1zKTCcdVcGQ`) — pre-S-08 generations, never backfilled.
- The same `youtube_id` appears twice with different `character` values, which is exactly the duplication the flat-list decision accepts.
- Reported thumbnails come in three shapes: `/vi/<id>/maxresdefault.jpg`, `/vi_webp/<id>/maxresdefault.webp`, and `/vi/<id>/maxresdefault.jpg?sqp=…&rs=…` with signed query params that can expire.
- Durations span 51 s to 4523 s (1 h 15 m), so formatting needs both `m:ss` and `h:mm:ss`.
- `published_at` values are all midnight UTC — the vendor supplies date precision only.

## Desired End State

A signed-in user opens `/dashboard` and sees every summary they have ever generated, newest first, as cards carrying the video's thumbnail, title, channel, duration and upload date, plus a character badge and the creation date. Clicking a card expands the full summary in place. A character filter narrows the list to informational or educational. A "New summary" button opens the generation form in a dialog; while a generation runs, a live card sits at the top of the list showing which video is being summarized, and it resolves into a real card when the work commits.

Verification: with the local stack seeded as it is today, the list renders 16 cards for the two seeded users combined *only when read as that user* — each session sees only its own. The two null-metadata rows render an intentional-looking fallback rather than a broken card. A generation started from the dialog, with the dialog then closed, still lands in the list.

### Key Discoveries:

- **The PostgREST embed resolves across the composite FK.** `summaries.select("…, videos(…)")` returns `videos` as a to-one object, verified live against the local stack. The FK is `(video_id, user_id) → videos(id, user_id)` (`supabase/migrations/20260613145120_videos_and_summaries.sql:41`) and PostgREST detects it without a disambiguating hint.
- **Filtering on an embedded column does not filter parents.** `videos.title=not.is.null` nulls the embed instead of dropping the row — confirmed live. Any future filter on video fields needs `!inner`. The character filter is on `summaries` itself, so this does not bite here.
- **`AppDatabase` declares `Relationships: []`** (`src/lib/services/summaries.ts:74-75`), so supabase-js cannot infer the embed's type. The result must be narrowed at the boundary, exactly as `persistSummaryAndSettle` narrows its RPC result (`summaries.ts:318-321`).
- **The thumbnail needs a double fallback.** `thumbnail_url_reported` is what Supadata said and is never repaired; `maxresdefault` 404s for any video never uploaded above 480p. `src/types.ts:39-44` requires falling back on **both** null **and** a 404 to the derived `https://i.ytimg.com/vi/<youtube_id>/hqdefault.jpg`, and never writing that fallback back. A 404 is only observable client-side, so this is an `onError` handler, not a server check.
- **The generate success body carries no metadata.** It returns `summary`, `model`, `videoId`, `summaryId`, `creditsRemaining`, `cost`, `transcriptLength` (`src/pages/api/summaries/generate.ts:970-977`), and the replay branch returns even less (`generate.ts:300-307`). A card built from that response alone would not match the same card after a reload.
- **`transcript_lang` is deliberately not for display** (S-08 decision): it is the transcript's language, not the video's, so a "language" label would be false exactly when auto-translated tracks exist.
- **The dashboard already server-seeds an island** with `initialCredits` (`dashboard.astro:42`). The list follows that same pattern rather than fetching on mount.

## What We're NOT Doing

- **No deletion.** S-03 (`delete-summary`, FR-007) stays a separate slice. This surface is read-only; `GET /api/summaries` is built so S-03 can reuse it.
- **No design system.** S-06 (`app-design-system`) is queued behind this slice and owns cross-surface coherence. This slice matches the existing cosmic styling and does not introduce a new design language.
- **No migration, no schema change, no backfill.** Null metadata on old rows is rendered, not repaired.
- **No telemetry on the card.** `cost_usd`, `model`, `generation_ms` stay out: `cost_usd` is provider spend, not the credit the user paid, and showing them invites misreading.
- **No pagination.** The character filter replaces it at MVP scale.
- **No server-side reconstruction of in-progress state.** Pending cards are client-session-only.
- **No change to the generation endpoint, the credit ledger, or any paid path.** Phase 3 moves client state between components; it does not touch `POST /api/summaries/generate`.
- **No search, no sorting controls, no per-summary deep links.**

## Implementation Approach

Four phases, ordered so that regression risk to the working S-01 flow is isolated in one of them and carries no new behavior.

Phases 1 and 2 are purely additive: a read path, then a list rendered on the dashboard *alongside* the untouched inline generate form. Both are independently shippable, and after Phase 2 the slice's PRD requirement (FR-006) is already met.

Phase 3 is the structural move the user's dialog + in-progress choices force. Because the dialog is freely dismissable, an unmounted `GenerateSummaryForm` cannot finish its own paid request — so the fetch lifecycle, idempotency key, confirm quote and staleness guard lift into a `useGenerateSummary` hook owned by a parent island that outlives the dialog. The form becomes presentational. Its success criterion is that generation behaves *identically* to today.

Phase 4 then reads that hook's state to render pending, error and needs-confirmation cards at the top of the list, and re-reads `GET /api/summaries` on success so a freshly generated card is byte-identical to the same card after a reload.

## Critical Implementation Details

**The idempotency key must not be reset by the lift.** `GenerateSummaryForm` keeps `pendingRequest` in a ref that survives *only* across a network error — the one failure where the request may have been delivered and its reply lost (`GenerateSummaryForm.tsx:117-123`). Any HTTP response clears it. That lifetime must be preserved exactly when the logic moves into the hook: widening it (holding the key across an HTTP error) would replay a previous video's summary; narrowing it (minting a fresh key per attempt) would charge twice for one ambiguous retry. The same applies to `requestSeq` — it is bumped both on submit and on every quote-relevant input change, and both call sites must survive.

**A successful response is applied even when stale.** `GenerateSummaryForm.tsx:189-195` applies `response.ok` *before* the seq check, deliberately: the summary is already saved and the user already charged, so dropping it would hide both the result and the new balance. Phase 3 must keep that ordering; moving the seq check above it is the natural-looking refactor and it is wrong.

**Thumbnail fallback runs client-side and must not loop.** The derived URL is `https://i.ytimg.com/vi/<youtube_id>/hqdefault.jpg`. An `onError` that reassigns `src` will fire again if the fallback itself fails, so the handler needs a one-shot guard and a final non-image placeholder. Note the reported URLs are heterogeneous (`/vi/…jpg`, `/vi_webp/…webp`, and `…jpg?sqp=…&rs=…` with expiring signed params) — do not try to pattern-match or repair them, just let them fail into the fallback.

**The Markdown allow-list has one home.** Extracting `SUMMARY_ALLOWED_ELEMENTS` and the component map out of `GenerateSummaryForm` is a security requirement, not tidiness: a second, hand-rolled renderer in the list is how `img` and `a` quietly come back for content an attacker can steer through a transcript.

**Pending state dies on reload, and that is accepted.** A refresh mid-generation drops the in-progress card. The server-side generation lease and the idempotency ledger already prevent a double charge, so the cost of this is a missing spinner, not a lost credit. Reconstructing it would mean reading `credit_reservations` from the browser — a new server surface, out of scope.

**A 409 confirmation arriving with the dialog closed reopens the dialog.** The pending card shows a "needs confirmation" state whose action reopens the dialog, where the existing consent copy and pricing already live. The card does not duplicate the pricing UI.

---

## Phase 1: Read path — service and endpoint

### Overview

Add an RLS-scoped read of the user's summaries joined to their videos, exposed both as a service (for server rendering) and as `GET /api/summaries` (for the client re-read in Phase 4). No UI.

### Changes Required:

#### 1. Shared list DTO

**File**: `src/types.ts`

**Intent**: Add the shape the list renders, so the service, the endpoint and the components share one definition rather than three structural copies — the same reasoning that made `VideoMetadata` shared in S-08.

**Contract**: `SummaryListItem` — flat, UI-facing, camelCase. Carries `id`, `character`, `content`, `createdAt` from `summaries`, and `youtubeId`, `url`, `title`, `thumbnailUrlReported`, `channelName`, `durationSeconds`, `publishedAt` from the embedded video. Every video-derived field is nullable except `youtubeId` and `url`. Telemetry and `transcript_lang` are deliberately absent.

#### 2. List service

**File**: `src/lib/services/summary-list.ts`

**Intent**: Read the caller's own summaries with their video joined, newest first, and map the PostgREST row shape onto `SummaryListItem`. Kept separate from `summaries.ts`, which is the write/persist path.

**Contract**: `listSummaries(supabase: AppSupabaseClient, userId?: string): Promise<SummaryListItem[]>`. When `userId` is omitted the read is RLS-scoped to `auth.uid()`, mirroring `getBalance` (`src/lib/services/credits.ts:29-38`). Throws on a genuine DB error; returns `[]` when the user has none.

The select string is the one non-obvious part, since the embed's type cannot be inferred (`Relationships: []`) and must be narrowed at the boundary:

```
id, character, content, created_at,
videos ( youtube_id, url, title, thumbnail_url_reported, channel_name, duration_seconds, published_at )
```

ordered `created_at.desc`. `videos` arrives as a to-one object. The row is **guaranteed present**: `summaries.video_id`/`user_id` are `NOT NULL` behind the composite FK to `videos` (`supabase/migrations/20260613145120_videos_and_summaries.sql:4-13,34-42`), so an absent embed is a data-integrity fault, not a renderable state — the mapper narrows the embed as required and throws if it is missing. "Null metadata" means a **present** video whose descriptive columns (`title`, `thumbnail_url_reported`, `channel_name`, `duration_seconds`, `published_at`) are null; `youtube_id` and `url` are always there, which is what lets the DTO keep them non-nullable.

#### 3. List endpoint

**File**: `src/pages/api/summaries/index.ts`

**Intent**: Expose the same read over HTTP so the Phase 4 island can re-read after a successful generation.

**Contract**: `GET /api/summaries` with `export const prerender = false;` and an uppercase `GET` export, matching `generate.ts`. Returns `{ summaries: SummaryListItem[] }`. `401` when `locals.user` is absent, `503` when Supabase is unconfigured (mirroring `generate.ts:136,152`), `500` on a read failure. No query parameters — filtering is client-side.

### Success Criteria:

#### Automated Verification:

- Linting passes: `npm run lint`
- Build passes: `npm run build`

#### Manual Verification:

- `GET /api/summaries` signed in as the seeded local user returns only that user's rows, ordered newest first
- The response contains the two known all-null-metadata rows (`dQw4w9WgXcQ`, `1zKTCcdVcGQ`) with the summary itself intact
- A second signed-in user's response contains none of the first user's rows
- `GET /api/summaries` signed out returns `401`

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 2: List UI on the dashboard

### Overview

Render the list on `/dashboard` with thumbnails, metadata, character badge, filter and inline expand. The existing inline `GenerateSummaryForm` stays exactly where it is and keeps working — this phase adds a surface, it does not move one.

### Changes Required:

#### 1. Extracted Markdown renderer

**File**: `src/components/summaries/SummaryMarkdown.tsx`

**Intent**: Move `SUMMARY_ALLOWED_ELEMENTS` and `summaryMarkdownComponents` out of `GenerateSummaryForm.tsx:38-60` into a component both the form and the card use, so the `img`/`a` exclusion has exactly one definition.

**Contract**: `<SummaryMarkdown>{content}</SummaryMarkdown>`. Carries the existing allow-list and component map verbatim, including the comment explaining why `img` and `a` are excluded. `GenerateSummaryForm` is updated to use it and loses its local copies.

#### 2. Video thumbnail with fallback

**File**: `src/components/summaries/VideoThumbnail.tsx`

**Intent**: Render the reported thumbnail, degrading to the derived `hqdefault.jpg` on null **or** a load error, and to a non-image placeholder if that also fails.

**Contract**: Props `{ youtubeId: string; reportedUrl: string | null; title: string | null }`. A one-shot `onError` guard prevents an error loop. `alt` falls back to a generic label when `title` is null. The derived URL is never persisted anywhere.

#### 3. Formatting helpers

**File**: `src/lib/format.ts`

**Intent**: Format the three numeric/temporal fields the card shows.

**Contract**:

- `formatDuration(seconds: number | null): string | null` producing `m:ss` under an hour and `h:mm:ss` at or above it (local data spans 51 s to 4523 s).
- `formatPublishedDate(iso: string | null): string | null` rendering date precision only — the vendor supplies midnight UTC, so a time would be fabricated.
- `formatCreatedDate(iso: string): string` for the card's creation date. Non-nullable: `summaries.created_at` is `NOT NULL`.

Both date helpers return `YYYY-MM-DD` built from **UTC** parts, with no `Intl` locale involved.

**Why UTC and why locale-free.** This runs under SSR: the card is rendered once on the Worker and again during hydration in the browser. `Intl.DateTimeFormat` with an implicit locale resolves differently on each side and produces a hydration mismatch. UTC also protects `publishedAt` specifically — every stored value is midnight UTC, so reading it in any timezone west of Greenwich shifts the displayed date back a full day.

**Accepted cost**: a creation date is a real instant, not a date-only value, so a summary generated at 01:00 in Warsaw displays the previous day. This is the price of one deterministic render, and it is the smaller error — a date-only field silently off by one is worse than a timestamped one shown in UTC. Revisit if S-06 introduces locale-aware formatting; a client-only `useEffect` swap to local time is the escape hatch, deliberately not taken here.

#### 4. Summary card

**File**: `src/components/summaries/SummaryCard.tsx`

**Intent**: Render one summary: thumbnail, title, channel · duration · upload date, character badge, creation date, and a collapsed preview of the content that expands in place.

**Note — creation date is an addition beyond the brief.** `plan-brief.md:30` fixes the card fields as thumbnail, title, channel, duration, upload date and character badge; the creation date is not in that row, nor in FR-006 or the roadmap's S-08 outcome. It is kept deliberately: the flat list accepts the same video appearing once per character, and "generated on" is what distinguishes two otherwise near-identical cards. `created_at` is read regardless — it is the `newest first` sort key.

**Contract**: Props `{ item: SummaryListItem }`. Collapsed by default with local expand state; the expand control is a real `<button>` with `aria-expanded` (the repo lints with `eslint-plugin-jsx-a11y`). Title falls back to the `url`, which is non-null. When channel, duration and upload date are all absent the metadata row is omitted entirely rather than rendering three dashes. Expanded content renders through `SummaryMarkdown`.

#### 5. Summary list island

**File**: `src/components/summaries/SummaryList.tsx`

**Intent**: Render the cards and own the character filter. **Filter state only** — the summaries themselves are always owned by the caller, so Phase 4's refresh has exactly one owner and this component never has two sources of truth for the same list.

**Contract**: Props `{ summaries: SummaryListItem[] }` — controlled, not seeded. In Phase 2 the value comes straight from the server read in `dashboard.astro` (the same seeding pattern as `initialCredits`, `dashboard.astro:42`); in Phase 3 that prop starts being fed by `DashboardSummaries`, with no change to this component. Local state here is the three-way filter (all / informational / educational), applied client-side. Also takes `listUnavailable: boolean`. Three mutually exclusive non-list states: **unavailable** (the read failed — offer a reload, never claim the corpus is empty), **empty** (no summaries at all — "generate your first"), and **empty under filter** (offers to clear it).

#### 6. Dashboard renders the list

**File**: `src/pages/dashboard.astro`

**Intent**: Server-read the summaries alongside the existing credit read and render the list below the generate card. The page widens past `max-w-lg` to hold a list.

**Contract**: Reuses the existing `createClient` + try/catch shape (`dashboard.astro:11-27`): a failed read logs and still renders the page, because the list is not an enforcement gate. `GenerateSummaryForm` stays mounted with `initialCredits` unchanged.

**A failed read is its own state, not an empty list.** The catch branch passes `listUnavailable: true` alongside `summaries: []`, and `SummaryList` renders a distinct "couldn't load your summaries — reload the page" message. Collapsing a read failure into `[]` would show an existing user the "generate your first summary" copy, i.e. tell someone with 16 saved summaries that they have none — a wrong statement about their data, which is worse than an error. Three mutually exclusive states, then: unavailable, genuinely empty, and empty-under-filter.

### Success Criteria:

#### Automated Verification:

- Linting passes: `npm run lint`
- Build passes: `npm run build`

#### Manual Verification:

- `/dashboard` lists the signed-in user's summaries newest first, with the generate form still present and working
- A video generated for both characters appears as two cards, distinguishable by their badges
- The two null-metadata rows render with a thumbnail placeholder and no dangling metadata row, with their summary text intact
- A `vi_webp/…maxresdefault.webp` thumbnail either loads or visibly falls back to `hqdefault.jpg` — no broken-image icon
- Clicking a card expands the full summary; a second click collapses it
- The character filter narrows the list, and clearing it restores every card
- A user with no summaries sees the empty state, not an empty page
- With the read forced to fail (stop the local Supabase stack, reload `/dashboard`), the page renders the "couldn't load" state — not the "generate your first summary" copy

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 3: Lift generation state into a hook and a dialog

### Overview

Move the generation lifecycle out of `GenerateSummaryForm` into a hook owned by a parent island, and put the form in a dismissable dialog. **No behavior changes.** This phase is the regression risk of the slice, which is why it delivers nothing new.

### Changes Required:

#### 1. Generation hook

**File**: `src/components/hooks/useGenerateSummary.ts`

**Intent**: Hold everything `GenerateSummaryForm` currently keeps in local state — the `generate` function, `loading`, `error`, `confirm`, `result`, `credits`, the `requestSeq` staleness counter and the `pendingRequest` idempotency ref — so the lifecycle survives the dialog closing.

**Contract**: `useGenerateSummary({ initialCredits })` returning that state plus `generate(allowLong, url, character)` and an input-changed signal that bumps `requestSeq` and clears the confirm quote. `messageForStatus` moves with it unchanged. The three invariants called out in Critical Implementation Details — the idempotency key's exact lifetime, the `requestSeq` bump on both submit and input change, and applying a successful response *before* the staleness check — are preserved verbatim.

Two additions the ref-based state cannot provide, both needed by Phase 4 and cheap to add here:

- **`attempt: { url: string; character: SummaryCharacter } | null` — reactive state, not a ref.** `pendingRequest` stays a ref because its job is the idempotency key's lifetime; a ref cannot re-render the pending card, and it is cleared on any HTTP response *before* the error branch runs (`GenerateSummaryForm.tsx:135-182`), so an error card driven off it would have nothing to name. `attempt` is set on submit and cleared only when the attempt reaches a terminal state the UI has consumed.
- **`lastSuccess: { seq: number; summaryId: string; url: string; character: SummaryCharacter } | null`.** A monotonic `seq` makes success a *repeatable event* — two generations of the same video in a row are distinguishable, where a boolean or an object identity check is not. `summaryId` is already in the response body (`generate.ts:970-977`) and currently discarded; keeping it lets Phase 4 confirm the re-read actually contains the new row.

#### 2. Form becomes presentational

**File**: `src/components/summaries/GenerateSummaryForm.tsx`

**Intent**: Keep the URL/character/allowLong inputs, validation, the credit chip, the confirm prompt and the result block; delegate every request concern to the hook passed in from the parent.

**Contract**: Props change from `{ initialCredits }` to the hook's returned state and callbacks. `extractYoutubeId` validation, `urlError`, and the `submitDisabled` rule stay local — they are input concerns, not request concerns.

**The three quote-relevant inputs become controlled.** `url`, `character` and `allowLong` move to `DashboardSummaries` and arrive as `{ value, onChange }` pairs. `ui/dialog` does not force-mount its content (`src/components/ui/dialog.tsx:37-54`), so Radix unmounts the form on close and any state left local here is destroyed — reopening would show a blank URL and a default character sitting next to a retained confirm quote or a running request, which is precisely the mismatch the confirm prompt must not have. Keeping them in the parent also means the quote and the inputs it was priced from cannot drift apart.

**Clearing policy**: the inputs are cleared by the parent only on a *successful* generation (so the next summary starts from a clean form). An error, a dismissed dialog, or a pending confirmation all retain them, since each is a state the user may want to retry or confirm from.

Not every input is cleared, and clearing the URL is conditional:

- **`url`** resets only if the field still holds the URL that was just summarized. A paid success is applied even when it is stale, so an unconditional reset would erase a newer URL the user typed while the request was in flight.
- **`allowLong`** always resets: it is per-video consent to a 2-credit charge, and a retained toggle would let the *next* long video be charged double with no prompt. Dropping a toggle the user has to re-click is the safe direction.
- **`character`** persists. It is a preference rather than per-video consent, and a user summarizing several videos from one channel would otherwise re-pick it every time.

#### 3. Dashboard island

**File**: `src/components/summaries/DashboardSummaries.tsx`

**Intent**: The parent that owns the hook, the dialog and the list, so generation outlives the dialog's open state.

**Contract**: Props `{ initialSummaries: SummaryListItem[]; initialCredits: number | null }`. Calls `useGenerateSummary` at this level, renders a "New summary" trigger, a `ui/dialog` containing `GenerateSummaryForm`, and `SummaryList`. The dialog is freely dismissable — no `forceMount` needed, because the state that matters now lives in this component, not in the dialog's children.

**This component is the single owner of list state.** It holds `summaries` (seeded from `initialSummaries`) and passes it down to the controlled `SummaryList`; the list keeps only its filter. Phase 3 sets `summaries` once and never mutates it — the refresh machinery arrives in Phase 4, but the ownership is established here so Phase 4 adds no restructuring.

#### 4. Dashboard renders one island

**File**: `src/pages/dashboard.astro`

**Intent**: Replace the separate `GenerateSummaryForm` + `SummaryList` mounts with the single `DashboardSummaries` island.

**Contract**: Same two server reads (credits, summaries), both passed as initial props. The standalone `<GenerateSummaryForm client:load>` mount is removed.

#### 5. Fix the endpoint's stale cross-file pointer

**File**: `src/pages/api/summaries/generate.ts`

**Intent**: The 422 doc block explains *why* the server's error string must survive to the user and names its consumer: "`GenerateSummaryForm`'s `messageForStatus`" (`generate.ts:60-62`). This phase moves `messageForStatus` into `useGenerateSummary.ts`, which leaves that pointer aimed at a function no longer in the named file — and it is exactly the comment a future reader consults before changing the 422 body.

**Contract**: Update the reference to name the hook. **Comment only** — no code, no behavior, no signature touched. This does not breach "No change to the generation endpoint": that boundary is about the paid path's logic, and letting the refactor silently invalidate the note protecting it works against the same goal.

### Success Criteria:

#### Automated Verification:

- Linting passes: `npm run lint`
- Build passes: `npm run build`

#### Manual Verification:

- Generating a short video from the dialog succeeds and shows the summary and updated credit count, exactly as before
- A long video still produces the confirmation prompt, and "Generate anyway" charges 2 credits — the quote replays the confirmed inputs, not the live form
- Editing the URL while a confirm prompt is open discards the quote
- Submitting with an invalid URL is blocked with the same inline error
- Closing the dialog mid-generation and reopening it shows the request still running with its submitted URL and character still in the inputs, then its result
- The credit chip and the "no credits left" copy behave as before
- **Ambiguous-network-retry fault injection** (procedure in Testing Strategy): a request that commits server-side but whose response never reaches the client, then retried, replays the same summary and charges exactly one credit in total

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 4: In-progress cards in the list

### Overview

Surface the hook's in-flight state as a live card at the top of the list, and re-read the list on success so the new card matches what a reload would render.

### Changes Required:

#### 1. Pending card

**File**: `src/components/summaries/PendingSummaryCard.tsx`

**Intent**: Show the video currently being summarized, and what happened if it did not succeed, in the same visual slot the finished card will occupy.

**Contract**: Three states driven by the hook: *generating* (the submitted URL plus a spinner), *needs confirmation* (the long-video 409 arrived while the dialog was closed — action reopens the dialog), and *failed* (the hook's error message, with a dismiss). Visually distinct from a saved card so it is never mistaken for one; the summary body is never shown here, only in the real card after the re-read.

#### 2. List accepts a pending entry and refreshes

**File**: `src/components/summaries/SummaryList.tsx`

**Intent**: Render the pending card above the saved cards. The list stays controlled — refreshing is the parent's job, not this component's.

**Contract**: Adds props `{ pending: PendingSummary | null; refreshFailed: boolean }` alongside the existing `summaries`; it still owns nothing but its filter. `PendingSummary` is derived by the parent from the hook's `attempt` plus its status (generating / needs-confirmation / failed). The character filter never hides the pending card — a pending generation has a character, but hiding the thing the user just started is the wrong default. When `refreshFailed` is set the previous list stays rendered under a "reload to see your new summary" note rather than being cleared.

#### 3. Re-read on success

**File**: `src/components/summaries/DashboardSummaries.tsx`

**Intent**: On a successful generation, fetch `GET /api/summaries` and hand the fresh list to `SummaryList`, then clear the pending entry.

**Contract**: An effect watches `lastSuccess.seq`; each new value fires one `GET /api/summaries`. The re-read is best-effort — its failure sets `refreshFailed` and never discards the paid result already rendered in the dialog. The pending entry clears only once the re-read resolves, so there is no frame where the summary appears in neither place.

**Refresh sequence guard.** The component holds a monotonic refresh counter in a ref; a response whose counter is not the latest is discarded. Without it, two generations in quick succession can land out of order and overwrite the newer list with the older one — the same class of bug `requestSeq` already guards on the generate path. On a `refreshFailed` re-read the pending card is retained (not cleared) so the user still sees what was generated.

### Success Criteria:

#### Automated Verification:

- Linting passes: `npm run lint`
- Build passes: `npm run build`

#### Manual Verification:

- Starting a generation and closing the dialog shows a pending card at the top of the list naming the video
- On success the pending card is replaced by a real card carrying the video's thumbnail, title, channel, duration and upload date — identical to the card after a page reload
- A failed generation (e.g. a video with no transcript) turns the pending card into an error card carrying the server's message
- A long video submitted without "allow long", with the dialog closed, shows a needs-confirmation card whose action reopens the dialog with the prompt intact
- The character filter does not hide the pending card
- Reloading mid-generation drops the pending card, and the summary still appears once complete — no credit is double-charged

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful.

---

## Testing Strategy

The repo has no automated test suite (a stated MVP limitation), so verification is `npm run lint` (type-checked rules) plus `npm run build`, backed by manual testing against the seeded local stack.

### Manual Testing Steps:

1. Sign in as the seeded local user; confirm the list renders their summaries newest first and no others.
2. Sign in as the second seeded user; confirm complete isolation in both the page and `GET /api/summaries`.
3. Inspect the two known null-metadata rows (`dQw4w9WgXcQ`, `1zKTCcdVcGQ`) for the fallback rendering.
4. Inspect a `vi_webp/…webp` row and the `?sqp=…&rs=…` signed-param row for thumbnail behavior.
5. Expand and collapse cards; exercise the filter including the filtered-to-empty state.
6. Run a full generation from the dialog on a short video; confirm credits and the resulting card.
7. Repeat with the dialog closed immediately after submit; confirm the pending card and its replacement.
8. Repeat with a long video to exercise the confirmation path both with the dialog open and closed.
9. Repeat with a transcript-less video to exercise the error card.

### Ambiguous-network-retry fault injection (Phase 3, criterion 3.9)

The one paid-path invariant that lint, build and a normal generation cannot catch: the idempotency key must survive a network failure (the request may have been delivered and its reply lost) and must *not* survive an HTTP response. A regression in either direction is invisible until it double-charges. Make the ambiguity deterministic by killing the server after it commits, rather than racing a DevTools toggle:

1. Note the user's credit balance and their `summaries` row count in Studio (`http://localhost:54323`).
2. Submit a short video from the dialog. Watch the dev-server console.
3. The moment the persist/settle log line for that generation appears — the work is committed and charged — `Ctrl+C` the dev server. The in-flight `fetch` rejects with a network error, so the client keeps `pendingRequest`.
4. Restart `npm run dev` and resubmit **the same URL and character** without editing either field (editing bumps `requestSeq` and clears the quote, which is a different path).
5. Expect: the summary returns from the idempotency ledger's replay branch (`generate.ts:300-307`), the balance is **one** credit lower than in step 1, and `summaries` gained exactly **one** row.

Two credits spent, or a second row, means the key was re-minted. A replay of a *previous, different* video means the key was held too long.

### Edge cases to exercise explicitly:

- A user with zero summaries (empty state, not a blank page)
- Metadata present on the video but `title` null
- A summary whose Markdown contains a link or image — must render as text, never as `<a>` or `<img>`

## Performance Considerations

At MVP scale this is a non-issue and deliberately treated as one: a single user, credits capping the corpus, 16 rows locally. The read is one query with a to-one embed.

Worth recording rather than acting on: `summaries` has an index on `user_id` alone (`20260613145120:44`), not `(user_id, created_at)`. The unbounded `order by created_at desc` is fine at tens of rows and would need revisiting only if the corpus grew by orders of magnitude — which manual-only credit refills make unlikely.

Full summary bodies are sent with the initial page render even though they start collapsed. That is the cost of inline expand without a detail route; at current sizes it is well under the weight of a single thumbnail.

## Migration Notes

None. No schema change, no data migration, no backfill. Null metadata on pre-S-08 rows is rendered as absence, by design — the S-08 decision not to backfill (each row would cost a credit) stands.

## References

- Roadmap slice: `context/foundation/roadmap.md` — S-02, plus the Backlog Handoff row recording the `thumbnail_url_reported` rename and that S-08 ships no UI
- PRD: `context/foundation/prd.md` — FR-006, and the Business Logic section on why summary length varies (which motivates preview + expand)
- Write path this reads from: `supabase/migrations/20260731120000_metadata_cache.sql:304-339`
- Island seeding pattern: `src/pages/dashboard.astro:11-42`
- Markdown hardening being extracted: `src/components/summaries/GenerateSummaryForm.tsx:38-60`
- Idempotency/staleness invariants being lifted: `src/components/summaries/GenerateSummaryForm.tsx:104-237`
- Thumbnail contract: `src/types.ts:39-44`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Read path — service and endpoint

#### Automated

- [x] 1.1 Linting passes: `npm run lint` — 79e1102
- [x] 1.2 Build passes: `npm run build` — 79e1102

#### Manual

- [x] 1.3 `GET /api/summaries` returns only the signed-in user's rows, newest first — 2026-08-07, local
- [x] 1.4 Response contains the two all-null-metadata rows with summary text intact — 2026-08-07, local
- [x] 1.5 A second signed-in user's response contains none of the first user's rows — 2026-08-07, local
- [x] 1.6 `GET /api/summaries` signed out returns `401` — 2026-08-07, local

### Phase 2: List UI on the dashboard

#### Automated

- [x] 2.1 Linting passes: `npm run lint` — d42c5ba
- [x] 2.2 Build passes: `npm run build` — d42c5ba

#### Manual

- [x] 2.3 `/dashboard` lists summaries newest first with the generate form still working — 2026-08-09, local
- [x] 2.4 A video generated for both characters appears as two badge-distinguished cards — 2026-08-09, local
- [x] 2.5 Null-metadata rows render a placeholder and no dangling metadata row — 2026-08-09, local
- [x] 2.6 A `vi_webp` thumbnail loads or visibly falls back — no broken-image icon — 2026-08-09, local
- [x] 2.7 Cards expand and collapse on click — 2026-08-09, local
- [x] 2.8 The character filter narrows and clears correctly — 2026-08-09, local
- [x] 2.9 A user with no summaries sees the empty state — 2026-08-09, local
- [x] 2.10 A forced read failure renders the "couldn't load" state, not the empty state — 2026-08-09, local

### Phase 3: Lift generation state into a hook and a dialog

#### Automated

- [x] 3.1 Linting passes: `npm run lint` — 966a186
- [x] 3.2 Build passes: `npm run build` — 966a186

#### Manual

- [x] 3.3 Short-video generation from the dialog succeeds with correct credits — 2026-08-09, local
- [x] 3.4 Long-video confirmation charges 2 credits and replays the confirmed inputs — 2026-08-09, local
- [x] 3.5 Editing the URL with a confirm prompt open discards the quote — 2026-08-09, local
- [x] 3.6 Invalid URL is blocked with the same inline error — 2026-08-09, local
- [x] 3.7 Closing and reopening the dialog mid-generation preserves the running request and its inputs — 2026-08-09, local
- [x] 3.8 Credit chip and no-credits copy behave as before — 2026-08-09, local
- [x] 3.9 Ambiguous-network-retry fault injection replays the summary and charges one credit total — 2026-08-09, local

> **3.9 procedure note.** The Testing Strategy step "Ctrl+C the dev server the moment the persist/settle
> log line appears" is not executable: `generate.ts` logs nothing on the success path (every `console.*`
> in it sits in an error branch), and the gap between `persist_summary` returning and the response
> hitting the socket is microseconds wide, so a kill timed off a DB poll always loses the race. Verified
> instead with an equivalent, deterministic harness that touches no application code: a local proxy on
> the dev port forwarded one armed `POST /api/summaries/generate`, drained the upstream reply **in full**
> (so the work was certainly committed and charged), then destroyed the downstream socket without
> writing a byte — reproducing "delivered, reply lost" exactly. Observed: balance 3 → 2 and `summaries`
> 18 → 19 on the dropped attempt, then **unchanged** at 2 / 19 after resubmitting the same inputs, with
> the summary returned from the replay branch. One credit, one row.

### Phase 4: In-progress cards in the list

#### Automated

- [x] 4.1 Linting passes: `npm run lint` — ebd70dc
- [x] 4.2 Build passes: `npm run build` — ebd70dc

#### Manual

- [x] 4.3 Closing the dialog mid-generation shows a pending card naming the video — 2026-08-09, local
- [x] 4.4 On success the pending card is replaced by a card identical to the post-reload card — 2026-08-09, local
- [x] 4.5 A failed generation turns the pending card into an error card with the server's message — 2026-08-09, local
- [x] 4.6 A needs-confirmation card reopens the dialog with the prompt intact — 2026-08-09, local
- [x] 4.7 The character filter does not hide the pending card — 2026-08-09, local
- [x] 4.8 Reloading mid-generation drops the pending card without double-charging — 2026-08-09, local

> **Phase 4 manual run.** Exercised against the local stack with cached transcripts, so the run cost no
> Supadata calls and its outcomes were deterministic: `dFY97xFO_mY` (51 s, cached `ok`) for the success
> path, `jfKfPfyJRdk` (cached `unavailable`) for the failure card, `TVA738-ERqg` (~69,989 chars) for the
> long-video 409, and `aircAruvnKk` for the mid-generation reload. Ledger across the whole run: balance
> 5 → 2, `summaries` 20 → 22, and every `credit_reservations` row `settled` — none left `reserved`.
>
> 4.6 stops at the reopened prompt and does not confirm: the criterion is that the priced quote survives
> the dialog being dismissed and reopened, and confirming would spend 2 credits to re-verify Phase 3's
> 3.4, which already passed.
>
> Worth recording because the copy invites the opposite reading: the caption-less video in 4.5 **charged
> a credit** (4 → 3). That is the S-07 D14 policy — `generate.ts:529` calls
> `refuseAndCharge(…, "unavailable")` — and the ledger row confirms it (`settled`,
> `refusal_reason: unavailable`). Phase 4 touches no paid path; the error card is reporting the charge
> faithfully, not causing it.
