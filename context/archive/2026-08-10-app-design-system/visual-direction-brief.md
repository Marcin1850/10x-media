# Visual direction brief — step 2 of the S-06 sequence

**Written 2026-08-11** · Input: [`wireframe-outcome.md`](./wireframe-outcome.md) (accepted structure) · Output: the token set step 4 turns into `src/styles/global.css`

Step 1 settled **structure**. Step 2 settles **language**: color, typography, spacing, radius, elevation. Run it on the accepted 1c shell, not on a blank page.

## Deliver a token set, not screens

This is the single most important framing. Step 4's job is to fill an existing contract, not to invent one.

**Fill the shadcn token vocabulary that `global.css` already defines** — `--background`, `--foreground`, `--card`, `--popover`, `--primary`, `--secondary`, `--muted`, `--accent`, `--destructive`, `--border`, `--input`, `--ring`, `--radius`, plus the `--sidebar-*` and `--chart-*` families. Do **not** invent a parallel vocabulary: `src/components/ui/button.tsx` and `dialog.tsx` already consume these names, and every shadcn component added later will too.

Two known gaps to fill alongside it:

- **The tokens are currently dead.** No application code reads them; every page hardcodes `bg-white/10`, `text-purple-300` and friends (see `change.md` §Three findings). So the token set has to be *complete enough to replace those hardcoded utilities*, not just complete enough to satisfy shadcn.
- **`bg-cosmic` is a literal hex gradient** in an `@utility`, outside the token system, and it paints the page ground. Decide whether the new direction has a page-ground treatment at all, and if so, express it as tokens.

## Decisions this step must make

### 1. Keep the dark direction, or start over

Today's app is dark: `bg-cosmic` plus glassmorphism. The wireframes are greyscale and imply nothing. This is an open choice — make it deliberately rather than by inheritance.

### 2. Light, dark, or both

`global.css` already ships a `.dark` block, but the app is dark-only in practice because the gradient is hardcoded. **Supporting both roughly doubles the step 4 sweep**, since every hardcoded utility has to become a token that resolves in two themes. Decide now; retrofitting the second theme later is more expensive than including it.

### 3. Whether state keeps a non-color channel

The wireframes encode state in **border weight and style** because greyscale was the only lever available: `1.5px solid` for resting, `2px dashed` for in-flight, `2px solid` + tinted fill for needs-attention. Card `2d` distinguishes all four list states this way.

Now that color exists, decide explicitly: **keep border weight as a redundant second channel, or replace it with color.** Replacing it makes state color-only, which is the standard accessibility failure. Recommendation: keep the redundancy — it costs nothing and it already exists in the design.

## Semantic slots the states actually need

The state inventory is larger than "primary + destructive". From cards `2d` and `2e`:

| Slot | Used by |
| --- | --- |
| Resting / neutral surface | list cards, account panels |
| In-flight | pending card, shimmer on the thumbnail and on the credit counter |
| Needs your decision | the 409 cost gate — **neither error nor success**; the user is being asked, nothing has failed and nothing was charged |
| Failed but recoverable | list read failed, generation error |
| Destructive | Danger zone, delete-account dialog |
| Disabled / unavailable | zero-credit state (bar stays visible but inert), the "not supported yet" top-up notice |
| Unknown | credits skeleton — must never read as `0`, and must never read as an error either |

**"Needs your decision" and "unknown" are the two that get skipped** and the two this app most needs, because both sit on the money path.

## Constraints specific to this app

**The reading font must carry Polish diacritics.** Summaries are Polish prose — `ą ć ę ł ń ó ś ź ż`. Many display faces have thin or ugly coverage. Test on a real summary paragraph, not on Lorem ipsum. Since decision #4 in `wireframe-outcome.md` moved *all* copy to Polish, this now applies to the entire interface, not only the summary body.

**Reading typography is a product function here, not decoration.** A summary is long prose someone reads *instead of* watching the video. Measure, leading and heading rhythm inside `SummaryMarkdown` matter more than how the buttons look.

**The palette has to survive YouTube thumbnails.** The list is a column of 16:9 stills in arbitrary, usually loud colors you do not control. A high-chroma palette will fight them. This argues for a restrained ground with accent confined to small areas.

**The two character badges must be distinguishable without hue.** Today they are blue vs purple (`CHARACTER_BADGE` in `SummaryCard.tsx`). Add a second carrier — shape, icon, or weight.

**One shell spans a marketing hero and a dense list.** Decision 1c puts the same topbar on the landing page and on `/summaries`. The palette has to work for both without a separate marketing theme.

**The capture bar is always on screen.** It is the primary action on every signed-in surface, so its resting state needs to read as available without dominating the list underneath it.

**Fonts must be self-hostable.** The canvas loads Google Fonts from a CDN; the app is on Cloudflare Workers, and an external font host is a third-party request on every page load. Prefer faces that can be bundled.

## Out of scope

- Structure, routes and navigation — settled in step 1. If step 2 wants to move something structural, that reopens step 1 rather than being decided here.
- Component code. Step 2 ends at tokens and specimens.
- The design-system *project* — that is step 3, and its `PROJECT_TYPE_DESIGN_SYSTEM` is immutable at creation, so it must not be created as a scratchpad. Still unspent as of 2026-08-11.

## Exit criteria

1. A complete token set covering the shadcn contract, in every theme being supported.
2. Every semantic slot in the table above bound to tokens.
3. A type scale with the reading treatment for `SummaryMarkdown` shown on real Polish prose.
4. A decision recorded on each of the three questions above.
5. Specimens of the states from `2d` and `2e` rendered in the new language, so the semantics are proven, not asserted.
