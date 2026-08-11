# App Design System — Step 4 Plan Brief

> Full plan: `context/changes/app-design-system/plan.md`
> Structure (step 1): `context/changes/app-design-system/wireframe-outcome.md`
> Visual direction (step 2): `context/changes/app-design-system/visual-direction-outcome.md`
> Design system (step 3): `context/changes/app-design-system/ds-bundle/`

## What & Why

Steps 1–3 produced a wireframe, a visual direction with verified contrast, and a published design
system — none of which is in the repo. This plan is **step 4: the descent into code**. It ports the
tokens of direction `3b` "Konsola" — step 2's name for the chosen direction, console as in a control
console: a flat, low-chroma ground so YouTube thumbnails glow and the background does not compete with
them. It builds the one-topbar shell and the `/summaries` route the wireframe settled, and sweeps every
hardcoded colour utility out of 13 feature components and 5 Astro files, with UI copy moving to Polish
through a single-locale copy module.

## Starting Point

`src/styles/global.css` is 100% stock shadcn — every colour `oklch(… 0 0)`, pure greyscale, zero brand —
and **no application code reads it**. The tokens are referenced by `button.tsx`, `dialog.tsx` and the
stylesheet itself, nothing else. Every page and feature component hardcodes utilities instead, so two
disconnected visual systems coexist: neutral shadcn components sitting inside a purple/blue glassmorphic
app. There is no shared navigation (three surfaces, three ad-hoc navigations), `bg-cosmic` is a literal
hex gradient outside any token system, and nothing sets `.dark` — the app only *looks* dark because
pages hardcode `text-white`. There is no test suite.

## Desired End State

Every surface renders from the 3b tokens, in Polish, under one topbar, with `/summaries` as the list
route and generation as an inline capture bar instead of a dialog. `npm run lint:tokens` passes, proving
mechanically that no hardcoded palette utility survives outside `global.css`. Amber appears if and only
if the app is waiting for a decision about spending credits.

## Key Decisions Made

| Decision | Choice | Why | Source |
| --- | --- | --- | --- |
| Shell & routes | One topbar everywhere; `/summaries`; inline generation | Ends the three-navigations problem | Wireframe |
| Palette & type | 3b "Konsola", dark-only via `class="dark"` | Light is complete but unverified | Visual direction |
| `--attention` split from `--accent` | Separate token pair | Otherwise every ghost-button hover fires the spend-money colour | Visual direction |
| **409 cost gate** | **Design for cold — no endpoint change** | **Metadata isn't available at gate time (see risks); the gate is cold in the normal case** | **Plan** |
| Fonts | Astro 6 Fonts API, google provider, `latin` + `latin-ext` | Stable in v6, self-hosts at build, no binaries in git | Plan |
| Primitives | `input checkbox dropdown-menu badge label` only | Covers the five screens; hand-rolling a dropdown would regress a11y | Plan |
| Copy boundary | UI fully Polish; `src/pages/api/**` stays English | Server translation deferred to a follow-up change | Plan |
| Copy structure | Single-locale module `src/lib/copy/` | A second language becomes a new file, not another 18-file sweep | Plan |
| Reporting seam | Extract `reporting.ts`; refactor `reportBudgetThreshold` onto it | One seam, so wiring Sentry later reaches both event families | Plan |
| Sweep proof | `npm run lint:tokens` grep guard in CI | With no test suite, the only mechanical proof the sweep is complete | Plan |
| Capture bar placement | `/summaries` only | A generation must never start where its pending card can't be seen | Plan |
| Hex vs `oklch` | Keep hex | All 16 contrast ratios were computed on those exact values | Plan |

## Scope

**In scope:** tokens + `@theme inline`; Astro font pipeline; `class="dark"` + `lang="pl"`; copy module;
reporting seam; five shadcn primitives; global topbar + avatar menu; credits on `locals`;
`/dashboard` → `/summaries`; all 13 feature components and 5 Astro files; dialog → capture bar; cold cost
gate; `autocomplete` a11y fix; `charged` signal on the two 422 sites; token guard + CI.

