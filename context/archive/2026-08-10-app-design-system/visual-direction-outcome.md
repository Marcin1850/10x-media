# Visual direction outcome — step 2 result

**Recorded 2026-08-11** · Brief: [`visual-direction-brief.md`](./visual-direction-brief.md) · Structure it sits on: [`wireframe-outcome.md`](./wireframe-outcome.md)

> ✅ **Settled 2026-08-11.** Turn 4 corrected the `--accent` collision; the final token block is in §Final tokens below and is what step 3 and step 4 build from. Do **not** use the turn-3 CSS — it carries the collision.

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

## Resolved: `--accent` was triple-booked (turn 4)

3b binds `--accent` to the **needs-a-decision** state (the 409 cost gate) *and* colors the **Educational** badge with it. But `--accent` already has a role in shadcn, and it is consumed in this repo today:

```
src/components/ui/button.tsx:16   outline:  hover:bg-accent hover:text-accent-foreground
src/components/ui/button.tsx:18   ghost:    hover:bg-accent hover:text-accent-foreground
src/components/ui/dialog.tsx:60   close:    data-[state=open]:bg-accent
```

Its current value is `oklch(0.97 0 0)` — near-white, a subtle hover tint. 3b sets it to `#9A6512` (light) / `#E0A24A` (dark), both saturated.

**Consequence:** every ghost and outline button hover becomes a saturated amber block, and the color that means *"decide about spending your credits"* fires on ordinary mouse-over. The semantics step 2 just built would dissolve in the first day of use.

**Fix as delivered in turn 4** — exactly three token changes, everything else from 3b untouched:

1. **New pair `--attention` / `--attention-foreground`**, marked in the CSS as an addition outside the shadcn contract. No stock component consumes it, so nothing can fire it by accident — it appears on the 409 cost gate and nowhere else.
2. **`--accent` returned to shadcn's subtle-surface role.** It is now *identical to `--muted`* in both themes — which is exactly what stock shadcn does (today's `global.css` has `--muted` and `--accent` both at `oklch(0.97 0 0)`). The collision is gone **without touching `button.tsx` or `dialog.tsx`**.
3. **Both character badges go neutral** (`--secondary`, `--muted-foreground`). The Educational badge gets neither `--attention` nor a color of its own; the ring/circle/500 vs fill/square/700 distinction that already had to work without hue now carries the whole job.

The badge reasoning is worth preserving: sharing `--attention` would put descriptive metadata at the same visual urgency as a request for money, and a third color would break the restrained-palette constraint that keeps the ground away from the thumbnails. The result is that **amber is unambiguous — it appears if and only if the app is waiting for your decision.**

`--chart-2` deliberately stays amber; charts are not a state.

### Independent verification

Every contrast claim in turn 4 was recomputed, including the composited background (12% `--attention` over `--card`) rather than taking the flat token:

| Pair | Claimed | Actual | |
| --- | --- | --- | --- |
| dark `--accent-foreground` on `--accent` | 13.5 | **13.39** | pass |
| dark `--attention-foreground` on `--attention` | 8.4 | **8.28** | pass |
| dark `--attention` as text on `--card` | 8.1 | **7.97** | pass |
| light `--accent-foreground` on `--accent` | 15.8 | **15.73** | pass |
| light white on `--attention` | 4.9 | **4.95** | pass |
| light `--attention` as text on `--card` | 4.9 | **4.95** | pass |
| dark badge `#B6B6BF` on `--card` | 8.9 | **8.81** | pass |
| dark `--foreground` on `--secondary` | 13.5 | **13.39** | pass |
| dark gate text `#EBC489` on the tint | 10.4 | **8.75** | pass — claim optimistic, reality still comfortable |

### ⚠️ One pair that was not checked, and fails — in the light theme only

**`--attention` as text on the 12% `--attention` tint:**

- dark: `#E0A24A` on `#2F2922` → **6.46:1**, fine
- light: `#9A6512` on `#F3EDE3` → **4.25:1**, **below AA**

The dark theme dodges this because turn 4 specifies a *lightened* text variant (`#EBC489`) for the gate; the light theme has no darkened counterpart, so it uses `--attention` directly and lands under 4.5.

**Not a blocker for this slice** — decision B ships dark only, so the failing combination is unreachable. It is recorded because it becomes live the moment a theme toggle exists, and it is the first concrete instance of the risk that decision B was taken to avoid: the light palette has never been rendered. **Whoever picks up the theme-toggle slice must fix this before shipping light**, by specifying a darkened attention-on-tint text value the way dark specifies a lightened one.

