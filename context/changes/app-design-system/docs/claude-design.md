# Claude Design — product surface, design systems, export/handoff

**Surface:** `claude.ai/design` (also reachable from Claude Desktop) · **Vendor:** Anthropic Labs · **Fetched 2026-08-10**

**Sources:** [`anthropic.com/news/claude-design-anthropic-labs`](https://www.anthropic.com/news/claude-design-anthropic-labs), [Get started with Claude Design](https://support.claude.com/en/articles/14604416-get-started-with-claude-design), [Set up your design system in Claude Design](https://support.claude.com/en/articles/14604397-set-up-your-design-system-in-claude-design)

**Role here:** S-06 designs the new app structure and design system on this surface before any code is written. This file captures what the product can accept as input and what it can emit — the two ends of the loop. The write-side API is a separate file: [`design-sync-tool.md`](./design-sync-tool.md).

## What it is

Anthropic Labs product, launched **2026-04-17**, powered by Claude Opus 4.7. A conversational visual creation surface for "polished visual work like designs, prototypes, slides, one-pagers." Used for interactive prototypes without coding, product wireframes and mockups, design explorations and variations, pitch decks, and marketing collateral.

**Availability:** beta / research preview on **Pro, Max, Team, Enterprise**. Enterprise is **default off** — an admin enables it in Organization settings. Design-system *configuration* additionally requires admin permission.

> Confirmed for this project 2026-08-10: the user's plan has access, and `/design-sync` is available in Claude Code. Step 0 of the slice sequence is closed.

## Design systems

The differentiating feature, and the reason S-06 uses this surface at all.

**Accepted sources** (per the design-system setup article):

| Source | Notes |
| --- | --- |
| Codebases | "If your design system lives in code (for example, a React component library), you can link or upload the repository" |
| Prototypes and design files | screenshots, web flows |
| Slide decks / documents | "Even a well-designed PowerPoint or PDF that reflects your brand can work" |
| Individual assets | logos, color palettes, typography specs |

The getting-started article lists the attach paths slightly differently — **GitHub repositories, design files, raw uploads, and local codebases via `/design-sync` from Claude Code**.

**What Claude extracts:** color palettes, typography specifications, reusable UI components, layout patterns.

**Publishing:** enable the `Published` toggle to make the system available organization-wide. After that, **every new project in the org inherits it automatically** — "Claude builds with your real design system components, checks its own output against your design system, and makes corrections before you see them."

⚠️ **Project type is immutable at creation.** `PROJECT_TYPE_DESIGN_SYSTEM` is fixed when the project is made; a project created as a regular one can never become a design system. See [`design-sync-tool.md`](./design-sync-tool.md) §Pitfalls — this is the only irreversible step in the sequence.

## Adding context to a project

Beyond the design system itself: screenshots or competitor product references, existing slide decks or style guides, and codebases ("to help Claude understand your architecture").

**Input fidelity ranking used by this slice** (worst → best): screenshots < web capture < codebase import. For a *structural* redesign, web capture + codebase import together — capture shows how it actually renders, the codebase distinguishes React island from static Astro, which decides what can be rearranged without touching behaviour.

> 🟡 **`web capture` is lower-confidence than the rest of this file.** It comes from a search-result summary describing a "web capture tool to grab elements directly from your website so prototypes look like the real product," **not** from a fetched documentation page. Neither support article mentions it. Verify it exists in the UI before planning around it. The app is deployed on Cloudflare Workers, so a public URL exists if it does.

## Iterating

Three refinement channels, deliberately different in grain:

| Channel | Use for |
| --- | --- |
| Chat | broad structural changes |
| Inline comments | targeted component-level edits |
| Direct canvas editing | quick visual adjustments (real drag / resize / alignment — no full re-generation) |

## Export and handoff

ZIP, PDF, PPTX, standalone HTML, plus integrations (Adobe, Canva, Miro, Vercel), and **Handoff to Claude Code** (local agent or web version) — described as passing a bundled handoff containing design specifications and intent.

**This is the design → code direction**, and it is *not* `/design-sync`. See [`design-sync-tool.md`](./design-sync-tool.md) §Direction — the write path of `DesignSync` runs code → canvas, so it cannot be the mechanism that produces `global.css` or Astro components.

⚠️ **Canvas output is HTML/React, not Astro.** A translation step always exists for this repo. Take structure, hierarchy and tokens from the canvas; do the polish in code on real components.

## Discrepancy worth knowing

The search-result summary claims the onboarding can read "your Figma file" and "your live website" as design-system sources. **The fetched setup article mentions neither** — the fetch explicitly noted their absence from the supported-source list. Treat Figma and live-site import as unverified until seen in the UI; the four sources in the table above are the documented ones.
