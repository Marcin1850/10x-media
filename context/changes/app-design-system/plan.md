# App Design System — Step 4 Implementation Plan

## Overview

Steps 1–3 of `app-design-system` produced a wireframe (`wireframe-outcome.md`), a visual direction with
verified contrast (`visual-direction-outcome.md`) and a published design system (`ds-bundle/`). None of
it is in the repo. This plan is **step 4: the descent into code** — port the tokens of direction
**`3b` "Konsola"**, build the one-topbar shell and the `/summaries` route the wireframe settled, and
sweep every hardcoded colour utility out of 13 feature components and 5 Astro files, with UI copy moving
to Polish through a single-locale copy module.

> *"Konsola"* is the proper name step 2 gave the chosen direction — Claude Design named all three in
> Polish (`3a` "Redakcja", `3b` "Konsola", `3c` "Studio"). Console as in a control console: a flat,
> low-chroma ground so YouTube thumbnails glow and the background does not compete with them. The name
> is kept because it is the identifier used in `ds-bundle/tokens.css:1` and
> `visual-direction-outcome.md`; below it is written `3b` where only the reference matters.

This is not a restyle. Three of the six conflicts resolved in step 1 put the slice inside
`src/pages/api/`, it changes a route, it dissolves the generation dialog, and it introduces a font
pipeline. The roadmap's S-06 scope note ("presentational only", "no behaviour changes to generation,
credits or CRUD") is **superseded** — see `change.md` §"What step 4 actually is".

## Current State Analysis

**There is no design system to migrate.** `src/styles/global.css` (124 lines) is 100% stock shadcn:
every colour is `oklch(… 0 0)`, pure greyscale, zero brand. `src/components/ui/` holds three files —
`button.tsx`, `dialog.tsx`, and `LibBadge.astro`, which is **imported by nothing** (verified: no
matches outside its own file).

**The tokenized system is dead code.** The shadcn tokens are referenced by exactly three files:
`button.tsx`, `dialog.tsx`, and `global.css` itself. **No application code uses them.** Every page and
feature component hardcodes utilities instead — `bg-white/10`, `border-white/10`, `text-blue-100/80`,
`text-purple-300`, `backdrop-blur-xl`, and gradient headings via
`from-blue-200 to-purple-200 bg-clip-text text-transparent`. Consequence: the two shadcn components
render from a neutral greyscale palette while sitting on a purple/blue glassmorphic surface. Token work
that stops at `global.css` changes almost nothing on screen.

**`bg-cosmic` is outside any token system** — an `@utility` in `global.css:113-115` with literal hex
stops, setting the page ground on `/dashboard` and `/account`.

**There is no shared navigation.** `Topbar.astro` is imported by `Welcome.astro` only, i.e. the landing
page. `/dashboard` invents account links inside its header card; `/account` has a lone
"← Back to dashboard". Three surfaces, three ad-hoc navigations.

**Nothing sets `.dark` today.** The app only *looks* dark because pages hardcode `bg-cosmic` and
`text-white`. Tokenizing those away would flip the app to light — which is why decision B
(`class="dark"` on `<html>`) is a correctness requirement, not a preference.

**No test suite exists.** Verification is lint, build, and browsing every screen and state.

## Desired End State

Every surface renders from the 3b tokens under one topbar, with **all client-owned UI copy in Polish**,
`/summaries` as the list route and generation as an inline capture bar. Server-owned strings from
`src/pages/api/**` stay English and still surface inside those screens — a deliberate, documented
boundary, not an oversight; see §Migration Notes for the follow-up that closes it. `npm run lint:tokens` passes, proving no hardcoded
palette utility survives outside `global.css`. The cost gate, the pending card, the four list states and
the seven semantic slots all render as the design system specifies them — the cost gate in its cold
form, which is the form it will almost always take.

Verified by: `npm run lint`, `npm run build`, `npm run lint:tokens`, and a manual pass over all eleven
screens/states listed in §Testing Strategy.

### Key Discoveries

- **The design system's central claim about the 409 is false.** Both `wireframe-outcome.md` §6 and
  `ds-bundle/cost-gate.html` state "Metadata is fetched earlier in the same request". It is not.
  `generate.ts:493` is the metadata **cache lookup**; the real `fetchVideoMetadata` call is at
  `generate.ts:859` — **114 lines after the 409 returns at `generate.ts:745`**, and after both the
  credit debit and the paid LLM call. Worse, `saveCachedMetadata` only runs on a **completed**
  generation (`metadata-cache.ts:15-17`, no negative caching), so a user who hits the gate and cancels
  never warms the cache. **The gate is cold unless somebody fully generated that video within 30 days.**
  Decision #6 is therefore reversed — see §What We're NOT Doing.
- **`--attention` needs an `@theme inline` entry**, not just a `:root` declaration. `global.css:75-111`
  is what emits utilities; without `--color-attention` Tailwind produces no `bg-attention`.
- **The thumbnail is free.** `VideoThumbnail.tsx:17` derives `https://i.ytimg.com/vi/<id>/hqdefault.jpg`
  from the video id with no API call — so the cold cost gate still has an image.
- **Only one family of failure paths takes a credit** — but *attempting* to charge is not the same as
  charging. Verified across every exit: the chargeable 422s route through `refuseAndCharge`; the
  transient 422 (`generate.ts:659`) does not; 413 and 402 precede the debit; 502 and both 500s refund
  (`generate.ts:943`). Within the chargeable family the charge can still not land —
  `chargeFailedTranscript` resolves `charged` / `replay` / `insufficient` / `notCharged`
  (`credits.ts:204-208`) and never throws — so `charged` must be **read from that outcome**, not
  inferred from the exit taken.
- **Astro 6 made the Fonts API stable** — the `experimental.fonts` flag was removed in v6. `subsets:
  ["latin", "latin-ext"]` is what carries the Polish diacritics the whole type decision rests on.
- **`CHARACTER_LABEL` (`SummaryCard.tsx:18`) is exported deliberately** so the pending card and the
  saved card cannot drift. Translate that map; do not add a second one for the filter chips.
- **`LibBadge.astro` is dead code** — a starter leftover with hardcoded blue/purple, imported nowhere.

## What We're NOT Doing

- **Not extending the 409 body** with title/channel/duration. Decision #6 is reversed: the data is not
  available at gate time in the normal case, and obtaining it means moving the metadata call, which
  `generate.ts:812-820` documents as load-bearing for three separate reasons.
- **Not translating API response strings.** `src/pages/api/**` stays English. This is a deliberate
  deferral to a follow-up change — see §Migration Notes for the gap it leaves.
- **Not shipping the light theme.** `:root` keeps the complete light palette; `class="dark"` means it is
  never exposed. The known light-theme AA failure (`--attention` on its own 12% tint, 4.25:1) is carried
  forward as a comment, not fixed here.
- **Not building a theme toggle.** Decision D in `visual-direction-outcome.md`: SSR on Workers needs a
  cookie read in middleware to avoid a flash. Its own slice.
- **Not adopting an i18n library or locale routing.** One locale, one copy module, no runtime switching.
- **Not converting the palette to `oklch`.** See §Critical Implementation Details.
- **Not adding the "resend confirmation email" action** wireframe card `2b` shows — no such feature
  exists; it would be a new capability, not a restyle.