Minor, no action: the in-flight surface (`--muted`) and the ghost-hover surface (`--accent`) are now the same color. Different components, and the in-flight state additionally carries a dashed border plus shimmer, so the border-weight channel disambiguates them.

## Final tokens

Step 3 and step 4 build from this block. Three values differ from 3b (`--accent`, `--accent-foreground`, and the added `--attention*` pair); everything else is 3b unchanged.

```css
:root {                      /* jasny */
  --radius: 0.25rem;
  --background: #F4F4F5;   --foreground: #131316;
  --card: #FFFFFF;         --card-foreground: #131316;
  --popover: #FFFFFF;      --popover-foreground: #131316;
  --primary: #2E5FD0;      --primary-foreground: #FFFFFF;
  --secondary: #E7E7EA;    --secondary-foreground: #35353D;
  --muted: #ECECEF;        --muted-foreground: #61616B;
  --accent: #ECECEF;       --accent-foreground: #131316;
  --destructive: #C62A2F;  --destructive-foreground: #FFFFFF;
  --border: #E4E4E7;       --input: #D6D6DB;   --ring: #2E5FD0;
  /* outside the shadcn contract — the 409 cost gate only */
  --attention: #9A6512;    --attention-foreground: #FFFFFF;
  --sidebar: #EFEFF1;              --sidebar-foreground: #131316;
  --sidebar-primary: #2E5FD0;      --sidebar-primary-foreground: #FFFFFF;
  --sidebar-accent: #E7E7EA;       --sidebar-accent-foreground: #35353D;
  --sidebar-border: #E4E4E7;       --sidebar-ring: #2E5FD0;
  --chart-1: #2E5FD0; --chart-2: #9A6512; --chart-3: #3F7F6B;
  --chart-4: #7A4FBF; --chart-5: #61616B;
}
.dark {                      /* ciemny — domyślny */
  --background: #101013;   --foreground: #EDEDEF;
  --card: #17181C;         --card-foreground: #EDEDEF;
  --popover: #1C1D22;      --popover-foreground: #EDEDEF;
  --primary: #4C7DF0;      --primary-foreground: #0B1020;
  --secondary: #22232A;    --secondary-foreground: #D8D8DD;
  --muted: #22232A;        --muted-foreground: #9A9AA3;
  --accent: #22232A;       --accent-foreground: #EDEDEF;
  --destructive: #E5484D;  --destructive-foreground: #1A0A0B;
  --border: #26272E;       --input: #2E2F37;   --ring: #4C7DF0;
  /* outside the shadcn contract — the 409 cost gate only */
  --attention: #E0A24A;    --attention-foreground: #1A1305;
  --sidebar: #141518;              --sidebar-foreground: #EDEDEF;
  --sidebar-primary: #4C7DF0;      --sidebar-primary-foreground: #0B1020;
  --sidebar-accent: #22232A;       --sidebar-accent-foreground: #D8D8DD;
  --sidebar-border: #26272E;       --sidebar-ring: #4C7DF0;
  --chart-1: #4C7DF0; --chart-2: #E0A24A; --chart-3: #4FBF9B;
  --chart-4: #A98BF5; --chart-5: #9A9AA3;
}
```

**`--attention` is not part of the shadcn contract.** It needs a matching `@theme inline` entry (`--color-attention`, `--color-attention-foreground`) alongside the existing ones in `global.css`, or Tailwind will not emit `bg-attention` / `text-attention` utilities for it.

### Seven slots, final mapping

| Slot | Tokens |
| --- | --- |
| At rest | `--card` / `--card-foreground`, 1px solid `--border` |
| In flight (shimmer) | `--muted` under the shimmer, 1px dashed `--border` |
| Needs your decision | `--attention` 2px border + 12% fill, lightened `--attention` text, action button `--attention-foreground` on `--attention` |
| Recoverable error | `--destructive` as 2px border and text, 10% fill |
| Destructive | `--destructive` filled + `--destructive-foreground` |
| Disabled | `--background` under the control + `--muted-foreground`, layout unchanged |
| Unknown | `--muted` with shimmer — never a number, never `--destructive`, never `--attention` |
| *(ghost/outline hover)* | `--accent` — a surface, no longer a state |

## Deferred to step 4

- **hex vs `oklch`.** 3b emits hex; the current `global.css` is in `oklch`, which Tailwind 4 prefers for interpolation. Convert or not — a step 4 call, not a design decision.
- `--chart-*` are filled but unused; the app has no charts. Harmless.
