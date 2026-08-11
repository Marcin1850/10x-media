# Wireframe outcome — step 1 result

**Recorded 2026-08-11** · Input to step 2 (visual direction) and to `/10x-plan` · Brief: [`wireframe-brief.md`](./wireframe-brief.md)

## Source

Claude Design project **`10xMedia app screens`** (`6f4d8fe2-d9bd-48db-ae24-190383dea2c8`), type `PROJECT_TYPE_PROJECT` — a regular project, so the immutable design-system type is still unspent. File: `10xMedia Wireframes.dc.html`. Read via `DesignSync.get_file`; the handoff prompt targeted a `claude_design` MCP endpoint that this session does not have, but `DesignSync` reads the same project by id.

The uploaded context was `wireframe-brief.md` verbatim.

## Chosen direction

Turn 1 produced three shells; turn 2 is titled *"Refinement of 1c"*, so **1c — the paste-first shell — is the accepted direction.**

| Option | Shell | Why it lost / won |
| --- | --- | --- |
| `1a` | Topbar; `/dashboard` **is** the list; generation in a dialog | closest to today's shape (post-S-02) — not chosen |
| `1b` | Sidebar for signed-in, slim topbar signed-out; `/summaries` + `/new` as real routes | two shells; generation gets a shareable route — not chosen |
| **`1c`** | **One topbar everywhere; a paste/capture bar sits under it on every signed-in surface** | **chosen** — "the capture bar *is* the app" |

## The five answers (from card `2f`)

1. **One navigation shell.** The same topbar on every screen, signed-in and signed-out. Left is always the logo plus "Summaries". Only the right side changes with identity: signed-out shows Sign in / Sign up, signed-in shows credits and an avatar menu (Account · Top up · Sign out). Ends the three-different-navigations problem.
2. **Credits** live in the topbar globally, and are repeated at the point of cost when they are actually spent.
3. **Generation is inline** — a bar under the topbar. No dialog, no dedicated route. The long-video 409 gate lands on the pending card, not next to the input.
4. **The list gets its own route, `/summaries`.** "Dashboard" disappears as a concept.
5. **Landing stays a marketing page** — hero, three steps, CTA. No capture bar; it appears only after sign-in.

Additional structural decisions visible in the wireframes but not in `2f`:

- **Account is reached from the avatar menu, not from main navigation** — annotated as deliberate, so it does not compete with Summaries.
- **A pre-authorising checkbox** next to the input ("long videos, 2 credits") lets the user skip the 409 round trip; unchecked, the confirmation arrives inline on the card.
- **`/account`'s "back to dashboard" link disappears** — navigation is the topbar's job.
- **The `?deleted=1` toast** stays on the landing page after account deletion. Matches current behaviour.

## Brief coverage

Exit criteria were an accepted layout for every screen and every state, plus the five answers. Met:

| Card | Covers |
| --- | --- |
| `2a` | Landing, incl. the `?deleted=1` toast |
| `2b` | Sign in · sign up (submitting + server error) · confirm email — one layout |
| `2c` | Account settings, incl. the delete dialog at rest and open |
| `2d` | All four list states, mutually exclusive and explicitly annotated *"this is not the same as an empty list — we never show 'nothing here'"* |
| `2e` | Idle · pending · 409 cost gate · generation error · zero credits · unknown credits |

Greyscale was respected throughout; the sketch fonts (`Architects Daughter`, `Caveat`) are wireframe furniture, not a typography decision.

## Conflicts — all six resolved by the user 2026-08-11

Each heading states the conflict; **Decision** states what was settled and what it costs.

