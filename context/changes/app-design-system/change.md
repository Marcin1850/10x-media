---
change_id: app-design-system
title: App design system
status: new
created: 2026-08-10
updated: 2026-08-10
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

**2. Visual direction** — only once the wireframe is accepted. Color, typography, spacing scale,
   radius, brand. Iterate via chat + inline canvas comments.

**3. Design system project.** API pitfall: `PROJECT_TYPE_DESIGN_SYSTEM` is **immutable at creation** —
   a project created as a regular one can never become a design system. Create it correctly via
   `create_project`, confirm with `get_project`, then enable `Published`.

**4. Descent into code — this is the part `/10x-plan` covers.** Dependency-forced order:
   tokens in `src/styles/global.css` → primitives in `src/components/ui/` → surfaces
   (auth → dashboard → account → landing), one phase per surface.

**5. Push back via `DesignSync`** — only once components exist in code, incrementally.
   Design System pane cards come from a first-line `<!-- @dsCard group="…" -->` marker in each
   preview HTML; `register_assets` is legacy and not needed.

Steps 1–3 happen outside the repo. `/10x-plan` should start at step 4.

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
