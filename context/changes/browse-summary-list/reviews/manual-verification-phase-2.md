# Phase 2 — Manual verification record

- **Change**: `browse-summary-list` (S-02)
- **Phase**: 2 — list UI on the dashboard: `SummaryMarkdown`, `VideoThumbnail`, `src/lib/format.ts`,
  `SummaryCard`, `SummaryList`, `dashboard.astro`
- **Date**: 2026-08-09
- **Environment**: **local only** — dev server on `localhost:4321` started on `cc3ffb1` (Phase 2 code
  `d42c5ba` plus its impl-review triage), local Supabase stack on `127.0.0.1:54321`. Nothing deployed.
- **Accounts**: **A** (operator account, 5 summaries — the only one holding the pre-S-08
  null-metadata rows, so it carries 2.5), **C** (`verify-s09@local.test`, 7 summaries — both
  characters and the `vi_webp` thumbnails, so it carries 2.3/2.4/2.6/2.7/2.8/2.10), **D** (second
  operator account, 0 summaries — 2.9).
- **Result**: **all eight rows pass (2.3–2.10)**.

## Method

Driven through a real Chrome browser rather than curl: every criterion in this phase is about what
renders, and three of them (thumbnail fallback, expand, filter) only exist client-side.

**Zero credits spent.** No summary was generated. 2.3's "the generate form still works" clause was
checked by submitting `https://example.com/not-a-video` and confirming the inline
`Enter a valid YouTube video URL.` still fires with the credit chip unmoved — the form's own
validation runs before any request, so this exercises the form without touching the paid path. A
real generation is Phase 3's criterion 3.3 and is deliberately left there.

Assertions were read out of the DOM, not eyeballed from screenshots. Two cases where that mattered:

- **Thumbnails**: a failed `<img>` still occupies its box and, at this size, looks plausible in a
  screenshot. `naturalWidth`/`naturalHeight` distinguishes a real decode from a broken one, and
  separates the reported source (1280×720 `maxresdefault`) from the derived fallback (480×360
  `hqdefault`) without inspecting the URL.
- **The Markdown allow-list**: `querySelectorAll('a').length` and `('img').length` inside the
  expanded body prove the exclusion held on real LLM output, which a visual scan cannot.

Ground truth was a service-role PostgREST read of `summaries` joined to `videos`, taken before the
page was opened, so card order and counts were diffed against the database rather than trusted.

### Forcing the read failure for 2.10

The plan suggests stopping the local Supabase stack. That does not work: GoTrue goes down with it,
`middleware.ts` cannot resolve `locals.user`, and the request is redirected to `/auth/signin` before
`dashboard.astro` ever runs — the state under test is unreachable.

Instead only PostgREST was stopped (`docker stop supabase_rest_10x-media`). GoTrue talks to Postgres
directly, so the session still resolves and the request reaches the dashboard, while every PostgREST
read fails at the Kong hop. Non-destructive and reversible; the container was restarted immediately
after (`rest:200`) and no data was touched.

**Trap worth recording**: the first reload after stopping PostgREST rendered the *populated* list.
Chrome served `/dashboard` from its HTTP cache. Only a cache-busting query string produced a real
SSR render and the actual failure state. A same-URL reload is not a valid way to observe this
criterion.

## Results

### 2.3 — Newest first, generate form still present and working — **PASS**

Account C returns 7 cards in exactly the database order:

| # | Video | Character | Generated |
|---|---|---|---|
| 0 | `_Ae4osPymXY` | Informational | 2026-08-06 |
| 1 | `9bZkp7q19f0` | Informational | 2026-08-06 |
| 2 | `aircAruvnKk` | Educational | 2026-08-06 |
| 3 | `kJQP7kiw5Fk` | Educational | 2026-08-06 |
| 4 | `kJQP7kiw5Fk` | Educational | 2026-08-04 |
| 5 | `kJQP7kiw5Fk` | Informational | 2026-08-04 |
| 6 | `aircAruvnKk` | Educational | 2026-08-04 |

Note rows 3 and 4 share a rendered "Generated" date — `formatCreatedDate` is date-precision, so the
displayed value cannot itself confirm ordering. The sequence was diffed against `created_at` from
the database, where they are hours apart.

Form: validation fires as before, credit chip stays at its pre-test value, list unchanged.

### 2.4 — Same video under both characters — **PASS**

`kJQP7kiw5Fk` renders as three separate cards (2× Educational, 1× Informational) with distinct
badges and distinct "Generated" dates. This is the flat-list duplication the plan accepts, and the
creation date is what makes rows 3 and 4 — same video, same character — distinguishable at all,
which is the argument the plan makes for keeping that field.

### 2.5 — Null-metadata rows — **PASS**