> **One consequence to carry into planning.** Three of the six resolutions (#2's log warning, #4's
> Polish API error copy, #6's extended 409 body) put this slice inside `src/pages/api/`, and #4 and
> #6 both land in `generate.ts` — the paid generation path. **S-06 is no longer presentational.**
> The roadmap's "no behaviour changes to generation, credits or CRUD" scope note is superseded.
> Not a blocker — the widening was already accepted — but it changes review posture: changes to
> `generate.ts` need the same care the S-09 phases got, not a restyle's.

### 1. The generation-error card claims a credit was not charged — sometimes it was

Card `2e` "Błąd generacji" reads *"Kredyt nie został pobrany."* ("No credit was taken.") **This is not reliably true.** A caption-less video **is charged** 1 credit — S-09 D14, the refusal charge, `generate.ts:529`. The roadmap flags this exact trap for S-02: *"a caption-less video charges a credit; the error card reports that, it does not cause it."*

Failure copy must branch on outcome rather than assert a blanket no-charge. Getting this wrong is a wrong statement about the user's money, which is worse than an ugly error state.

**Decision: fix it.** Failure copy branches on the actual outcome; the blanket "no credit was taken" line goes. The card must be able to say *"this one was charged"* for the caption-less case.

### 2. A self-serve top-up is invented, and it does not exist

"Doładuj" / "Top up" appears in three places: the avatar menu, the account page's credit row, and the zero-credit state. **There is no self-serve top-up.** Refills are manual-only, granted by an operator via `npm run grant-credits` (README §Summary credits).

**Decision: the affordance stays**, but activating it shows a plain *"this feature isn't supported yet"* notice and emits a **warning to the logs** that can later be routed to Sentry.

> **Reuse the emitter that already exists — do not invent a second one.** S-09 D12 already built exactly this: one swappable reporting function whose receiver (Sentry or equivalent) lands later. It is `reportBudgetThreshold` in `src/lib/services/supadata-budget.ts` (~L217-232), emitting a named `BUDGET_EVENT` payload through `console.warn` as a placeholder, with its own comment noting that a bare `console.warn` at each call site "may never become an alert" — which is precisely the failure this decision is trying to avoid.
>
> Either extend that function or mirror its event shape, so that when a receiver is wired up both event families arrive through one seam. A second, differently-shaped `console.warn` would have to be found and migrated separately.

### 3. The landing page sells a pricing page and a free tier

Card `2a` has a "Cennik" (Pricing) nav item and the line *"Pierwsze podsumowania gratis · bez karty"* ("First summaries free · no card"). Same root cause as #2: there is no billing, no plans, no card.

**Decision:**
- **"Cennik" and "Jak to działa" are cut** from the landing navigation for now. That empties the left-hand nav on the signed-out landing — the shell must still look deliberate with only the logo there.
- The tagline becomes **"Pierwsze podsumowania gratis"** — the *"· bez karty"* half is dropped, since "no card" implies a card is expected later.

### 4. The copy switched to Polish; the app's UI is English

Turn 1 was English, turn 2 is fully Polish ("Podsumowania", "Strefa niebezpieczna", "Wklej link do filmu…"). The shipped app's interface is **English** — and deliberately so: S-01 Phase 1 was literally "English copy" (`4f48536`). Only the *summaries themselves* are Polish.

This is a product decision the wireframe made implicitly. It is defensible — the audience is Polish — but it is a **full copy rewrite across every surface**, not a restyle.

**Decision: translate everything to Polish for now.** This deliberately reverses S-01 Phase 1 (`4f48536`, "English copy"). Two things the plan must not miss:

- **It is not only UI labels.** User-facing copy also lives in **API error responses**, which are rendered to the user verbatim — 15+ strings across `src/pages/api/summaries/generate.ts` and `src/pages/api/account/delete.ts` ("Something went wrong. Please try again.", "This video's transcript is too long to summarize.", "Too many transcript requests…", and the 409's own "This video is long and costs more credits. Confirm to continue."). Translating the UI and leaving these produces a bilingual failure path — the worst possible place for it.
- **The character labels have exactly one definition and must keep it.** `CHARACTER_LABEL` in `src/components/summaries/SummaryCard.tsx` is exported specifically so the pending card and the saved card cannot drift into labelling the same character differently across a refresh. Translate that map; do not add a second one for the filter chips.

### 5. `/dashboard` → `/summaries` is not presentational

Small but real: `PROTECTED_ROUTES` in `src/middleware.ts:4`, plus four link sites (`Topbar.astro:13`, `Welcome.astro:47`, `account.astro:19`, and the middleware entry). Cheap, but it is a routing change and should be named in the plan rather than discovered.

**Decision: do the rename.** `/dashboard` → `/summaries`, "dashboard" retired as a concept.

### 6. The 409 card needs metadata the endpoint does not return

Cards `1c` and `2e` render the cost gate as a **card with the video's title, channel and duration** ("Kanał · 1:52:07"). The endpoint's 409 body is currently only:

```
{ requiresConfirmation: true, cost, transcriptLength }   // generate.ts:748-752
```

Metadata *is* fetched earlier in the same request (before the 409 returns), so adding it to the body is feasible without reordering the paid path — but it is an **endpoint change**, and S-06's scope note promises no behaviour changes to generation. The pending card raises the same question: it shows channel and duration while the summary is still in flight.

**Decision: extend the 409 body** with the video's title, channel and duration so the gate can render as designed.

Constraint for the plan: `generate.ts:552-556` documents the metadata call's *placement* as load-bearing for three separate reasons (1 req/s rate spacing, early exits not burning a credit, no double-pay on an `allowLong` resubmit), and explicitly warns that relocating it is not a free tidy-up. **Add fields to the response; do not move the call.** The pending card's metadata is the same question and should be answered the same way.

### Minor

- **"Wyślij ponownie"** (resend confirmation email) on card `2b` — no such feature exists; `grep -rn "resend" src/` returns nothing. Not raised with the user; treat it as cut unless it is deliberately added, in which case it is a new capability rather than a restyle.
- Credits are drawn as **12**; new accounts start with **5**. Cosmetic.

## What step 2 inherits

Settled: the shell, the routes, where credits live, generation placement, and the full state inventory. Step 2 decides color, typography, spacing, radius and elevation on top of this structure — see the constraints listed when step 2 was briefed (Polish diacritics in the reading font, long-prose readability, a palette that survives arbitrary YouTube thumbnails next to it, and the two character badges being distinguishable without relying on hue).
