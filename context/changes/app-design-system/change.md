---
change_id: app-design-system
title: App design system
status: implementing
created: 2026-08-10
updated: 2026-08-12
archived_at: null
---

## Notes

### Intent (user, 2026-08-10)

Redesign the app from scratch. The current UI comes from the starter and the user has many
objections to it. Three goals, in order:

1. Redesign the application — probably starting from a new wireframe.
2. Create a new design system.
3. Apply that design system across the app.

Tool of choice: **Claude Design** (`claude.ai/design`).

### Scope note — this widens S-06

The roadmap defines S-06 as **presentational only** ("restyle the existing shadcn/ui surfaces",
low risk, deferrable). A new wireframe + a design system built from zero is materially wider,
and it answers both of the slice's open `Unknowns` on the "broad" side:

- *"restyle existing surfaces vs. adopt a fuller design language"* → **fuller design language**
- *"which surfaces beyond auth + generation + list"* → **all of them, incl. landing**

Accepted deliberately by the user. Re-estimate accordingly: this is a multi-phase slice, not polish.

### How Claude Design actually integrates (researched 2026-08-10)

Third-party blogs claim `/design-sync` pulls tokens into the repo and generates component stubs
for your framework. **That is not what the `DesignSync` tool does.** Per its own schema:

- Write methods (`write_files`, `delete_files`) target the **Claude Design project**.
- Read methods are only `list_projects` / `get_project` / `list_files` / `get_file`.
- Direction of writing is therefore **code → canvas**, incrementally, one component at a time,
  explicitly "never as a wholesale replace".

Practical consequence: **Claude Design will not generate `global.css` or the Astro/React components
via `/design-sync`.** That channel publishes a local component library as a design system on the
canvas. Design → code translation happens through the **Handoff to Claude Code** export (or an
HTML/ZIP export) and ordinary implementation work. This inverts the step order the blogs imply.

### Recommended sequence

