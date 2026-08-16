# Wireframe brief — step 1 of the S-06 sequence

**Written 2026-08-10** · Input to step 2 (visual direction) · Sequence and decisions live in [`change.md`](./change.md); vendor reference in [`docs/`](./docs/)

Step 1 is **wireframe + IA only**, done on the Claude Design canvas before any code changes. Greyscale on purpose: structure and brand are separate decisions and must not be taken together.

## Before you start

**Create a regular project, not a design system.** This is not step 3. The wireframe is working material; the design system is a separate project created after the visual direction is settled — and `PROJECT_TYPE_DESIGN_SYSTEM` is immutable at creation, so it must not be spent on a scratchpad. See [`docs/design-sync-tool.md`](./docs/design-sync-tool.md) §Pitfalls.

## Context to feed it, in order

1. **Codebase import** — so it can tell a React island (`DashboardSummaries`, `SummaryList`, the dialogs) from static Astro. That distinction decides what can be rearranged without touching behaviour.
2. **Web capture from production** — the app is deployed on Cloudflare Workers, so a public URL exists. ⚠️ This tool is **unverified**; see `docs/README.md` §Reliability caveats. Fall back to screenshots if it isn't there.

Screenshots alone are the weakest input — pixels without structure.

## Screen inventory

| Screen | Contents |
| --- | --- |
| `/` | Landing + `Topbar`; separately, the `?deleted=1` confirmation toast |
| `/auth/signin` | Form, server-error state, submitting state |
| `/auth/signup` | As above, plus the show/hide password toggle |
| `/auth/confirm-email` | "Check your inbox" |
| `/dashboard` | Header card (email, Account settings, Sign out) + island: credits, generation entry point, character filter (All / Informational / Educational), card list |
| `/account` | Identity + "Danger zone" with the delete-account dialog |

`/auth/callback` is a redirect route with no UI — nothing to design.

**Summary card fields:** thumbnail, title, channel, duration, published date, character badge (Informational / Educational), generated-on date, body collapsed by default and expanding in place.

## States — half the value of this step

S-06's roadmap outcome names loading / empty / error explicitly. Concretely in this app:

- **List:** has items · empty · **read failed** · **saved but not in the list** (`unlisted`). These four are mutually exclusive and the code deliberately refuses to collapse them — an empty list must never be shown for a failed read.
- **Generation:** idle · in flight (pending card) · **long-video cost confirmation** (the 409 gate — costs 2 credits instead of 1) · error · zero credits.
- **Credits:** a number, or `—` for unknown. `null` is not zero and must not render as zero.
- **Thumbnail:** loaded · fallback.

## Prompt

```
Redesign the information architecture for 10xMedia, a tool that turns YouTube
links into Polish summaries so you know what's worth watching.

Wireframes only: greyscale, no color, no brand, no final typography. I want
structure, hierarchy and navigation decided — visual language comes later.

Current problem: three surfaces each invent their own navigation. The landing
page has a topbar; /dashboard puts account links inside a header card;
/account has a lone "back" link. Give the whole app one coherent shell.

Screens: landing, sign in, sign up, confirm email, dashboard (summary list +
generation), account settings.

For the dashboard, wireframe every state, not just the happy path:
list with items, empty list, list read failed, summary saved but missing from
the list, generation in flight, long-video cost confirmation, generation error,
zero credits, unknown credit balance.

Constraints: generation is a paid operation gated by a credit budget, so its
entry point and its cost confirmation must be impossible to miss. Summaries are
long Polish prose that must stay readable. The list is server-rendered and
filtered by two channel characters: Informational and Educational.

Propose 2-3 structurally different options for the signed-in area before
refining one.
```

## Questions this step must settle

1. **One navigation shell** — what it contains and how it behaves across all three surface groups.
2. **Where credits live** — currently inside the island; a global header is the obvious candidate.
3. **Generation entry point** — dialog (the current shape, post-S-02), inline, or its own route.
4. **Whether the list deserves its own route**, separate from a dashboard.
5. **What the landing page is for** — a marketing page, or just a signed-out gate.

## Out of scope for step 1

- Color, brand, typography — that is step 2, and greyscale exists to stop the two decisions from merging.
- Pixel-perfect output — canvas output is HTML/React, not Astro, so a translation step always follows. Deliver structure, hierarchy and tokens; polish in code on real components.
- Any behaviour change. S-06 stays presentational and away from the paid generation path.

## Exit criteria

An accepted layout for every screen **and** every state listed above, plus answers to all five questions.