Account A, three pre-S-08 summaries across two videos:

| Card | Title | Metadata row | Thumbnail | Body |
|---|---|---|---|---|
| `1zKTCcdVcGQ` informational | falls back to `url` | **absent** | derived `hqdefault`, 480×360, loads | 3269 chars, 5 `h2`, 0 `<a>`, 0 `<img>` |
| `dQw4w9WgXcQ` educational | falls back to `url` | **absent** | derived `hqdefault`, loads | preview intact |
| `dQw4w9WgXcQ` informational | falls back to `url` | **absent** | derived `hqdefault`, loads | preview intact |

"Absent" means the whole `channel · duration · date` line is omitted, not rendered as separators
with nothing between them — the `meta.length > 0` guard (`SummaryCard.tsx:85`) holds against real
all-null rows.

**The criterion says "placeholder"; what renders is the derived `hqdefault.jpg`.** That is
`VideoThumbnail` working as specified, not a deviation: a null `thumbnail_url_reported` seeds
`stage: "derived"`, and the `VideoOff` placeholder is only the *third* hop, reached when the derived
URL also fails. Both videos have a valid `hqdefault`, so the placeholder is correctly never reached.
The outcome is better than the row asked for — a real thumbnail instead of an icon.

### 2.6 — `vi_webp` thumbnails — **PASS**

All 7 of account C's thumbnails decode at 1280×720 with zero placeholder elements rendered. The
three `vi_webp/…/maxresdefault.webp` sources load directly; no fallback hop was needed, and no
broken-image icon appeared.

Picked up incidentally on account A (plan Testing Step 4, and the `h:mm:ss` branch of
`formatDuration`): the `?sqp=…&rs=…` signed-param row (`dFY97xFO_mY`) and the `?v=6a60f` row
(`TVA738-ERqg`, 4523 s → rendered `1:15:23`) both load at 1280×720. The signed params have not
expired on these rows, so this pass does **not** prove the expiry path — it only shows the URLs are
passed through unrepaired, as the plan requires.

### 2.7 — Expand and collapse — **PASS**

Clicking the control on a real card: `aria-expanded` goes `false → true → false`, the body block
mounts and unmounts, the collapsed preview reappears on collapse, and `aria-label` flips between
"Expand summary of …" and "Collapse summary of …".

Expanded body renders through `SummaryMarkdown` as real structure — `h2` headings, `strong`, `li` —
with **0 `<a>` and 0 `<img>`** on both a 3807-char and a 3269-char summary. The allow-list holds on
live LLM output.

### 2.8 — Filter narrows and clears — **PASS**

Account C: All → 7 cards, Educational → 4 (all badges Educational), Informational → 3 (all badges
Informational), back to All → 7. `aria-pressed` tracks the active chip.

### 2.9 — Empty state — **PASS**

Account D renders "You haven't generated any summaries yet. / Paste a YouTube URL above to generate
your first one." — not a blank page, and not the "couldn't load" copy. The filter chips are absent:
the empty branch returns before the filter row, so there is no dead control to click.

### 2.10 — Forced read failure is its own state — **PASS**

With PostgREST down (method above), `/dashboard` renders:

```
We couldn't load your summaries just now. Reload the page to try again.
```

Zero cards, and **not** the "generate your first" copy — which is the whole point of the row: an
account with saved summaries is never told it has none. The credit chip degrades independently to
"—" with its own "Your credit balance is unavailable right now" note, confirming the two reads fail
into separate states rather than one collapsing the other. The dev server logged
`dashboard: credit balance read failed` and the list's catch branch left `listUnavailable` set.

## Not covered by this pass

- **Empty-under-filter** — the third non-list state (`SummaryList.tsx:89-101`, "No summaries match
  this filter." plus "Show all summaries") was **not** rendered. It needs an account whose whole
  corpus is one character; every account reachable in this pass has both, so no filter ever emptied
  the list. `verify-s09b@local.test` (1 educational, 0 informational) would produce it, and Phase
  1's GoTrue-admin session-minting method would reach it without a password. Accepted as a known gap
  by decision during this pass — it is prose in the plan's Testing Strategy (step 5), not a Progress
  row, and 2.8's "narrows and clears" clause passed. **This is the only Phase 2 render branch no one
  has seen.**
- **The `VideoOff` placeholder** — the third thumbnail hop never rendered, because no local row has
  a reported URL *and* a failing `hqdefault`. The one-shot `stage` guard against an error loop is
  therefore unexercised against a real double failure.
- **A real generation** — no paid path was touched. 2.3 only asserts the form still validates and
  renders; end-to-end generation is Phase 3 (3.3) and the ambiguous-retry invariant is 3.9.
- **Thumbnail signed-param expiry** — see 2.6; the URLs tested had not expired.