**Out of scope:** extending the 409 body; translating API responses; shipping or fixing the light theme;
a theme toggle; an i18n library or locale routing; converting the palette to `oklch`; "Wyślij ponownie";
self-serve top-up; speculative primitives.

## Architecture / Approach

Dependency-forced, nine phases: tokens and fonts must exist before anything consumes them; the copy
module, reporting seam and primitives before any surface is rewritten; the shell before surfaces can drop
their ad-hoc navigation. Surfaces then land one at a time. The one paid-path change is isolated into the
final phase so it gets S-09-grade review rather than being buried in a restyle diff.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Token & type foundation | 3b palette, fonts, dark + `lang="pl"` | Fonts not actually self-hosted, or `latin-ext` missing → broken diacritics |
| 2. Shared infrastructure | Copy module, reporting seam, primitives | Refactors budget code live in production |
| 3. App shell | Topbar everywhere, credits on `locals`, route rename | A missed link site; balance failure rendering `0` instead of "unknown" |
| 4. Auth surfaces | 3 pages + 6 components in Polish | `autocomplete` breaking when the show/hide toggle swaps `type` |
| 5. Summaries — list & cards | Four list states, cards, badges, reading surface | Collapsing two list states into each other |
| 6. Summaries — capture bar | Dialog dissolved, in-flight states, cold cost gate | Weakening the generation lifecycle the dialog was designed around |
| 7. Account surface | Account page + delete dialog | Breaking the dialog's locked-shut-while-deleting guard |
| 8. Landing surface | Hero, three steps, toast, orbs deleted | Empty left nav looking broken rather than deliberate |
| 9. Failure copy + guard | `charged` signal, token guard in CI | Touching the paid path |

**Prerequisites:** steps 1–3 closed (they are); local Supabase running; a synthetic local account for the
delete-flow test; Supadata + OpenRouter credit for the generation-path tests.
**Estimated effort:** ~5–7 sessions across 9 phases. Phases 5 and 6 are the largest.

## Open Risks & Assumptions

- **The design system contains one false claim, now corrected.** `wireframe-outcome.md` §6 and
  `ds-bundle/cost-gate.html` both say metadata is fetched before the 409. It is not — `generate.ts:493`
  is the cache *lookup*; the real fetch is at `generate.ts:859`, after the debit and the LLM call. Since
  `saveCachedMetadata` only runs on a completed generation, a user who cancels never warms the cache, so
  **the gate is cold unless someone fully generated that video within 30 days**. Decision #6 is reversed.
  Both source documents — and `change.md` — now carry the correction annotated in place, so the original
  reasoning stays readable next to what actually happens. `ds-bundle/cost-gate.html` is consequently
  ahead of the copy pushed to Claude Design and needs re-pushing in step 5.
- **The bilingual failure path is accepted, not solved.** UI is Polish, API responses stay English, and
  `messageForStatus` deliberately prefers the server's string — so generation errors will usually read
  English inside a Polish interface. Deliberate; needs a follow-up change.
- **Phase 6 dissolves the dialog `useGenerateSummary` was architected around.** Inline is strictly safer
  (no unmount mid-flight), but every lifetime guarantee must survive the move intact.
- **The light theme has never been rendered**, and carries one known AA failure. Not reachable while
  `class="dark"` is fixed, but it becomes live the moment a toggle exists.
- **No test suite.** Verification is lint, build, the token guard, and an 11-step manual matrix.

## Success Criteria (Summary)

- Every screen and state renders from the tokens, in Polish, under one topbar — and `npm run lint:tokens`
  proves no hardcoded palette utility survived
- Amber appears on the cost gate and nowhere else; ghost and outline hovers are neutral
- A failed generation states the charge outcome truthfully — including saying nothing when it can't know
