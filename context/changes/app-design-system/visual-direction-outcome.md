# Visual direction outcome — step 2 result

**Recorded 2026-08-11** · Brief: [`visual-direction-brief.md`](./visual-direction-brief.md) · Structure it sits on: [`wireframe-outcome.md`](./wireframe-outcome.md)

> ⚠️ **The final token block is not in this file yet.** It is being corrected on the canvas — see §Open: `--accent` is triple-booked. Do not copy the turn-3 CSS into `global.css` before that lands; it would bake the collision into the design system.

## Chosen direction

Turn 3 of project `10xMedia app screens` proposed three directions. **`3b` — "Konsola" — was chosen.**

| Option | Direction |
| --- | --- |
| `3a` | "Redakcja" — warm paper, light-only, border carries state |
| **`3b`** | **"Konsola" — flat dark ground, both themes, sans-serif body** ← chosen |
| `3c` | "Studio" — cool grey, soft radius, state without border weight |

## What 3b delivers

| Exit criterion | Status |
| --- | --- |
| Complete token set, every supported theme | ✅ full shadcn contract, `:root` + `.dark` |
| All seven semantic slots bound to tokens | ✅ explicit mapping |
| Type scale with the reading treatment on real Polish prose | ✅ **16.5/28, measure 62ch, weight 400 — never 300 on dark** |
| States from `2d`/`2e` re-rendered | ✅ |
| The three decisions answered | ✅ see below |

**Typography:** Space Grotesk (UI) + IBM Plex Sans (body). Both OFL, so both bundle — this satisfies the no-CDN-at-runtime constraint. Body is deliberately sans, not serif: Plex Sans has a high x-height and open letterforms, and its Polish glyphs are *drawn* rather than composited from accents.

**Why the ground is flat and low-chroma:** so thumbnails glow and the background does not compete with them. This is the brief's YouTube-thumbnail constraint answered on the merits, not by taste.

**Character badges carry three channels, not one:** Informational = hollow ring + weight 500; Educational = filled square + weight 700 + accent color. Legible without relying on hue, as required.

### Contrast — verified, not asserted

All 16 foreground/background pairs across both themes were computed against WCAG. **Every pair clears 4.5:1.** Tightest is `destructive` as outline text on `--card` at **4.53:1** — it passes AA, but it is the floor of the set and must not be lightened further.

## Decisions

### Three from the brief

1. **Both themes**, dark treated as the product's look.
2. **Start over on the dark direction.** The new ground is a flat `--background`, not the old gradient — so **`@utility bg-cosmic` is deleted**, along with its two usages in `dashboard.astro` and `account.astro`.
3. **Border weight stays as a second, non-color state channel:** 1px solid at rest, 1px dashed in flight, 2px accent for needs-a-decision. The redundancy the greyscale wireframes established for free is kept.

### Dark-by-default: option B (decided 2026-08-11)

**Keep 3b's arrangement — light in `:root`, dark in `.dark` — and add `class="dark"` to `<html>` in `src/layouts/Layout.astro`.**

The situation this resolves: nothing in the app sets `.dark` today, so the `.dark` block has never been active. The app only *looks* dark because pages hardcode `bg-cosmic` and `text-white`. **Once step 4 tokenizes those away, the app would flip to light by default** — this decision is about what happens automatically, not about preference.

Options considered and rejected:

- **A · invert, dark into `:root`** — goes against the shadcn/Tailwind convention where `.dark` is standard, so every component added later via `npx shadcn add` arrives with `dark:` utilities that would behave backwards.
- **C · `prefers-color-scheme`** — then the OS decides, so "dark by default" stops being true, and it does not compose cleanly with a manual toggle later.
- **D · a real theme toggle with persistence** — this is SSR on Cloudflare Workers, so a `localStorage`-driven toggle flashes the wrong theme on every load. Doing it properly needs a server-side cookie read in middleware or the layout. **Its own slice, not a side effect of a restyle.**

Why B: the shadcn convention stays intact, the cost is one line, and — most importantly — **the light theme is currently unverified**. Every state specimen in turn 3 was drawn on dark, so the seven semantic slots have been checked in one theme only. The light palette is kept and correct, waiting for the toggle slice; it is simply not exposed until someone has seen it.

### Related, same file and same moment

`src/layouts/Layout.astro` declares `<html lang="en">`. Decision #4 in `wireframe-outcome.md` moved all copy to Polish, so this must become **`lang="pl"`**. Not cosmetic — screen readers, hyphenation and spellcheck all key off it.

## Open: `--accent` is triple-booked

3b binds `--accent` to the **needs-a-decision** state (the 409 cost gate) *and* colors the **Educational** badge with it. But `--accent` already has a role in shadcn, and it is consumed in this repo today:

```
src/components/ui/button.tsx:16   outline:  hover:bg-accent hover:text-accent-foreground
src/components/ui/button.tsx:18   ghost:    hover:bg-accent hover:text-accent-foreground
src/components/ui/dialog.tsx:60   close:    data-[state=open]:bg-accent
```

Its current value is `oklch(0.97 0 0)` — near-white, a subtle hover tint. 3b sets it to `#9A6512` (light) / `#E0A24A` (dark), both saturated.

**Consequence:** every ghost and outline button hover becomes a saturated amber block, and the color that means *"decide about spending your credits"* fires on ordinary mouse-over. The semantics step 2 just built would dissolve in the first day of use.

**Fix, being made on the canvas:** give the decision state its own token (`--attention` / `--attention-foreground`), return `--accent` to shadcn's subtle-hover role, and decide separately whether the Educational badge shares the attention color or gets its own.

## Deferred to step 4

- **hex vs `oklch`.** 3b emits hex; the current `global.css` is in `oklch`, which Tailwind 4 prefers for interpolation. Convert or not — a step 4 call, not a design decision.
- `--chart-*` are filled but unused; the app has no charts. Harmless.