**0. Verify access — RESOLVED 2026-08-10.** User confirmed `/design-sync` is available and their
   plan has access to `claude.ai/design`. No tooling blocker. (Earlier note said the skill was
   missing from the session's skill list — that was a listing artifact, not an access problem.)

**1. Wireframe + IA — before any design system.** → full brief: [`wireframe-brief.md`](./wireframe-brief.md)
   (screen inventory, the nine dashboard states, the prompt, the five IA questions, exit criteria).
   Separate Claude Design project — a **regular** one, not the design system. Cover `/`,
   `/auth/*`, `/dashboard`, `/account`, navigation, and loading / empty / error states.
   Greyscale on purpose — keep layout decisions separate from brand decisions.

   **Input fidelity matters — do not use screenshots.** Three levels are available, worst to best:
   screenshots (pixels only, no structure) < **web capture** (Claude Design grabs elements straight
   from the live site — the app is deployed on Cloudflare Workers, so a public URL exists) <
   **codebase import** (real components instead of approximations). For a *structural* redesign use
   **web capture + codebase import together**: capture shows how it actually looks, the codebase
   shows what is a React island vs. static Astro. That distinction decides what can be rearranged
   without touching behaviour.

**2. Visual direction** — only once the wireframe is accepted. → full brief:
   [`visual-direction-brief.md`](./visual-direction-brief.md) (fill the existing shadcn token
   vocabulary, the seven semantic slots, three decisions, app-specific constraints, exit criteria).
   Step 1's result is recorded in [`wireframe-outcome.md`](./wireframe-outcome.md).

**3. Design system project — CREATED 2026-08-11.** `10xMedia Design System`,
   `projectId: c4baaf64-3ad0-4887-a790-70ae042ea9ee`. Type verified via `get_project` as
   `PROJECT_TYPE_DESIGN_SYSTEM` before anything was written to it — that type is **immutable at
   creation**, so a project made as a regular one could never have become a design system.
   `canEdit: true`. **Populated 2026-08-11** with the six-file bundle in [`ds-bundle/`](./ds-bundle/)
   — source of truth is the local folder, so it can be rebuilt and re-pushed.
   **`Published` was already on at creation** — not an extra step, contrary to what this file said
   before the project existed.

   | File | Card group | Carries |
   | --- | --- | --- |
   | `colors.html` | Colors | Both themes; `--attention` marked as outside the shadcn contract; the light-theme AA warning |
   | `type.html` | Type | Font pairing with rationale, diacritics, scale, reading spec on real Polish prose |
   | `states.html` | States | Seven slots + hover surface, each with its non-color channel |
   | `badges.html` | Components | Both badges in color **and** greyscale, as proof rather than claim |
   | `cost-gate.html` | Components | The 409 gate, the `--accent` collision history, the missing-metadata caveat |
   | `tokens.css` | *(not a card)* | The canonical CSS to copy, with the `@theme inline` note |

   Specimens deliberately carry *reasons*, not just values — a design system read in six months should
   stop someone from re-making the decisions this slice already made.

   **Verified from `_ds_manifest.json`:** all five cards registered under the intended groups
   (Colors / Type / States / Components ×2), `tokens.css` recognised as `globalCssPaths`, all 70 tokens
   parsed including `--attention` in both scopes, and `.dark` detected as a theme. So the custom token
   is a first-class part of the system, not just a comment.

   **Gap found the same way, and NOT closed — deferred to step 4.** The manifest reports
   `fonts: []` / `brandFonts: []`. The type pairing lived only in `type.html`'s specimen markup, so a
   project inheriting this system gets the palette with no fonts. `--font-sans` / `--font-display` /
   `--font-mono` were added to `tokens.css` and pushed — **the push landed** (confirmed by reading
   `tokens.css` back from the server) **but the manifest did not pick them up**, not even into its
   `tokens` array, while `--radius` sits there with `kind: "radius"`.

   Read: the parser has a closed vocabulary of token kinds and `font-family` is not in it. `fonts` and
   `brandFonts` are separate arrays from `tokens`, which suggests faces are detected from **font assets
   or `@font-face` rules**, not from a CSS variable. Not resolved from one observation — the manifest is
   byte-identical to its pre-push version, which fits both "the self-check ran and skipped fonts" and
   "the self-check did not re-run". Deliberately not investigated further; it is an undocumented pipeline
   on the vendor's side.

   **Why this does not block:** the manifest feeds *Claude Design's* generation, not step 4.
   `src/styles/global.css` takes its faces from `tokens.css`, which we control, and the declarations are
   there. Only the index Claude Design consults when designing *new* work is missing them.

   **Action, in step 4:** ship Space Grotesk and IBM Plex Sans as **WOFF2 in the repo** — required
   anyway, since no-CDN-at-runtime on Workers is a hard constraint from
   [`visual-direction-brief.md`](./visual-direction-brief.md). Those same assets are the most likely
   thing to populate `brandFonts`, so acquiring them serves both purposes. Re-push `tokens.css` with
   `@font-face` at that point and re-read the manifest.

   **Client discrepancy:** the project is visible in the **web** app and not in the desktop app.

   The wireframe/visual-direction work lives in a separate *regular* project,
   `10xMedia app screens` (`6f4d8fe2-d9bd-48db-ae24-190383dea2c8`) — turns 1-2 structure,
   3-4 visual direction. That one is a scratchpad and is deliberately not the design system.

**4. Descent into code — this is the part `/10x-plan` covers.** ← **NEXT.** Steps 1-3 are closed.
   Dependency-forced order: tokens in `src/styles/global.css` → primitives in `src/components/ui/` →
   surfaces (auth → summaries → account → landing), one phase per surface.

   Inputs are complete: [`wireframe-outcome.md`](./wireframe-outcome.md) (structure + six settled
   decisions), [`visual-direction-outcome.md`](./visual-direction-outcome.md) (final tokens, contrast
   verified), [`ds-bundle/`](./ds-bundle/) (specimens + `tokens.css` to copy).

   **What step 4 actually is, which is not what the roadmap says.** Not a restyle:

   - No application code reads the shadcn tokens today, so this is a sweep across
     `src/components/summaries/` (7) and `src/components/auth/` (6), not a palette swap.
   - `--attention` needs an `@theme inline` entry or Tailwind emits no `bg-attention` utilities.
   - `bg-cosmic` is deleted along with its two usages.
   - `class="dark"` and `lang="pl"` on `<html>` in `Layout.astro`.
   - All UI copy to Polish. ~~**including 15+ user-facing strings in API error responses**.~~
     **Narrowed 2026-08-11:** `src/pages/api/**` stays **English** — translating it is deferred to a
     follow-up change. UI copy goes through a single-locale module (`src/lib/copy/`) so a second
     language is a new file, not another 18-file sweep.
   - `/dashboard` → `/summaries`, incl. `PROTECTED_ROUTES` and four link sites.
   - ~~The 409 body gains title/channel/duration — **add fields, do not move the metadata call**.~~
     **Reversed 2026-08-11 — see the correction below.** The 409 body is left unchanged.
   - Space Grotesk + IBM Plex Sans, self-hosted; no CDN at runtime.
     **Delivery decided 2026-08-11:** Astro 6's Fonts API (`google` provider, `subsets: ["latin",
     "latin-ext"]`), not hand-committed WOFF2 — the `experimental.fonts` flag was removed in v6, so it
     is stable, and it self-hosts from the build output. Consequence for step 5: the built font files
     sit at hashed paths rather than stable repo paths, so they are a weaker candidate for populating
     the manifest's empty `brandFonts` than the committed-WOFF2 route would have been.

   ~~Decisions 2, 4 and 6 put this slice inside `generate.ts`~~, so the roadmap's "no behaviour changes
   to generation, credits or CRUD" scope note for S-06 is **superseded** — review it like an S-09 phase,
   not like a restyle.

   **Narrowed 2026-08-11.** The conclusion stands, the reasons shrank. Decision 6 is reversed and
   decision 4's API half is deferred, so **decision 1 is the only one left inside `generate.ts`**: the
   failure card must be able to say *"this one was charged"*, which the client cannot derive from the
   status because three causes answer 422 and only some of them charge. It needs `charged: boolean` at
   exactly **two sites** — `refusalResponse` (`generate.ts:235-237`), which every chargeable refusal
   routes through, and the one exempt 422 (`generate.ts:659`). Verified across every other exit: 413 and
   402 precede the debit, and 502 plus both 500s refund (`generate.ts:943`, and the
   reservation-already-resolved branch at `generate.ts:951`). Decision 2's log warning lands in a new
   `src/lib/services/reporting.ts`, not in the endpoint.

**5. Push back via `DesignSync`** — only once components exist in code, incrementally.
   Design System pane cards come from a first-line `<!-- @dsCard group="…" -->` marker in each
   preview HTML; `register_assets` is legacy and not needed.

Steps 1–3 happen outside the repo. `/10x-plan` should start at step 4.

### ⚠️ Correction — a design-time assumption about the 409 was wrong (found 2026-08-11)

Recorded because it invalidates one settled decision and part of a design system specimen, and because
the mistake is instructive: **it is the class of error that canvas work produces by construction.**

**The false claim.** `wireframe-outcome.md` §6 and `ds-bundle/cost-gate.html` both assert that video
metadata "is fetched earlier in the same request", before the 409 returns — so title, channel and
duration could simply be added to the response body. Decision 6 rests entirely on that sentence.

**What the code does.** `generate.ts:493` is `getCachedMetadata`, a **free database read** of the shared
30-day cache — this is what was mistaken for the fetch. The real `fetchVideoMetadata` is at
`generate.ts:859`, **114 lines after the 409 returns at `generate.ts:745`**, and after both the credit
debit and the paid LLM call.

**And the cache does not rescue it.** `saveCachedMetadata` runs only on a **completed** generation
(`metadata-cache.ts:15-17` — no negative caching, by design). A user who reaches the gate and cancels
never warms the cache, so retrying the same video is still cold. The cache is warm only if somebody
fully generated that video within 30 days — in which case gating it again means a repeat generation.
**In practice the cost gate is almost always cold.**

**Consequence.** Decision 6 is reversed: the 409 body is unchanged, and the gate is designed for the
cold case — derived thumbnail (free, from the video id), URL, cost, resulting balance. Same answer for
the pending card. Everything else in the specimen stands: the 2px border, the 12% tint, and the
`--attention` semantics were never affected.

**Why it happened, and the general lesson.** The canvas has no way to check a claim about request
ordering — it renders whatever data the designer says exists. `change.md` already anticipated the shape
of this problem in the 2026-08-10 decision note below ("canvas output is HTML/React, not Astro — a
translation step always exists"), but framed it as a *markup* translation problem. It is wider than
that: **a canvas can also invent facts about the backend, and those look identical to real ones until
someone opens the file.** The corrective is cheap — any claim a specimen makes about what the server
returns must be checked against the code before it becomes a decision, not after.

Corrections are annotated in place in all three documents rather than deleted, so the reasoning that led
to the original decision stays readable.

**`ds-bundle/cost-gate.html` has been edited locally and is now ahead of the copy pushed to Claude
Design.** Re-push it in step 5.

### Planning outcome — step 4 decisions (2026-08-11)

`plan.md` + `plan-brief.md` written; `status: planned`. Nine phases. Decisions taken during planning
that are not in any step 1-3 artifact:

| Decision | Choice | Why |
| --- | --- | --- |
| 409 cost gate | Design for cold; no endpoint change | See the correction above |
| Fonts | Astro 6 Fonts API, `google` provider, `latin` + `latin-ext` | Stable in v6, self-hosts at build, no binaries in git |
| Primitives | `input checkbox dropdown-menu badge label` only | Covers the five screens; a hand-rolled dropdown would regress a11y |
| Copy boundary | UI fully Polish; `src/pages/api/**` English | Server translation deferred; more UI languages assumed later |
| Copy structure | Single-locale module `src/lib/copy/` | A second language becomes a new file, not another sweep |
| Reporting seam | Extract `src/lib/services/reporting.ts`; refactor `reportBudgetThreshold` onto it | One seam, so a receiver later reaches both event families |
| Sweep proof | `npm run lint:tokens` grep guard, wired into CI | No test suite exists; the only mechanical proof the sweep is complete |
| Capture bar placement | `/summaries` only | `1c` says "every signed-in surface", but `PendingSummaryCard` is client-session-only — a generation must never start where its card cannot be seen |
| Hex vs `oklch` | Keep hex | All 16 contrast ratios were computed on those exact values |

**Known accepted gap:** UI is Polish, API responses are English, and `messageForStatus` deliberately
prefers the server's string — so generation errors will usually read English inside a Polish interface.
`wireframe-outcome.md` §4 called this "the worst possible place" for a language split. Accepted
deliberately; needs a follow-up change.

### Decision — design the new structure on the canvas, not in the app (2026-08-10)

Settled: the UI restructure is explored in Claude Design **before** any code changes, rather than
by rearranging the app and designing from the result.

- Structural iteration is cheap on a canvas and expensive in code — an IA change here touches Astro
  pages, layout and React islands at once, and every dead end is a revert.
- `/dashboard` is not a static layout. S-02 deliberately lifted the generation lifecycle into
  `useGenerateSummary` + `DashboardSummaries` so dismissing the dialog cannot orphan an in-flight
  paid request. Rearranging that page in code "to try things" leads straight into that code, and
  S-06 is meant to stay presentational and away from the paid path.
- With no design system yet, "change the app first" means inventing structure *and* visual language
  simultaneously in the most expensive medium.
- Doing it in code and then re-designing from the new screens pays for the same step twice.

Would flip only for small mechanical changes (move `Topbar`, add a nav link), where a canvas round
trip costs more than the edit. Not this slice.

**Caveat carried into step 4:** canvas output is HTML/React, not Astro — a translation step always
exists. Deliver *structure, hierarchy and tokens* from the canvas and do the polish in code on real
components. The canvas is for decisions, not for producing final markup.

### Repo-specific findings (verified 2026-08-10)

- **There is no design system to migrate — it's a blank slate.** `src/styles/global.css` (124 lines)
  is 100% stock shadcn: every color is `oklch(… 0 0)`, i.e. pure greyscale, zero brand.
  `src/components/ui/` holds exactly three files: `button.tsx`, `dialog.tsx`, `LibBadge.astro`.
- **The real work is elsewhere:** `src/components/summaries/` (7 components) and
  `src/components/auth/` (6 components).

#### Three findings that are the actual case for this slice (2026-08-10)

**1. Two disconnected visual systems coexist, and the tokenized one is dead code.**
The shadcn tokens in `global.css` are referenced by exactly three files: `src/components/ui/button.tsx`,
`src/components/ui/dialog.tsx`, and `global.css` itself. **No application code uses them.** Every page
and feature component hardcodes utilities instead — `bg-white/10`, `border-white/10`,
`text-blue-100/80`, `text-purple-300`, `backdrop-blur-xl`, gradient text via
`from-blue-200 to-purple-200 bg-clip-text text-transparent`.

Consequence: the two shadcn components render from a **neutral greyscale** palette while sitting on a
**purple/blue glassmorphic** surface. They are visually foreign inside their own app. Any token work in
step 4 that stops at `global.css` changes almost nothing on screen — the restyle is a find-and-replace
across feature components, not a palette swap.

**2. `bg-cosmic` is a hardcoded gradient outside any token system.**
Defined as `@utility bg-cosmic` in `global.css` with literal hex stops
(`linear-gradient(to bottom, #0a0e1a, #0f1529, #0a0e1a)`). It sets the page ground on `/dashboard` and
`/account`. Not a variable, not themeable, not reachable from the design system.

**3. There is no shared navigation.** `Topbar.astro` is imported by exactly one file —
`Welcome.astro`, i.e. the landing page. `/dashboard` invents its own account links inside the header
card; `/account` has a lone "← Back to dashboard". Three surfaces, three ad-hoc navigations. This is
precisely the cross-surface incoherence S-06 exists to fix, and it is an **IA** problem — it must be
settled in the wireframe (step 1), not discovered during the restyle.
- **Wireframe must start from the current state, not the roadmap's description.** S-06's Risk note
  describes `/dashboard` as one `max-w-lg` card with an inline generate form. Stale — S-02 widened
  it into a full-width list and moved generation into a dismissable dialog owned by a parent island.
- **One non-visual task already lives in this slice** (S-06 scope notes): missing `autocomplete`
  attributes in the auth forms block the browser's password generator. Gotcha: the show/hide toggle
  swaps `type` from `password` to `text`, and a `text` input is not a password field to the
  generator — verify both states.

### References

Vendor reference is captured in [`docs/`](./docs/) — read that before planning, not the raw URLs.

| File | Covers |
| --- | --- |
| [`docs/README.md`](./docs/README.md) | Index, source-precedence rule, reliability caveats |
| [`docs/claude-design.md`](./docs/claude-design.md) | Product surface: design-system sources, project context, iteration channels, exports / Handoff to Claude Code |
| [`docs/design-sync-tool.md`](./docs/design-sync-tool.md) | `DesignSync` API: methods, plan/write ordering, payload limits, `@dsCard`, immutable project type |

Primary sources fetched 2026-08-10:
[Labs announcement](https://www.anthropic.com/news/claude-design-anthropic-labs) ·
[Get started](https://support.claude.com/en/articles/14604416-get-started-with-claude-design) ·
[Set up your design system](https://support.claude.com/en/articles/14604397-set-up-your-design-system-in-claude-design)
