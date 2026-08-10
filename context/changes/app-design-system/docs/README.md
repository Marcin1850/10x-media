# Library / API reference — app-design-system (S-06)

Claude Design reference captured while scoping S-06 (app redesign + design system). Fetched **2026-08-10** via web search + direct page fetches of the two Anthropic support articles and the Labs announcement, plus an in-session capture of the `DesignSync` tool schema and one live `list_projects` call against the user's own account. See `context/foundation/roadmap.md` §S-06 and `../change.md` for the decisions these files back; the files themselves are the reference to build against.

| File | Surface | Role |
| --- | --- | --- |
| [`claude-design.md`](./claude-design.md) | `claude.ai/design` product | What the canvas accepts as input (design-system sources, project context) and what it emits (exports, Handoff to Claude Code). Availability and plan gating |
| [`design-sync-tool.md`](./design-sync-tool.md) | `DesignSync` tool / `/design-sync` | The code↔canvas bridge: methods, plan/write ordering, payload limits, `@dsCard` markers, and the immutable-project-type pitfall |

## The one finding that changes the plan

**Third-party articles describe `/design-sync` backwards.** Blogs (aiforanything.io, explainx.ai and others surfaced by search) state that it pulls design tokens into the repo and generates framework component stubs. The tool's own schema shows the write methods target the *Claude Design project*, with no method that writes locally — so the write direction is **code → canvas**.

This is not a detail. It means Claude Design **will not** produce `src/styles/global.css` or the Astro/React components via `/design-sync`; that channel publishes an existing local component library as a design system. Design → code runs through the **Handoff to Claude Code** export plus ordinary implementation. The slice's step order (build in code at step 4, push back at step 5) follows from this and would be inverted if the blogs were trusted.

**Precedence rule for this folder:** in-session tool schema > fetched Anthropic support/announcement pages > web-search result summaries > third-party blogs. Every claim below that sits low on that ladder is marked in place.

## Reliability caveats

- **`web capture` is unverified.** Recommended to the user as the preferred way to feed the current UI into the canvas, but its only provenance is a search-result summary — neither fetched support article mentions such a tool. Confirm it exists in the UI before planning around it. (`claude-design.md` §Adding context carries the same warning inline.)
- **Figma and live-website import are unverified as design-system sources.** The search summary lists them; the fetched setup article does not, and the fetch explicitly noted their absence. The four documented sources are codebases, prototypes/design files, slide decks/documents, and individual assets.
- **The two support articles disagree slightly on attach paths.** Setup lists codebases / design files / decks / assets; getting-started lists GitHub repos / design files / raw uploads / local codebases via `/design-sync`. Probably the same capability described from two angles, but do not treat either list as exhaustive.
- **Dates come from third-party or announcement prose, not a changelog.** Claude Design launch 2026-04-17 (Anthropic announcement, reliable); `/design-sync` announced 2026-06-17 (third-party, unverified). Neither is load-bearing for the slice.
- **No version pinning exists for any of this.** All of it is beta / research preview and can move. Nothing here was re-checked after 2026-08-10.

## Not captured here

The repo-side findings (stock shadcn tokens in `global.css`, three files in `src/components/ui/`, the stale `/dashboard` description in the roadmap, the `autocomplete` gap in the auth forms) live in `../change.md` §Repo-specific findings, not in this folder — they are observations about this codebase, not vendor reference.