- **Not building a self-serve top-up.** The affordance renders a not-supported notice (decision #2).
- **Not adding speculative shadcn primitives** beyond what the five screens use.

## Implementation Approach

Dependency-forced order, in nine phases: tokens and fonts must exist before anything can consume them;
the copy module, the reporting seam and the primitives must exist before any surface is rewritten; the
shell must exist before surfaces can drop their ad-hoc navigation. Surfaces then land one at a time,
each independently demoable. The single paid-path change is isolated into the final phase so it is
reviewed with S-09 care rather than buried in a restyle diff.

The summaries surface is split in two because it is by far the largest: phase 5 rebuilds the saved side
(list, cards, four states), phase 6 dissolves the dialog and builds the capture bar plus the in-flight
states. **At the end of phase 5 the app deliberately has a fully styled list next to an unstyled legacy
dialog.** That is an honest intermediate, not an oversight.

## Critical Implementation Details

**Hex is kept, not converted to `oklch`.** `visual-direction-outcome.md` left this open. Every one of
the 16 contrast ratios in that document — including the recomputed turn-4 set and the composited 12%
tint — was calculated on those exact hex values. Converting introduces a class of drift that nothing in
this repo can verify, in exchange for interpolation quality the app does not use. Copy the hex.

**Font variables do not come from `ds-bundle/tokens.css`.** That file declares `--font-sans` /
`--font-display` / `--font-mono` as literal family stacks. In the repo those names must instead resolve
to the variables Astro's Fonts API generates, mapped in `@theme inline`. Copying tokens.css's three font
declarations verbatim would produce a page that names the fonts without loading them.

**Dissolving the dialog must not weaken the generation lifecycle.** `DashboardSummaries.tsx:29-41`
explains that `useGenerateSummary` lives in the parent precisely because `ui/dialog` unmounts its
content on close, so a form owning its own request could not finish a paid generation the user walked
away from. Inline rendering removes that hazard entirely — but the hook, the three quote-relevant
inputs, `refreshSeq`, and the `attemptId`-bound clearing must all stay exactly where they are. The
change is where the form *renders*, not who owns the state.

**`messageForStatus` keeps preferring the server's string.** `useGenerateSummary.ts:97-120` documents
why for 429, 422 and 503: three distinct causes answer each status, and collapsing them misreports a
permanent failure as a retryable one. With server copy staying English and the fallbacks becoming
Polish, the server's string usually wins — so the generation error surface will read English in
practice. That is the accepted consequence of the copy boundary, not a bug to work around by inverting
the preference.

**`--attention` is gate-only, and "warning" is not a colour.** `ds-bundle/tokens.css:6-9` and
`visual-direction-outcome.md` define amber as one thing: *waiting for your decision about spending
credits*. Every other cautionary state in this app — the config banner's `warning`, the list's refresh
note, `saved-refresh-failed` — is information, not a request for money, and takes the **neutral warning
treatment** instead: `--card` ground, 1px solid `--border`, `--foreground` text, with an icon and the
copy carrying the severity. That is the same three-channel discipline the character badges use, and it
is what makes phase 6's "amber appears nowhere else" criterion passable rather than self-contradictory.
The neutral treatment needs its own contrast check on the dark ground before phase 3 closes.

**`getBalance` must not be allowed to fail the page.** `dashboard.astro:29-34` catches and renders `—`
because the display balance is never the enforcement gate (that lives in the endpoint, where
`getBalance` must keep throwing). Moving the read into middleware must preserve the catch, mapping
failure to `null` — which is exactly the design system's "Unknown" slot: shimmer, never a number, never
`--destructive`.

## Phase 1: Token and type foundation

### Overview

The 3b palette, the two type faces, and the theme/language switch land in the repo. Nothing else
changes yet, so the app renders its existing hardcoded UI on the new ground — deliberately half-done and
visibly so.

### Changes Required:

#### 1. Font pipeline

**File**: `astro.config.mjs`

**Intent**: Register both families through Astro 6's stable Fonts API so they are downloaded at build
and self-hosted from the output, satisfying the no-CDN-at-runtime constraint on Workers.

**Contract**: Add a top-level `fonts: [...]` array using `fontProviders.google()` (imported from
`astro/config` alongside `defineConfig`). Two entries: `Space Grotesk` with
`cssVariable: "--font-space-grotesk"` and weights `[400, 500, 600, 700]`; `IBM Plex Sans` with
`cssVariable: "--font-ibm-plex-sans"` and weights `[400, 500, 600]`. Both take
`subsets: ["latin", "latin-ext"]` — `latin-ext` is what carries `ąćęłńóśźż` — plus
`styles: ["normal"]` and `fallbacks: ["ui-sans-serif", "system-ui", "sans-serif"]`. Weights are taken
from the scale in `ds-bundle/type.html`; do not add weights the scale does not use.

**`styles` is not optional housekeeping.** Astro defaults to `["normal", "italic"]`
(`assets/fonts/config.js:22`), so omitting it silently doubles the generated face count to 14 across the
two families — italics this type scale never uses.

#### 2. Token block

**File**: `src/styles/global.css`

**Intent**: Replace the stock greyscale palette with the final 3b tokens and make `--attention`
reachable from Tailwind.

**Contract**: Replace the `:root` and `.dark` bodies with the block in `ds-bundle/tokens.css` (hex, as
written), including the `--attention` / `--attention-foreground` pair and its "outside the shadcn
contract" comment. `--radius` becomes `0.25rem`. Translate tokens.css's `.attention-text-on-tint` class
into a token `--attention-text` in both scopes — `#EBC489` in `.dark`, and in `:root` the value of
`--attention` carrying tokens.css's AA-failure comment verbatim, since light is unshipped. Do **not**
copy tokens.css's three `--font-*` declarations. In `@theme inline`, add `--color-attention`,
`--color-attention-foreground`, `--color-attention-text`, and map `--font-sans` /`--font-display` to
Astro's generated `--font-ibm-plex-sans` / `--font-space-grotesk`. Delete the `@utility bg-cosmic`
block. Set `body` to `font-sans` alongside its existing `bg-background text-foreground`.

#### 3. Layout shell

**File**: `src/layouts/Layout.astro`

**Intent**: Turn the dark theme on, declare the document's language, and preload the two faces.

**Contract**: `<html lang="en">` → `<html lang="pl" class="dark">`. Import `Font` from `astro:assets`
and render both families in `<head>` — **with filtered preloads, not a blanket `preload`**:

```astro
<Font cssVariable="--font-space-grotesk" preload={[{ weight: 600, subset: "latin" }, { weight: 600, subset: "latin-ext" }]} />
<Font cssVariable="--font-ibm-plex-sans"  preload={[{ weight: 400, subset: "latin" }, { weight: 400, subset: "latin-ext" }]} />
```

`preload` accepts a filter array of `{ weight?, style?, subset? }`
(`assets/fonts/core/filter-preloads.js:8-21`); bare `preload` means `true`, which emits a `<link
rel="preload">` for **every** face returned — seven weights across two subsets, i.e. up to 14 even with
italics excluded. The four above are the only faces above the fold: the display face at 600 for the
topbar logo and page heading, the body face at 400 for prose. Every other weight still loads normally,
just not eagerly. **`latin-ext` is preloaded alongside `latin` on purpose** — the body copy is Polish, so
the diacritic subset is critical, not a long tail. Remaining weights are deliberately unpreloaded; if a
render shows a visible swap on one of them, add that specific face to the filter rather than reverting
to `true`.

#### 4. Retire the deleted utility

**Files**: `src/pages/dashboard.astro`, `src/pages/account.astro`

**Intent**: Remove the two `bg-cosmic` usages so no class references a utility that no longer exists.

**Contract**: Drop the `bg-cosmic` class from both wrappers. The body's `bg-background` already supplies
the flat ground; no replacement class is needed.

### Success Criteria:

#### Automated Verification:

- Build succeeds and emits both font families: `npm run build`
- Linting passes: `npm run lint`
- No `bg-cosmic` reference remains: `git grep -n "bg-cosmic" -- src` returns nothing

#### Manual Verification:

- Both faces load from the app's own origin — no request to `fonts.googleapis.com` or
  `fonts.gstatic.com` in the network panel
- `<head>` carries **exactly four** `<link rel="preload" as="font">` tags, not one per generated face
  (count them in the rendered source; a blanket `preload` shows up here as a dozen or more)
- Polish diacritics render in the loaded faces, not a fallback: `ąćęłńóśźż ĄĆĘŁŃÓŚŹŻ`
- Every page sits on the flat `#101013` ground; the gradient is gone
- A probe element with `class="bg-attention"` produces amber, proving the `@theme inline` entry works

**Implementation Note**: Pause for manual confirmation before Phase 2. The font check is the one that
cannot be automated and the one most likely to be wrong.

---

## Phase 2: Shared infrastructure

### Overview

Three things every surface phase depends on: the copy module, the reporting seam, and the primitive
components. Nothing visible changes.

### Changes Required:

#### 1. Single-locale copy module

**File**: `src/lib/copy/pl.ts`, `src/lib/copy/index.ts`

**Intent**: Give UI strings one home so adding a second language later is a new file plus a resolver,
not another 18-file sweep — and so this slice's new Polish copy is reviewable in one place.

**Contract**: `pl.ts` exports a `const pl` object with per-surface namespaces: `common`, `nav`, `auth`,
`summaries`, `generate`, `account`, `landing`, `errors`. `index.ts` re-exports it as `copy` and exports
`export type Copy = typeof pl;` so a future locale file must satisfy the same shape. Phase 2 creates the
structure and the `common` / `nav` entries only; each surface phase adds its own namespace. No runtime
locale selection, no detection, no dependency.

**Documentation convention — this plan names copy by key, never by literal.** Below, UI strings are
referred to as `copy.<namespace>.<key>`, described in English, with the Polish wording living in `pl.ts`
and nowhere else. Two reasons: the whole point of the module is that a second locale is a new file rather
than a sweep, and a plan that hardcodes `pl` strings into its prose becomes wrong the moment `en.ts`
exists — while also making the document unreadable to anyone who does not read Polish. Where the exact
wording *is* the decision (the landing tagline, the charge line), state the decision in English and name
the key that carries it.

#### 2. Reporting seam

**File**: `src/lib/services/reporting.ts`, `src/lib/services/supadata-budget.ts`

**Intent**: Extract the single swappable notification point so the top-up notice and budget events
arrive through one seam, as decision #2 requires — rather than a second `console.warn` that would have
to be found and migrated separately when a receiver lands.

**Contract**: New module owning the emitter: a `reportEvent(key, severity, payload)` shaped exactly like
today's, plus a `reportUnsupportedFeature(feature: string)` helper. Preserve the existing severity rule
verbatim — `warn` goes to `console.warn`, everything else to `console.error`. `supadata-budget.ts`'s
`reportBudgetThreshold` (~L217-232) is refactored to delegate, keeping its `BUDGET_EVENT` key byte-for-byte:
the comment marks it `DO NOT REWORD` because it is a search key counted in Workers logs.

#### 3. Primitive components

**Files**: `src/components/ui/` (generated), `src/components/ui/LibBadge.astro` (deleted)

**Intent**: Add the controls the five screens need, via the CLI rather than by hand, and drop the dead
starter component.

**Contract**: `npx shadcn@latest add input checkbox dropdown-menu badge label`. Delete `LibBadge.astro` —
verified imported by nothing. Do not add primitives no screen uses.

### Success Criteria:

#### Automated Verification:

- Type checking and linting pass: `npm run lint`
- Build succeeds: `npm run build`
- `BUDGET_EVENT` string is unchanged: `git grep -n "\[supadata-budget\]" -- src/lib/services`
- `LibBadge` is gone and referenced nowhere: `git grep -n "LibBadge" -- src` returns nothing

#### Manual Verification:

- Generating a summary still logs a budget event in the same shape as before the refactor (compare
  against a `wrangler tail` line or a local `console` capture from a pre-refactor run)

**Implementation Note**: The budget refactor touches code live in production. Verify the emitted line is
byte-identical before moving on.

---

## Phase 3: App shell

### Overview

One topbar on every screen, credits resolved once per request, and `/dashboard` retired as a concept.
This is the phase that ends the three-different-navigations problem.

### Changes Required:

#### 1. Credits on `locals`

**Files**: `src/middleware.ts`, `src/env.d.ts`

**Intent**: The topbar shows credits globally, so the balance must be available to every page — read
once per request rather than per component.

**Contract**: `App.Locals` gains `credits: number | null`. Middleware resolves it after the user, only
when a user exists **and** the path is not under `/api/` — API routes must not pay for a display-only
read. The `getBalance` call is wrapped in try/catch mapping failure to `null`, preserving
`dashboard.astro:29-34`'s reasoning: this balance is never the enforcement gate. `PROTECTED_ROUTES`
becomes `["/summaries", "/account"]`.

#### 2. Topbar and account menu

**Files**: `src/components/Topbar.astro`, `src/components/AccountMenu.tsx` (new),
`src/layouts/Layout.astro`

**Intent**: Build the single navigation shell from wireframe answer #1 and render it from the layout so
every surface inherits it.

**Contract**: `Topbar.astro` rewritten from tokens. The left side carries the logo always, plus the
summaries link (`copy.nav.summaries`) **on every route except `/`** — read from `Astro.url.pathname`, since once the topbar
renders from the layout the landing page can no longer control its own navigation (phase 8 requires the
landing shell to be logo-only, and that holds **signed in as well as signed out**: the signed-in landing
CTA is the route into the app, so the link would be a second, competing one). "The same topbar" in the
criteria below means one shared component and one shell — not an identical link set on every route. The
right side branches on `Astro.locals.user` — signed-out shows sign in / sign up, signed-in shows the
credit figure and the `AccountMenu` island. `AccountMenu.tsx` is a React island wrapping the shadcn
`dropdown-menu` with three items — account, top-up and sign-out (`copy.nav.account`, `copy.nav.topUp`,
`copy.nav.signOut`); sign-out keeps posting to `/api/auth/signout`. Account is reached **only** from this menu, never from main navigation (annotated
as deliberate in the wireframe so it does not compete with Summaries). The credit display renders the
"Unknown" slot — `--muted` with shimmer, never a number — when `locals.credits` is `null`. `Layout.astro`
renders `<Topbar />` above `<slot />`; `Welcome.astro` drops its own import.

#### 3. Top-up notice

**Files**: `src/components/account/TopUpAction.tsx` (new), `src/components/AccountMenu.tsx`

**Intent**: Keep the affordance decision #2 preserved while telling the truth about it — and define the
behaviour **once**, because phase 7 needs the identical interaction on the account page's credit row.

**Contract**: `TopUpAction.tsx` is the single owner of the top-up affordance: a small React component
taking a `variant` (`"menu-item"` | `"row-button"`) for its trigger presentation only. Clicking reveals a
plain not-supported notice — no pricing, no plans, no card — rendered into a container with
`role="status"` and `aria-live="polite"` so it is announced without stealing focus, and dismissable. The
click calls `reportUnsupportedFeature("top-up")` from the phase 2 seam: **one** stable event key
(`"top-up"`, the same literal from both surfaces), severity `warn`, and no user identifiers in the
payload. `AccountMenu.tsx` renders it as the top-up menu item (`copy.nav.topUp`); phase 7 hydrates the
same component on `account.astro`. Emitting once per click, not once per render.

#### 4. Route rename

**Files**: `src/pages/dashboard.astro` → `src/pages/summaries.astro`, `src/components/Welcome.astro`,
`src/pages/account.astro`

**Intent**: `/dashboard` → `/summaries`, per decision #5 — a routing change, named here rather than
discovered later.

**Contract**: Rename the page file. Update the two remaining link sites (`Welcome.astro:47`,
`account.astro:19`); `Topbar.astro`'s link is already handled above, and `account.astro`'s
"← Back to dashboard" is **deleted** rather than repointed — navigation is the topbar's job now. The
`console.error` prefixes inside the page ("dashboard: …") are renamed to match.

#### 5. Config banner

**File**: `src/components/Banner.astro`

**Intent**: The banner renders above every page from the layout, so its hardcoded light-theme hex would
sit jarringly on the dark ground.

**Contract**: Replace the scoped `<style>` block's literal hex with token references. `error` maps to the
recoverable-error slot (`--destructive` border and text over a 10% fill); `warning` maps to the **neutral
warning treatment** — `--card` ground, 1px solid `--border`, `--foreground` text, with a warning icon and
the copy itself carrying the severity; `info` to `--muted`. `warning` must **not** use `--attention` —
see §Critical Implementation Details.

### Success Criteria:

#### Automated Verification:

- Linting and build pass: `npm run lint && npm run build`
- No `/dashboard` reference survives: `git grep -n "/dashboard" -- src` returns nothing
- `PROTECTED_ROUTES` contains `/summaries`: `git grep -n -A 1 "PROTECTED_ROUTES" -- src/middleware.ts`

#### Manual Verification:

- The same topbar component and shell render on `/`, `/auth/signin`, `/summaries` and `/account`;
  the summaries link appears on all of them **except `/`**, signed in and signed out alike
- Signed out, the right side shows sign in / sign up; signed in, it shows credits plus the avatar menu
- The avatar menu opens on click, closes on Escape, and is arrow-key navigable
- The top-up menu item shows the not-supported notice and emits one warning to the console
- Visiting `/dashboard` 404s; `/summaries` loads and still redirects to sign-in when signed out
- With Supabase reachable but the balance row missing, the topbar shimmers rather than showing `0`
- The banner's `warning` variant renders the neutral treatment, not amber, and its text passes AA on the
  dark ground — this is the contrast check the neutral treatment has not yet had

**Implementation Note**: The last bullet is the "Unknown" slot and is easy to get wrong. Confirm it
before Phase 4.

---

## Phase 4: Auth surfaces

### Overview

Three pages, six components. The smallest surface, done first so the token vocabulary and the copy
module are exercised on something low-risk before the summaries surface.

### Changes Required:

#### 1. Auth pages

**Files**: `src/pages/auth/signin.astro`, `src/pages/auth/signup.astro`,
`src/pages/auth/confirm-email.astro`

**Intent**: Rebuild the three auth screens on the one shared layout from wireframe card `2b`, in Polish.

**Contract**: Each page drops its `bg-cosmic` wrapper, glassmorphic card and gradient-clip heading in
favour of the at-rest slot (`--card` / `--card-foreground`, 1px solid `--border`) with a `--font-display`
heading. Copy comes from `copy.auth`. The `confirm-email` page keeps its `import.meta.env.DEV` branch —
both variants get Polish copy.

#### 2. Form components

**Files**: `src/components/auth/{FormField,PasswordToggle,ServerError,SubmitButton,SignInForm,SignUpForm}.tsx`

**Intent**: Tokenize the form primitives and move validation copy into the copy module.

**Contract**: `FormField` renders the shadcn `input` and `label` instead of its hand-rolled
`inputBase` string; error state binds to `--destructive`, focus ring to `--ring`. `ServerError` renders
the recoverable-error slot — `--destructive` as 2px border and text over a 10% fill. `SubmitButton` uses
the `Button` default variant with no hardcoded overrides. All validation strings move to `copy.auth`;
`SignUpForm`'s pluralised character-count hint must handle Polish plural forms (1 / 2-4 / 5+), which the
English string's `s`-suffix does not cover.

#### 3. Password autocomplete

**Files**: `src/components/auth/{FormField,SignInForm,SignUpForm}.tsx`

**Intent**: Close the one non-visual task S-06's scope notes already carried — missing `autocomplete`
attributes block the browser's password generator.

**Contract**: `FormField` gains an optional `autocomplete` prop forwarded to the input. Sign-in uses
`email` / `current-password`; sign-up uses `email` / `new-password` on both password fields.
**The gotcha**: `PasswordToggle` swaps `type` from `password` to `text`, and a `text` input is not a
password field to the generator — verify the attribute survives and still works in both states.

### Success Criteria:

#### Automated Verification:

- Linting and build pass: `npm run lint && npm run build`
- No palette utility remains in the auth tree:
  `git grep -nE "(bg|text|border)-(white|blue|purple|red)-?" -- src/components/auth src/pages/auth`
  returns nothing

#### Manual Verification:

- Sign in, sign up and confirm-email render in Polish on the at-rest slot with correct type faces
- Client validation errors render in the recoverable-error slot in Polish, with correct plural forms
- The browser offers to generate a password on sign-up, **with the password visible and hidden**
- A server error (submit wrong credentials) renders in the error slot — in English, as expected
- Submitting shows the pending state; the form is not double-submittable

**Implementation Note**: The English server error next to Polish labels is the accepted copy gap, not a
defect. Confirm it looks deliberate rather than broken before Phase 5.

---

## Phase 5: Summaries — list and saved cards

### Overview

The saved side of the summaries surface: the page, the four list states, the summary card, the filter
chips, the character badges and the summary reading surface. The legacy generation dialog is left
untouched and unstyled — an honest intermediate.

### Changes Required:

#### 1. Page shell

**File**: `src/pages/summaries.astro`

**Intent**: Rebuild the page around the shared topbar, reading credits from `locals` instead of fetching
them itself.

**Contract**: Delete the header card entirely — it duplicated navigation the topbar now owns. Drop the
local `getBalance` call in favour of `Astro.locals.credits`, keeping the summary-list read and its
`listUnavailable` semantics exactly as they are: an empty list must mean "you have no summaries", never
"we couldn't ask". Page copy comes from `copy.summaries`.

#### 2. List and its states

**File**: `src/components/summaries/SummaryList.tsx`

**Intent**: Tokenize the three mutually exclusive non-list states plus the refresh note, without
collapsing any of them into each other.

**Contract**: `unavailable` renders the recoverable-error slot; the refresh note renders the **neutral
warning treatment** (`--card` ground, 1px `--border`, icon plus copy as its non-colour channels) — it is
not a request to spend credits, so it takes no amber; empty and empty-under-filter render on `--card`. Filter chips bind active state to
`--secondary` with `--foreground`, inactive to `--muted-foreground` — the same neutral treatment the
badges use, since a filter is not a state. Copy moves to `copy.summaries`; `FILTERS` labels reuse
`CHARACTER_LABEL` rather than defining a second map.

#### 3. Summary card and badges

**File**: `src/components/summaries/SummaryCard.tsx`

**Intent**: Rebuild the saved card on the at-rest slot and replace the hue-only character badges with
the three-channel treatment the design system proves in greyscale.

**Contract**: Card renders `--card` / `--card-foreground` with a 1px solid `--border`. `CHARACTER_BADGE`
is replaced: both variants sit on `--secondary`; Informational is a hollow ring marker at weight 500 in
`--muted-foreground`; Educational is a filled square marker at weight 700 in `--foreground`. **Neither
gets `--attention`** — descriptive metadata must not carry the urgency of a request for money.
`CHARACTER_LABEL`'s two values (informational / educational) are sourced from
`copy.summaries.character`; it stays the single exported definition, so the pending card, the saved card
and the filter chips cannot drift apart. Meta line and expand affordance move to `--muted-foreground` and `--ring`.

#### 4. Reading surface

**File**: `src/components/summaries/SummaryMarkdown.tsx`

**Intent**: This is the product's core reading surface — a summary is long Polish prose read *instead of*
watching the video — and it currently hardcodes every element.

**Contract**: Element map rebuilt on tokens with the type spec from `ds-bundle/type.html`: 16.5px/28px,
measure 62ch, **weight 400 — never 300 on dark**, in `--font-sans` (IBM Plex Sans). Headings take
`--foreground`; `code` sits on `--muted`. The `SUMMARY_ALLOWED_ELEMENTS` list and the `img`/`a` exclusion
are **not** touched — LLM output is untrusted and that exclusion has exactly one definition.

#### 5. Thumbnail

**File**: `src/components/summaries/VideoThumbnail.tsx`

**Intent**: Tokenize the frame and placeholder without touching the fallback logic.

**Contract**: Border and placeholder ground move to `--border` / `--muted`. The `stage` one-shot guard,
the derived `hqdefault` URL and the `key` remounting behaviour are unchanged.

### Success Criteria:

#### Automated Verification:

- Linting and build pass: `npm run lint && npm run build`
- `CHARACTER_LABEL` still has exactly one definition:
  `git grep -n "CHARACTER_LABEL" -- src` shows one declaration and its imports

#### Manual Verification:

- All four list states render correctly and remain mutually exclusive: populated, genuinely empty,
  empty-under-filter, and read-failed. **Force read-failed by making the summary-list query itself throw**
  (temporarily `throw` in the list service call inside `summaries.astro`, or point that one query at a
  non-existent table) — **not** by breaking `SUPABASE_URL`. That kills auth and client creation
  (`src/lib/supabase.ts:5-9`), so middleware bounces you to sign-in and the protected page never renders
  the state you are trying to see. Revert the injection afterwards.
- The read-failed state never claims the list is empty
- A summary body reads at the specified measure and leading; Polish diacritics are correct
- Both character badges are distinguishable **with the page in greyscale** (browser devtools filter)
- Expanding and collapsing a card works; the whole header row is clickable; focus ring is visible

**Implementation Note**: The greyscale check is the design system's own proof for the badges and must be
performed, not assumed.

---

## Phase 6: Summaries — capture bar and generation states

### Overview

The dialog is dissolved into an inline capture bar, and the in-flight states are built: pending card,
cost gate in its cold form, generation error, zero credits, unknown credits.

### Changes Required:

#### 1. Dissolve the dialog

**File**: `src/components/summaries/DashboardSummaries.tsx`

**Intent**: Decision #3 — generation is inline, a bar under the topbar. No dialog, no dedicated route.

**Contract**: The `Dialog` / `DialogTrigger` / `DialogContent` wrapper and the "New summary" button are
removed; `GenerateSummaryForm` renders directly above the list. **Everything else stays exactly where it
is**: the `useGenerateSummary` hook, `url` / `character` / `allowLong`, `refreshSeq`, the
`attemptId`-bound `clearAttempt`, the `onSuccess` clearing policy and the `pending` status derivation.
`onPendingConfirm` no longer reopens a dialog — it focuses the capture bar's input instead. Per the
decision confirmed during planning, **the capture bar renders on `/summaries` only**: a generation must
never start on a surface where its pending card cannot be seen. The component is renamed to
`SummariesSurface` to stop referring to a route that no longer exists.

#### 2. Capture bar

**File**: `src/components/summaries/GenerateSummaryForm.tsx`

**Intent**: Rebuild the form as the horizontal capture bar — the app's primary action, always present on
the list surface.

**Contract**: URL field uses the shadcn `input`; the character choice keeps its `radiogroup` semantics
and `sr-only` inputs, restyled to `--secondary` / `--border`; the long-video pre-authorisation uses the
shadcn `checkbox`. Submit is the `Button` default variant. The zero-credit state renders the **Disabled**
slot — `--background` under the control plus `--muted-foreground`, **layout unchanged** — and the unknown
balance renders the **Unknown** slot with shimmer. `submitDisabled` logic is untouched: never gate on a
`null` balance, because the endpoint debits atomically and answers 402 if credits really ran out. The
result block is removed — the body belongs to the real card the re-read produces, and rendering it twice
lets the two disagree. Copy moves to `copy.generate`.

#### 3. Cost gate

**File**: `src/components/summaries/PendingSummaryCard.tsx`

**Intent**: Build the "needs your decision" slot — the only amber in the app — in the cold form it will
almost always take.

**Contract**: The `needs-confirmation` state renders the attention slot: 2px `--attention` border, 12%
`--attention` fill, `--attention-text` for the message, and an action button of `--attention-foreground`
on `--attention`. It shows the derived thumbnail (free, from the video id), the URL, the cost and the
resulting balance. The gate line (`copy.generate.gate.held`) states four things and only those: that the
run is **held**, that the reason is a **long video**, the **price in credits**, and the **balance that
would remain** — both numbers interpolated, never baked into the string. **No title, channel or
duration**:
the 409 body is not extended. The `PendingSummary` interface gains nothing; the balance comes from the
hook's `credits`, which the card's owner already holds.

#### 4. Remaining in-flight states

**File**: `src/components/summaries/PendingSummaryCard.tsx`

**Intent**: Tokenize the other four statuses onto their slots without collapsing any of them.

**Contract**: `generating` renders the in-flight slot — `--muted` under a shimmer with a **1px dashed**
`--border`, the non-colour channel that distinguishes it from ghost hover, which now shares `--accent`'s
colour. `failed` renders the recoverable-error slot. `saved` and `saved-refresh-failed` stay distinct —
one is a running re-read, the other has given up — with `saved-refresh-failed` on the **neutral warning
treatment**, matching the list's refresh note because it is the same fact. Neither takes amber: a stalled
re-read asks for no spending decision. **The two ARIA regions are unchanged**: the
persistent polite region and the separate `role="alert"` both exist for documented reasons
(`PendingSummaryCard.tsx:79-86`). Copy moves to `copy.generate`.

#### 5. Client error fallbacks

**File**: `src/components/hooks/useGenerateSummary.ts`

**Intent**: Translate the client-owned fallbacks while leaving the server-preference logic intact.

**Contract**: `messageForStatus`'s fallback strings move to `copy.errors` in Polish. The
`serverError ?? fallback` preference is **not** inverted — see §Critical Implementation Details.

### Success Criteria:

#### Automated Verification:

- Linting and build pass: `npm run lint && npm run build`
- No `Dialog` import remains in the summaries tree:
  `git grep -n "ui/dialog" -- src/components/summaries` returns nothing

#### Manual Verification:

- Generating a short video: capture bar → pending card (dashed border, shimmer) → saved → real card
- Generating a long video without pre-authorisation: the cost gate renders on the pending card in
  amber with thumbnail, cost and resulting balance; confirming generates at the quoted price
- Ticking the pre-authorisation checkbox skips the gate entirely
- Amber appears **nowhere else in the app** — in particular, hovering ghost and outline buttons produces
  the neutral `--accent` surface, not amber
- A failed generation renders the error slot and is dismissable
- At zero credits the bar is disabled with no layout shift; with the balance unavailable it shimmers and
  submission is still allowed
- Navigating away mid-generation and back loses the pending card but not the credit (expected)

**Implementation Note**: The "amber appears nowhere else" check is the whole point of splitting
`--attention` from `--accent`. Verify it explicitly.

---

## Phase 7: Account surface

### Overview

The account page and its delete dialog, rebuilt on tokens with the destructive slot used correctly.

### Changes Required:

#### 1. Account page

**File**: `src/pages/account.astro`

**Intent**: Rebuild from wireframe card `2c`, with navigation delegated to the topbar.

**Contract**: `bg-cosmic` wrapper and glassmorphic cards give way to the at-rest slot. The identity block
shows the email; a credit row shows the balance from `Astro.locals.credits` alongside
`<TopUpAction variant="row-button" client:load />` — **the phase 3 component, imported, not
reimplemented**. This page adds no inline `<script>`; the interaction, the notice and the
`reportUnsupportedFeature("top-up")` call all live in that island, so the two surfaces cannot drift. The
danger zone is a distinct card bound to `--destructive`. Copy from `copy.account`.

#### 2. Delete dialog

**File**: `src/components/account/DeleteAccountDialog.tsx`

**Intent**: Tokenize the confirm-to-delete flow onto the destructive slot without touching its
safety mechanics.

**Contract**: Trigger and confirm buttons use the `Button` `destructive` variant; the dialog content
renders `--popover`; the confirmation input uses the shadcn `input`. **The lock-shut behaviour is
unchanged** — `handleOpenChange` returning early while `submitting`, plus the `onEscapeKeyDown` and
`onInteractOutside` guards, exist so a deletion in flight cannot be dismissed. The `canConfirm ===`
email comparison is unchanged. The two catch-block fallbacks move to `copy.errors` in Polish; the
server's `error` field is still preferred when present, and stays English.

### Success Criteria:

#### Automated Verification:

- Linting and build pass: `npm run lint && npm run build`
- No palette utility remains:
  `git grep -nE "(bg|text|border)-(white|blue|purple|red|slate)-?" -- src/pages/account.astro src/components/account`
  returns nothing

#### Manual Verification:

- The page renders in Polish under the shared topbar, with no "back to dashboard" link
- The delete dialog opens; the confirm button stays disabled until the email matches exactly
- While a deletion is in flight the dialog cannot be dismissed by Escape, overlay click or close button
- A successful deletion lands on `/?deleted=1`
- The top-up action on the credit row shows the notice and emits one warning — the same `"top-up"` event
  key the topbar menu emits, from the same component

**Implementation Note**: Test the delete flow against a **synthetic local account only**. Per
`lessons.md`, never commit identifiers from a real-environment run.

---

## Phase 8: Landing surface

### Overview

The marketing page: hero, three steps, CTA. No capture bar — it appears only after sign-in.

### Changes Required:

#### 1. Landing page

**File**: `src/components/Welcome.astro`

**Intent**: Rebuild from wireframe card `2a` on the flat ground the direction chose so nothing competes
with the content.

**Contract**: **Delete the cosmic orbs and the star-field `<div>`s entirely** — direction 3b is a flat,
low-chroma ground, and the decorative layers are the opposite of that. The gradient-clip hero heading
becomes `--font-display` on `--foreground`. Three feature cards render the at-rest slot with icons on
`--muted-foreground`. The signed-in CTA points at `/summaries`. Landing navigation carries **only the
logo** on the left — the pricing and how-it-works nav items are cut (decision #3 of the conflicts), and
the summaries link is suppressed by the route check phase 3 built into `Topbar.astro`, not by anything in
this file. The shell must still look deliberate when that side is empty. The tagline
(`copy.landing.tagline`) promises **only that the first summaries are free**; the original wording also
carried a "no card required" half, which is **dropped** — mentioning a card implies a card is expected
later, and no billing exists. Copy from `copy.landing`.

#### 2. Deletion toast

**File**: `src/pages/index.astro`

**Intent**: Keep the post-deletion confirmation, tokenized.

**Contract**: The `?deleted=1` toast keeps its `role="status"` and its position, rendering on `--card`
with a `--border` outline rather than hardcoded emerald. Copy from `copy.landing`.

### Success Criteria:

#### Automated Verification:

- Linting and build pass: `npm run lint && npm run build`
- No decorative blur layers remain: `git grep -n "blur-\[" -- src/components/Welcome.astro` returns
  nothing

#### Manual Verification:

- The landing page renders in Polish on the flat ground, with no orbs or star field
- The left side of the topbar with only the logo still looks deliberate, not broken
- Signed out, the CTAs are sign in / sign up; signed in, a single CTA points at `/summaries`
- Deleting an account lands here and shows the toast

---

## Phase 9: Failure-copy branch and sweep guard

### Overview

The single paid-path change, plus the mechanical proof that the sweep is complete. Reviewed as an S-09
phase, not as a restyle.

### Changes Required:

#### 1. `charged` signal

**File**: `src/pages/api/summaries/generate.ts`

**Intent**: Decision #1 — the generation-error card must be able to say *"this one was charged"* for the
caption-less case, and must never carry a blanket "no credit was taken" line. The client cannot derive
this from the status: three causes answer 422 and only some of them charge.

**Contract**: Add `charged: boolean` to the 422 bodies, **derived from the ledger outcome, never
hardcoded**. `refusalResponse` (`generate.ts:235-237`) gains a `charged: boolean` parameter; it does not
decide the value, it reports one. The three call sites supply it:

- `refuseAndCharge` (`generate.ts:264-279`) currently fires `chargeFailedTranscript` and **discards its
  result**. It must now read it and map `ChargeFailedTranscriptResult` (`credits.ts:204-208`):
  `charged` → `true`; `replay` → `true` (the credit was taken by the original attempt, not by this
  retry); `insufficient` → `false`; `notCharged` → `false`. The `requestId === null` branch skips the
  charge entirely and therefore reports `false`. Only the *value* changes here — the existing comment's
  rule that a billing failure never alters the 422 the user is owed stays exactly as written.
- The known-refusal replay at `generate.ts:331` answers for a request key already closed by a refusal
  **charge**, so it reports `true`.
- The one exempt 422 (`generate.ts:659`) reports `false`.

Verified across every other exit: 413 and 402 precede the debit, and 502 plus both 500s refund
(`generate.ts:943`, and the reservation-already-resolved branch at `generate.ts:951`). No other response
shape changes; the strings stay English.

#### 2. Branching failure copy

**Files**: `src/components/hooks/useGenerateSummary.ts`,
`src/components/summaries/SummariesSurface.tsx`, `src/components/summaries/PendingSummaryCard.tsx`

**Intent**: Surface the signal so the card states the charge outcome truthfully.

**Contract**: The hook parses `charged` from the error body and exposes it on the failure state as
`boolean | null` — `null` when the field is absent **or not a boolean**, so a malformed body degrades to
silence rather than to `false`. It is cleared alongside `error` by the existing `attemptId`-bound
clearing, so a stale charge line can never outlive its attempt. `SummariesSurface` forwards it onto the
`pending` object it derives (`DashboardSummaries.tsx:174-198`), next to `error`. `PendingSummary` gains
`charged: boolean | null`. The failed card renders the charged line (`copy.generate.charged`) only on
`true` and the no-charge line (`copy.generate.notCharged`) only on `false` — **on `null` it says nothing about money at all**. A wrong statement about the
user's money is worse than silence.

The `true` copy must be true of a replay as well as a first attempt: word it as *the operation was
charged*, not *this retry charged you*.

#### 3. Token guard

**Files**: `scripts/check-tokens.mjs`, `package.json`, `.github/workflows/ci.yml`

**Intent**: With no test suite this is the only mechanical proof the sweep is complete — and the only
thing stopping the next slice from quietly reintroducing `bg-white/10`.

**Contract**: A Node script scanning `src/**/*.{ts,tsx,astro,css}` for hardcoded palette usage and
exiting non-zero with file:line on any hit. Three pattern families: Tailwind palette utilities
(`bg-`/`text-`/`border-`/`from-`/`via-`/`to-`/`ring-`/`fill-`/`stroke-` followed by a named Tailwind hue
and a numeric step), `white` / `black` colour utilities including opacity suffixes, and arbitrary hex
values in class position (`[#rrggbb]`). `src/styles/global.css` is the sole exemption — it is where the
palette is *supposed* to live. Wire `"lint:tokens"` into `package.json` scripts and add a
`- run: npm run lint:tokens` step to the CI job after `npm run lint`.

### Success Criteria:

#### Automated Verification:

- The guard passes on the swept tree: `npm run lint:tokens`
- The guard actually catches a violation: temporarily add `bg-purple-600` to a component and confirm a
  non-zero exit naming that file:line, then revert
- Linting and build pass: `npm run lint && npm run build`
- CI runs the new step: the workflow file contains `npm run lint:tokens`

#### Manual Verification:

- A caption-less video reports the failure **and** states that a credit was charged
- Resubmitting that same video under the same `requestId` (the replay path) still reports the failure as
  charged, worded as *the operation was charged* rather than as a second debit
- A transient transcript failure reports the failure and states no credit was charged
- A failure from an endpoint that sent no `charged` field — or that sent a non-boolean — says nothing
  about money
- Full pass over all eleven screens/states in §Testing Strategy with no visual regressions

**Implementation Note**: This phase changes the paid generation path. Review it with the care the S-09
phases got: confirm that only the three 422 sites named above are touched, that each one's `charged`
value comes from the ledger outcome rather than a literal, and that no other response shape moved.

---

## Testing Strategy

There is no automated test suite; this is the manual matrix.

### Manual Testing Steps:

1. **Landing, signed out** — hero, three steps, CTAs, topbar with logo only on the left
2. **Sign up** — validation errors in Polish with correct plurals, password generator offered with the
   password both visible and hidden, confirm-email page
3. **Sign in** — success, and a server error rendering in the error slot
4. **Summaries, empty** — "generate your first", not an error
5. **Summaries, populated** — cards, badges (checked in greyscale), filters, expand/collapse, reading
   surface at 16.5/28 and 62ch
6. **Summaries, read failed** — inject a fault into the summary-list query only (never `SUPABASE_URL`,
   which breaks auth before the page renders); must never claim the list is empty
7. **Generation, short video** — pending → saved → real card
8. **Generation, long video** — cold cost gate in amber with thumbnail and resulting balance; confirm;
   then repeat with pre-authorisation ticked
9. **Generation failures** — caption-less (charged), transient (not charged), zero credits (disabled
   slot, no layout shift), unknown balance (shimmer, submission still allowed)
10. **Account** — credit row, top-up notice, delete dialog locked shut while in flight, deletion toast
11. **Cross-cutting** — amber appears only on the cost gate and general warnings render neutral;
    ghost/outline hover is neutral; the topbar is the same shell on every surface, carrying the
    summaries link everywhere but `/`; both faces load from the app's own origin

## Performance Considerations

The middleware credit read adds one RLS-scoped query per **page** request **for a signed-in user**; API
routes are excluded explicitly, and signed-out requests do not perform it at all (the condition requires
a resolved user). This replaces the per-page read `dashboard.astro` already performed, so on `/summaries`
it is net zero. It is one new read on `/account`, on `/`, and — since the exclusion covers only `/api/` —
on the three `/auth/*` pages whenever a signed-in user lands on them. That last case is a rare,
already-anomalous path (a signed-in user visiting sign-in), so it is accepted rather than special-cased:
narrowing the condition to an allow-list of paths would put a second, drift-prone route table next to
`PROTECTED_ROUTES`. Font payload is bounded in three steps, not one: `subsets` limits the character coverage to
`latin` + `latin-ext`, `styles: ["normal"]` drops the italic half Astro would otherwise generate by
default, and the **filtered** `preload` arrays eagerly fetch only the four above-the-fold faces rather
than every face returned. All faces are served from the app's own origin; the unpreloaded weights load
on demand.

## Migration Notes

**The bilingual failure path is a known, accepted gap.** UI copy is Polish; `src/pages/api/**` responses
stay English, and `messageForStatus` deliberately prefers the server's string — so generation errors will
usually read English inside a Polish interface. `wireframe-outcome.md` §4 flagged this as "the worst
possible place" for a language split; the deferral is a deliberate call taken during planning. It should
be closed by a follow-up change that translates API copy, at which point the copy module gains an `api`
namespace or the endpoint negotiates a locale.

**Light theme stays unshipped and unverified.** `:root` carries the complete light palette and one known
AA failure (`--attention` on its own 12% tint, 4.25:1). Whoever picks up the theme-toggle slice must
specify a darkened attention-on-tint value the way dark specifies a lightened one, before exposing light.

**Claude Design manifest.** `ds-bundle/tokens.css` can be re-pushed with `@font-face` rules once the
built font assets exist, to test whether `brandFonts` populates. This is step 5 and does not block
anything here.

## References

- Change identity and step history: `context/changes/app-design-system/change.md`
- Structure and the six resolved conflicts: `context/changes/app-design-system/wireframe-outcome.md`
- Final tokens and contrast verification: `context/changes/app-design-system/visual-direction-outcome.md`
- Specimens and canonical CSS: `context/changes/app-design-system/ds-bundle/`
- Metadata call placement rationale: `src/pages/api/summaries/generate.ts:812-820`
- Generation lifecycle ownership: `src/components/summaries/DashboardSummaries.tsx:29-41`
- Reporting seam precedent: `src/lib/services/supadata-budget.ts:210-232`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Token and type foundation

#### Automated

- [x] 1.1 Build succeeds and emits both font families — 00d840d
- [x] 1.2 Linting passes — 00d840d
- [x] 1.3 No `bg-cosmic` reference remains — 00d840d

#### Manual

- [x] 1.4 Both faces load from the app's own origin — verified 2026-08-12
- [x] 1.5 Exactly four font preload links in `<head>` — verified 2026-08-12
- [x] 1.6 Polish diacritics render in the loaded faces — verified 2026-08-12
- [x] 1.7 Every page sits on the flat ground — verified 2026-08-12
- [x] 1.8 `bg-attention` produces amber — verified 2026-08-12

### Phase 2: Shared infrastructure

#### Automated

- [x] 2.1 Type checking and linting pass — a4ae502
- [x] 2.2 Build succeeds — a4ae502
- [x] 2.3 `BUDGET_EVENT` string unchanged — a4ae502
- [x] 2.4 `LibBadge` gone and referenced nowhere — a4ae502

#### Manual

- [x] 2.5 Budget event logs in the same shape as before the refactor — verified 2026-08-12 (confirmed via diff a4ae502^..a4ae502: `reportEvent` reproduces the exact `${key} ${JSON.stringify(payload)}` format and warn/error split byte-for-byte; a live generation did not itself cross a warn/stop/untracked threshold, which is expected on a fresh Supadata budget)

### Phase 3: App shell

#### Automated

- [x] 3.1 Linting and build pass — 7131897
- [x] 3.2 No `/dashboard` reference survives — 7131897
- [x] 3.3 `PROTECTED_ROUTES` contains `/summaries` — 7131897

#### Manual

- [x] 3.4 Same topbar shell on all four surfaces; summaries link on all but `/` — verified 2026-08-12
- [x] 3.5 Right side branches correctly on identity — verified 2026-08-12
- [x] 3.6 Avatar menu: click, Escape, arrow keys — verified 2026-08-12
- [x] 3.7 Top-up notice shows and emits one warning — verified 2026-08-12
- [x] 3.8 `/dashboard` 404s; `/summaries` loads and still protects — verified 2026-08-12
- [x] 3.9 Missing balance shimmers rather than showing `0` — verified 2026-08-12
- [x] 3.10 Banner `warning` renders neutral, not amber, and passes AA on the dark ground — verified 2026-08-12 (contrast ratio 15.17:1)

### Phase 4: Auth surfaces

#### Automated

- [x] 4.1 Linting and build pass — 30394e9
- [x] 4.2 No palette utility remains in the auth tree — 30394e9

#### Manual

- [ ] 4.3 Three auth screens render in Polish on the at-rest slot
- [ ] 4.4 Validation errors render in the error slot with correct plurals
- [ ] 4.5 Password generator offered with password visible AND hidden
- [ ] 4.6 Server error renders in the error slot
- [ ] 4.7 Pending state shows; no double submit

### Phase 5: Summaries — list and saved cards

#### Automated

- [x] 5.1 Linting and build pass — 28ff930
- [x] 5.2 `CHARACTER_LABEL` still has exactly one definition — 28ff930

#### Manual

- [ ] 5.3 All four list states render and stay mutually exclusive
- [ ] 5.4 Read-failed state never claims the list is empty
- [ ] 5.5 Summary body reads at the specified measure and leading
- [ ] 5.6 Both badges distinguishable in greyscale
- [ ] 5.7 Expand/collapse, clickable header row, visible focus ring

### Phase 6: Summaries — capture bar and generation states

#### Automated

- [x] 6.1 Linting and build pass
- [x] 6.2 No `Dialog` import remains in the summaries tree

#### Manual

- [ ] 6.3 Short-video generation: pending → saved → real card
- [ ] 6.4 Cold cost gate renders and confirms at the quoted price
- [ ] 6.5 Pre-authorisation checkbox skips the gate
- [ ] 6.6 Amber appears nowhere else; ghost/outline hover is neutral
- [ ] 6.7 Failed generation renders the error slot and is dismissable
- [ ] 6.8 Zero credits disables with no layout shift; unknown balance shimmers
- [ ] 6.9 Navigating away mid-generation loses the card but not the credit

### Phase 7: Account surface

#### Automated

- [ ] 7.1 Linting and build pass
- [ ] 7.2 No palette utility remains in the account tree

#### Manual

- [ ] 7.3 Page renders in Polish under the shared topbar, no back-link
- [ ] 7.4 Confirm button disabled until the email matches exactly
- [ ] 7.5 Dialog cannot be dismissed while a deletion is in flight
- [ ] 7.6 Successful deletion lands on `/?deleted=1`
- [ ] 7.7 Credit-row top-up shows the notice and emits one warning

### Phase 8: Landing surface

#### Automated

- [ ] 8.1 Linting and build pass
- [ ] 8.2 No decorative blur layers remain

#### Manual

- [ ] 8.3 Landing renders in Polish on the flat ground, no orbs or star field
- [ ] 8.4 Logo-only left side still looks deliberate
- [ ] 8.5 CTAs branch correctly on identity
- [ ] 8.6 Deletion toast renders

### Phase 9: Failure-copy branch and sweep guard

#### Automated

- [ ] 9.1 Guard passes on the swept tree
- [ ] 9.2 Guard catches an injected violation, then reverted
- [ ] 9.3 Linting and build pass
- [ ] 9.4 CI runs the new step

#### Manual

- [ ] 9.5 Caption-less video reports the failure and the charge
- [ ] 9.6 Replay of the same `requestId` reports charged, worded as not a second debit
- [ ] 9.7 Transient failure reports no charge
- [ ] 9.8 Missing or non-boolean `charged` field says nothing about money
- [ ] 9.9 Full pass over the manual matrix with no visual regressions
