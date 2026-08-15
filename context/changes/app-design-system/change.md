---
change_id: app-design-system
title: App design system
status: impl_reviewed
created: 2026-08-10
updated: 2026-08-14
archived_at: null
---

## Notes

### Manual QA — phase 10 sweep, in progress (2026-08-14)

Sweep run against the branch deployed directly to production (`https://10x-media.nightshiftlab.workers.dev`,
version `eae88462-fe2d-4b64-92a9-115746c1ff75`) rather than local dev, per user request — bypasses CI and
the `master` merge, does not affect `master`'s deployed state going forward.

- **Finding 1 — landing copy mismatched its own model (fixed).** The "tuned" feature card on `/` read
  "Dopasowane do kanału" ("Tuned to the channel"), but `src/lib/services/llm.ts:20,48` selects the
  `informational` / `educational` prompt **per video**, not per channel — a single YouTube channel can mix
  both kinds of content, so the channel-level claim was simply false. Changed heading to "Dopasowane do
  treści" and reworded the description from "Kanały informacyjne… Kanały edukacyjne…" to "Materiały
  informacyjne… Materiały edukacyjne…" (`src/lib/copy/pl.ts:180-182`). Presentational only, no scope
  overlap with the paid path.

- **Finding 2 — no way to reach the source video or channel from a summary card (fixed, wider than
  presentational).** `SummaryCard.tsx` rendered the thumbnail, title and channel name as inert text —
  nothing linked out to YouTube. The video half was free (`youtubeId` is a `NOT NULL` column, so
  `https://www.youtube.com/watch?v=<id>` always resolves), but the channel half needed a real
  identifier: `videos.channel_name` is the vendor's **display name**, not a handle, and is not a valid
  link target (display names aren't unique or URL-safe). Checked `@supadata/js`'s `MetadataAuthor` type
  — it carries `username` (the channel handle) alongside `displayName`, but the app had never captured
  it.
  - **Schema change, on production, mid-sweep**: `channel_username text` added to `videos` and
    `metadata_cache`, and `get_metadata_cache` / `save_metadata_cache` / `persist_summary` widened to
    carry it (`supabase/migrations/20260814130000_channel_username.sql`), following the exact
    drop-and-recreate pattern `20260725120000` and `20260731120000` established for a signature change,
    including the same "run `db push` and `wrangler deploy` back to back, no gap" discipline — confirmed
    with a `--dry-run` first, then pushed and redeployed in one shot. Threaded through
    `metadata.ts` -> `metadata-cache.ts` -> `summaries.ts` -> `summary-list.ts` -> `types.ts` ->
    `SummaryCard.tsx`.
  - **Existing summaries stay without a channel link** — `channel_username` is null on every row
    persisted before this migration, and there is no backfill (would mean re-fetching metadata from
    Supadata, at cost, for every historical row). Only generations from this point forward pick it up.
    Accepted rather than backfilled, consistent with how `metadata_via`, `resolved_via` and every other
    telemetry column added mid-project already treats pre-migration rows (null, not reconstructed).
  - **UI**: thumbnail and title both link to the video; channel name links to the channel only when
    `channelUsername` is non-null, else renders as plain text (never a dead or wrong link). Both open in
    a new tab (`target="_blank" rel="noopener noreferrer"`, per user request). The links sit at
    `relative z-10` to escape the toggle button's stretched `::after` click-catcher described in the
    header-row comment — without that, the two would have received the row's expand/collapse click
    instead of navigating.
  - Copy: two new accessible-name strings, `card.openVideo` / `card.openChannel`
    (`src/lib/copy/pl.ts:111-112`).

- **Finding 3 — Markdown renderer silently drops H1 headings (fixed, presentational only).** Pulled the
  raw `content` for the "Update from Ukraine…" card straight from `DashboardSummaries`'s hydration props
  (`astro-island[component-url*="DashboardSummaries"]`'s `props` attribute), no DB access needed — it
  starts with `# Przegląd wideo`, a real Markdown H1. `SummaryMarkdown.tsx`'s `SUMMARY_ALLOWED_ELEMENTS`
  only listed `h2`/`h3`; `react-markdown`'s `unwrapDisallowed` strips any element outside that list of its
  tag and styling, so the H1 rendered as bare unstyled text — exactly the "doesn't match the DB" symptom
  reported, and nothing to do with caching. Root cause: the `informational` system prompt
  (`llm.ts:20-47`) never authorizes or forbids headings (only the `educational` prompt explicitly grants
  `### `), so the model sometimes adds one anyway and the renderer's allowlist didn't cover it. Fixed by
  adding `h1` to both the allowlist and the component map (`text-xl font-semibold`, one step above `h2`)
  — makes the renderer robust to whatever heading level the model produces rather than depending on
  prompt compliance, consistent with how the existing `img`/`a` exclusion already treats LLM output as
  untrusted rather than guaranteed-conformant. Left the generation prompts untouched — that is the paid
  path and out of scope for a presentational fix.

- **Finding 4 — duration and upload date were bare, same-styled text (fixed, presentational only).**
  User's own framing: hard to tell apart from the channel name or from each other at a glance, since all
  three sat in one `·`-joined string with identical styling. Added `lucide-react` icons — `Clock` before
  duration, `Calendar` before upload date — consistent with how `CharacterBadge` already differentiates
  by shape rather than introducing a new colour. Icons are `aria-hidden`; the text values are unchanged
  (`12:34`, `2026-08-13`), so nothing is lost for screen readers. Restructured the meta line from a
  joined string in one `<p>` to a `flex flex-wrap` row of independent chips (`SummaryCard.tsx`) — this
  also means a long channel name now truncates on its own rather than eating space that would otherwise
  cut off the duration/date, and the row wraps instead of overflowing at the mobile width Phase 10 is
  sweeping.
  - **Deliberately left `generatedOn` unchanged** (user's own question, before implementing): that line
    already carries a text label ("Wygenerowano …"), so the ambiguity icons solve for the unlabeled
    duration/date values doesn't apply there. It is also the least important date on the card, and an
    icon would raise its visual weight in the wrong direction.

- **Finding 5 — upload date had no sense of "how long ago" (fixed, presentational only).** User's
  suggestion: add it in parentheses next to the date. Added `daysSince()` (`lib/format.ts`) — whole UTC
  calendar days between `published_at` and now, built from `Date.UTC` day-parts rather than a raw
  millisecond subtraction so "yesterday" can't flip to "2 days ago" purely from time-of-day. Renders as
  `2026-08-13 (3 dni temu)` next to the `Calendar` icon from finding 4.
  - **Split on a second pass, on review**: the day/week/month/year bucketing (`<7`/`<30`/`<365`
    thresholds) is language-independent — every locale would pick the same bucket for the same input —
    so it moved to `relativeTimeBucket()` in `lib/format.ts`, returning `{ unit, value }` rather than a
    string. `relativeTime()` in `copy/pl.ts` now only turns that bucket into Polish words (reusing the
    same 1 / 2-4-excl.-12-14 / 5+ plural-class shape `pluralChars` already established for
    password-length copy, generalised into `pluralClass()`). First pass had put the bucketing thresholds
    inside `pl.ts` itself, which would have made a second locale copy-paste the same day-math instead of
    just supplying words — caught because a stray comment ended up explaining English control flow by
    naming the Polish word it produced, a sign the function was doing two jobs.
  - **Deliberate exception to this file's "deterministic, locale-free" rule.** Every other date helper
    in `format.ts` is frozen so SSR and hydration always agree; `daysSince` defaults to the real clock
    on purpose, because a relative age is supposed to change on its own as time passes — freezing it
    would defeat the point. Documented in the function's own comment: the only cost is a hydration
    mismatch if the SSR-to-hydration gap (milliseconds, on `client:load`) straddles a UTC midnight,
    which React reconciles as one harmless single-frame correction. Accepted rather than engineered
    around, the same way this file already accepts one other small-probability date-off-by-one cost.

- **Finding 6 — the pending card showed no thumbnail while generating (fixed, presentational only).**
  User's question: could we "borrow" a YouTube thumbnail before real metadata exists? Turned out the
  free, ID-derived thumbnail (`i.ytimg.com/vi/<id>/hqdefault.jpg`, no vendor call, no persisted data)
  was already implemented — but only for the `"needs-confirmation"` cost-gate status, per the design
  decision recorded in this file's 2026-08-11 correction ("derived thumbnail … same answer for the
  pending card"), which never actually reached the plain `"generating"` status. `PendingSummaryCard.tsx`
  even carried a stale comment framing this as deliberate ("no thumbnail outside the cost-gate state").
  Generalised: `youtubeId = extractYoutubeId(pending.url)` computed once, unconditionally, replacing the
  gate-only `gateYoutubeId` derived from `confirm.url` — safe, since `DashboardSummaries.tsx` sets
  `pending.url = attempt.url` for every status and `useGenerateSummary.ts` shows `attempt.url` and
  `confirm.url` are always the same value for one attempt. The thumbnail now renders in every status
  (user's choice, via AskUserQuestion): generating, needs-confirmation, saved, saved-refresh-failed, and
  failed. Rewrote the stale comment to say what's actually true: never a *real* thumbnail before
  something is saved, but the derived one needs no saved data so it was never actually blocked by that
  rule.

**Findings 2-6 deployed together (2026-08-14).** `db push --linked` (the queued `channel_id_correction`
migration) immediately followed by `wrangler deploy`, back-to-back per this file's own established
discipline. Live at `https://10x-media.nightshiftlab.workers.dev`, version `88cac879-c449-4463-bb64-7d502ddea092`.

**Findings 7-8 deployed together (2026-08-14).** No schema changes this round — `wrangler deploy` only.
Live at `https://10x-media.nightshiftlab.workers.dev`, version `035c6fa6-f701-4ebd-8e5a-2207a10ca923`.

**Finding 9 (heading fix + full Markdown element coverage) deployed 2026-08-15.** No schema changes —
`wrangler deploy` only (new `remark-gfm` dependency, no DB impact). Live at
`https://10x-media.nightshiftlab.workers.dev`, version `59d20d79-717f-45f7-9ddc-d78038d68163`.

**Findings 10-11 deployed together (2026-08-15).** No schema changes — `wrangler deploy` only. Live at
`https://10x-media.nightshiftlab.workers.dev`, version `f616dc69-5ae3-416e-ab82-9b0aedafad8d`.

- **Finding 7 — summary reading column sat left-flush inside a wider card (fixed, presentational
  only).** User's screenshot from production: the expanded body text stops well short of the card's
  right edge with no counterbalancing space on the left, while the header row above it (thumbnail +
  title + character badge) spans the card's full width — the mismatch reads as unfinished rather than
  deliberate. Confirmed via exploration: `SummaryCard.tsx`'s expanded-content wrapper carries
  `max-w-[62ch]` with no `mx-auto`, and it's the only place in the app `SummaryMarkdown` renders (the
  component's own doc comment referencing "the generate form's result block" was stale — no such block
  exists; `PendingSummaryCard.tsx` explicitly never shows the body, `GenerateSummaryForm.tsx` doesn't
  render one either). Checked the design system's own spec (`ds-bundle/type.html`,
  `visual-direction-outcome.md`): both define the `62ch` measure and 16.5/28 type metrics for
  readability, but neither says anything about horizontal centering — the reference mockup itself
  renders left-flush too, but only because its own specimen container was never tested at a ~736px card
  width. This was an undescribed gap in the spec, not a considered decision to leave uncentered. Fixed
  by adding `mx-auto` to the wrapper (`SummaryCard.tsx`) — the `62ch` cap itself is untouched, only its
  horizontal position changes; no effect at the mobile/squeeze widths where the card is already narrower
  than 62ch. Also corrected `SummaryMarkdown.tsx`'s stale doc comment while in the area.

- **Finding 8 — "Doładuj" button jumped left when the top-up notice appeared (fixed, presentational
  only).** User's screenshot from `/account`. Root cause chain, confirmed by exploration:
  `account.astro`'s credit row is `flex items-center justify-between` — with `justify-between` and two
  items, the second item's *right* edge is always pinned to the row's right edge regardless of its own
  width. `TopUpAction.tsx`'s root was a bare `<div>` (no classes), so the `Button` sat at its *left*
  edge in normal block flow. When `useTopUpAction`'s `revealed` flips true, `TopUpNotice` — visibly
  wider than the button — mounts underneath, forcing the div to grow; since its right edge is pinned,
  it grows leftward, dragging the left-anchored button with it. `items-center` on the row compounded it:
  once the right-hand item got taller (button + notice stacked), the "Kredyty N" label re-centered
  against that new height and visibly sank. (`AccountMenu.tsx`'s dropdown version never hits this: there
  the notice is a sibling inside a fixed-width Radix popover, not a shrink-to-fit flex item — different
  container, not a pattern to copy here.)
  - Fix: `TopUpAction.tsx`'s root div → `flex flex-col items-end`, so the button and notice share the
    same right edge instead of the same left edge — the already-pinned right edge means the button's
    position never changes when the notice mounts. `account.astro`'s row → `items-start`, so the label
    stays aligned with the top of the button instead of re-centering against a taller sibling.
  - **Accepted minor side effect**: in the resting state (no notice), the button and the single-line
    label now align at the top instead of centered — a few px, typical for this label-next-to-a-control
    pattern, not corrected further.
  - `TopUpNotice`'s own `mt-2` and `useTopUpAction`/`AccountMenu.tsx` untouched — `TopUpNotice` is shared
    with the dropdown, which still depends on that margin for its own spacing.

- **Finding 9 — headings disappeared into the surrounding body text (fixed, presentational only).**
  User's framing: "technically fine, but doesn't read as legible" — headings less visible than other
  elements. Confirmed by exploration: `SummaryMarkdown.tsx`'s `h3` rendered at **14px** (`text-sm`) —
  smaller than the 16.5px body text and the 16.5px `strong` lead-ins it sat among. Not a taste question:
  a heading literally smaller than its own body text is a measurable defect. `h3` is also the *only*
  heading level reachable in practice — the `educational` prompt (`llm.ts:61-63`) permits only `### `,
  and `informational` (`llm.ts:32-34`) permits none at all (h1's rare appearance, per Finding 3, is
  model non-compliance, not a sanctioned path).
  - **The design system already had the answer.** `ds-bundle/type.html`'s `.body-spec h3` — the one
    example that actually covers a heading *inside* the reading surface, as opposed to page-level UI
    chrome — specs `18px/600/1.35` in `IBM Plex Sans`, explicitly keeping `--font-display` (Space
    Grotesk) out of summary bodies. Phase 4's plan (`plan.md:575-586`) only carried the *body* spec into
    its contract ("Headings take `--foreground}`", no size), so the `text-xl/lg/sm` choice in code was
    never checked against this and landed wrong.
  - **User's call (before implementing): the literal 18px alone (only 1.5px over body, same weight as
    `strong`) still risked reading as weak — go with the doc's 18px as the base plus an explicit
    breathing-room channel, not size alone.** Implemented: `h3` → 18px/600/1.35 (matches the doc
    exactly); `h2`/`h1` scaled up proportionally (20px/22px) so they don't collide with the corrected
    `h3`; and `pt-2` added to all three heading levels for extra space *before* a heading specifically.
  - **One easy-to-miss correctness detail, documented in the component now:** the extra spacing had to
    be `pt-2` (padding), not `mt-2` (margin). The parent's `space-y-2` is implemented via a
    `> :not([hidden]) ~ :not([hidden])` selector, whose specificity beats a plain `.mt-2` utility on the
    child — a margin-based attempt would have been silently overridden with no visible effect. Padding
    isn't touched by `space-y-*`, so it stacks on top of the existing gap instead.
  - `npm run lint:tokens` only guards hardcoded *colors*, not font-size/weight utilities, so this fix
    needed no exception there. Zero changes to `llm.ts`'s prompts — out of scope for a presentational fix.

- **Finding 9 (follow-up) — full Markdown element coverage, not just headings (fixed, presentational
  only + one new dependency).** User's question after the heading fix: since the model doesn't reliably
  stay within the syntax its prompts demonstrate, could other tags have the same problem? Confirmed with
  direct production evidence, not just theory: two separate real generations under the `informational`
  prompt (which requests **no** headings at all) produced two different unrequested heading levels — H1
  once (Finding 3), H2 once (`context/changes/generate-and-save-summary/reviews/manual-e2e-2026-07-23.md:18`).
  Audited every element plain CommonMark and GFM can produce against `SummaryMarkdown.tsx`'s 10-element
  allow-list:
  - **Reachable with zero plugins, previously unhandled:** `h4`-`h6`, `blockquote`, `hr`, `br`, fenced
    code blocks. Headings/blockquotes at least kept their text when unwrapped; `hr`/`br` are childless
    nodes, so unwrapping them **deleted them with no trace** — worse than a styling miss.
  - **GFM wasn't wired in at all** (`react-markdown` on bare `remark-parse`) — tables, strikethrough,
    and task lists didn't parse as those node types, degrading to literal source characters (`| a | b |`,
    `~~x~~`, `[ ] text`) inside an ordinary paragraph. Tables were flagged as the realistic risk: content
    comparing things (exactly what the Finding-9 screenshot's video was about — AI model comparisons) is
    a natural fit for a table.
  - User chose the full-scope fix (over the minimal CommonMark-only option, and over waiting for a real
    production sighting the way headings were): added `remark-gfm` and extended both the allow-list and
    the styled component map to cover `h4-h6` (flattened to `h3`'s exact treatment — no deeper level is
    sanctioned by either prompt, so there's nothing to scale toward and no risk of re-landing below body
    size), `blockquote` (left border + italic + muted, the same non-hue differentiation `CharacterBadge`
    already uses), `hr` (a real divider instead of vanishing), `br`, `pre` (safety net for a fenced block
    despite both prompts explicitly forbidding it), and the full `table`/`thead`/`tbody`/`tr`/`th`/`td`
    family (wrapped in `overflow-x-auto` so a wide comparison table scrolls inside the card at
    squeeze/mobile widths instead of forcing the card wider), `del` (strikethrough), and `input` (GFM
    task-list checkbox, always `disabled` — this is rendered content, not a form).
  - **Security check, verified not just reasoned about**: `remark-gfm` auto-linkifies bare URLs into `a`
    nodes. Confirmed via an isolated `renderToStaticMarkup` test (fixtures for every new element, run
    with a temporary, unsaved `tsx` install, then deleted) that `allowedElements`/`unwrapDisallowed`
    still catches these exactly like a hand-typed `[text](url)` — a bare `www.example.com` /
    `https://example.com/path` rendered as plain text, not a clickable link, and the existing malicious
    link/image fixture still stripped exactly as before. `allowedElements` runs at the final
    React-rendering step, after every remark/rehype plugin, so it was always going to catch plugin-
    produced nodes the same way — confirmed empirically rather than left as an assumption.
  - Same render test confirmed every other new element (h4-h6, blockquote, hr, hard break, table,
    strikethrough, task-list checkboxes, fenced code) renders with real structure/styling instead of
    vanishing, merging, or showing raw syntax characters.
  - `npm run lint:tokens` still passes — every new class reuses existing `--border`/`--foreground`/
    `--muted-foreground`/`--muted` tokens, no new colors. Zero changes to `llm.ts`'s prompts.

- **Finding 10 — the browser scrollbar disappears when the account dropdown opens, shifting the whole
  page a few px right (fixed, presentational only).** Exploration traced the full chain: `AccountMenu.tsx`
  uses Radix `DropdownMenu` with the default `modal: true`, so opening it scroll-locks the page via
  `react-remove-scroll`/`react-remove-scroll-bar` (both current versions, working as designed). That
  library measures the scrollbar's width and injects `body[data-scroll-locked] { overflow: hidden
  !important; margin-right: {gap}px !important; }` — sized to compensate an `auto`-width body so nothing
  visibly moves. But `Layout.astro:69-76`'s scoped `<style>` pins `html, body` to an **explicit**
  `width: 100%`, not `auto` — on an explicitly-sized box, adding `margin-right` doesn't shrink it to
  compensate, it just adds margin outside a box that's already full width, while the real scrollbar
  vanishing simultaneously frees up that same width in the viewport. Net effect: centered/full-width
  content recomputes against a viewport that's temporarily wider, and shifts right.
  - **Root cause, one level deeper than the `width: 100%` interaction:** nothing anywhere in the project
    (`global.css`, `Layout.astro`, Tailwind v4's own preflight — all checked) reserves scrollbar gutter
    space, so the scrollbar's presence/absence is free to change available content width at all — that's
    the actual enabler of the whole bug class, not just this one interaction.
  - Fix: `scrollbar-gutter: stable;` on `html`, added to `global.css`'s existing `@layer base` block next
    to the base `body` rule. Reserves the gutter permanently, so hiding/showing the scrollbar never
    changes available width — removes what Radix's margin compensation was trying to fix in the first
    place, rather than patching that compensation. As a direct consequence, `react-remove-scroll-bar`'s
    own gap measurement reads 0 once locked (no width difference to detect), so the injected
    `margin-right` becomes a no-op — `Layout.astro`'s `width: 100%` didn't need touching.
  - Also fixes the same shift for `DeleteAccountDialog`'s Radix `Dialog` (same default `modal: true`,
    same scroll-lock mechanism) — one shared root cause, one shared fix, no component-level changes.

- **Finding 11 — post-login/confirmation redirect landed on the marketing page, not summaries (fixed).**
  User's framing: an unnecessary extra step, since the user almost always clicks through to `/summaries`
  anyway. Confirmed both sign-in (`signin.ts:19`) and the sign-up email-confirmation callback
  (`callback.ts:31`) shared the identical `context.redirect("/")` pattern on success — a plain
  server-side redirect the native form POST just follows, no client-side logic involved. No prior design
  decision existed either way (`wireframe-outcome.md` only settles what `/` *shows* per auth state — a
  CTA swap in `Welcome.astro`, no capture bar — never what happens right after the auth action itself).
  User confirmed (before implementing): fix both call sites for one consistent "you're authenticated →
  you land in summaries" rule, rather than leaving sign-up's confirmation link on the old behavior while
  only sign-in changed. Both now `context.redirect("/summaries")`.
  - **Deliberately untouched:** `Welcome.astro`'s existing CTA swap for a signed-in visitor and
    `middleware.ts` (`/` stays outside `PROTECTED_ROUTES`) — a signed-in user can still visit `/`
    directly (bookmark, shared link) and see the landing page with its "Przejdź do podsumowań" CTA.
    This fix only changes where the *action itself* (sign-in submit, confirmation link click) lands
    immediately after succeeding, not general access to `/`.

### Manual QA — phase 9 (2026-08-14)

All manual verification items for phase 9 in `plan.md` (9.5-9.9) are now checked off, driven live in
Chrome against a synthetic `ads-qa-p9@example.com` account created for this pass.

- **Technique**: fault-injected `generate.ts`'s `fetchTranscript` call (temporary one-line swap to a
  literal `{ ok: false, reason: ... }`, reverted immediately after each sub-test and confirmed via
  `git diff` showing no residual change) to force the `unavailable` (9.5/9.6) and `failed` (9.7) outcomes
  deterministically, without a real Supadata call. 9.6's replay was driven by intercepting `window.fetch`
  client-side to let the real request land server-side then throw instead of resolving — simulating
  "request delivered, reply lost" — so the idempotency key survived for the resubmit. 9.8 reused the same
  interception technique to strip the `charged` field from a real response before it reached the hook.
- **9.5**: server confirmed `422` + `charged: true` + the caption-less copy; the UI card showed the
  server's message plus "Za tę operację pobrano kredyt."
- **9.6**: the resubmitted request (same `requestId`) hit `respondToRepeatedRequest`'s replay branch and
  answered `charged: true` with the same generic copy as a first-time charge — no second debit (credits
  unchanged across both attempts).
- **9.7**: server confirmed `422` + `charged: false` + the generic transient copy; UI showed "Nie pobrano
  kredytu za tę operację."
- **9.8**: with `charged` stripped from the response, the card rendered neither the charged nor
  not-charged line — confirmed silent on money, per the hook's `typeof payload.charged === "boolean"`
  contract.
- **9.9**: light regression sweep (phase 9's diff only touches the generation/failure-copy path) —
  summaries list/filters/expand-collapse, account page, landing signed-in/signed-out, and sign-in all
  rendered correctly.

**Real-cost incident, recorded for future QA sessions in this repo.** Before the fault-injection timing
was sorted out, three requests landed on pre-edit or cache-warmed code paths and ran for real: a stale
Vite dependency-reoptimization window (same class of issue as the phases 4-6 note below) let two
submissions execute against the OLD `generate.ts` before the edit was picked up, and a third
("PSY - Gangnam Style") hit a warm shared-transcript cache from earlier phase testing and bypassed the
mock entirely even though the code was current. ~3 credits and a small real Supadata/OpenRouter spend
were consumed unintentionally. **Fix applied**: after any edit to an API route under this dev setup, kill
and restart the dev server fully (don't rely on hot-reload) and verify the change is live via a
zero-risk `fetch` probe from the console before submitting through the UI — and use clearly fake,
guaranteed-unique video IDs (e.g. `qa9fake001x`) for any mocked-transcript test, since a real or
previously-tested video ID can carry a warm cache that silently bypasses the fault injection. The
synthetic test account was topped up via `npm run grant-credits` (local dev only) after burning through
its starting balance.

### Manual QA — phases 7-8 (2026-08-14)

All manual verification items for phases 7-8 in `plan.md` (7.3-7.7, 8.3-8.6) are now checked off,
driven live in Chrome against a freshly restarted local dev stack with a synthetic
`ads-qa-p78@example.com` account created and deleted as part of the flow itself.

- **Restarted the dev server before testing**, per the phase 4-6 lesson below: `2a9c04d` (this morning)
  touched `src/pages/api/account/delete.ts`, an API route, and the server had been running since the
  day before. The very first page load after restart threw an `Invalid hook call` in `AccountMenu.tsx`
  — Vite mid-flight dependency re-optimization on cold start, not an app bug. A reload cleared it and
  it did not recur.
  Verified the landing page renders correctly signed-in and signed-out, and that the account menu
  (Konto / Doładuj / Wyloguj się) works, before treating the page as stable.
- **7.5 (dialog cannot be dismissed while a deletion is in flight)** used the same fault-injection
  technique as phases 4-6: a temporary `await new Promise(r => setTimeout(r, 5000))` in
  `delete.ts` before the `admin.auth.admin.deleteUser` call, reverted immediately after confirming
  the locked state via screenshot, with `git diff` on the file confirming a clean revert before
  moving on. Escape, an overlay click, and the close (×) button were all tried against the
  `Usuwanie…` loading state and none dismissed the dialog.
- **7.6 / 8.6** were verified together: the same deletion run in the 7.5 test redirected to `/` and
  showed the toast; a second navigation to `/` confirmed it does not repeat (one-shot
  `account_deleted` cookie consumed on first read).
- **7.7**: console-verified exactly one `[unsupported-feature] {"feature":"top-up"}` warning from
  `src/lib/services/reporting.ts` on clicking the account page's `Doładuj` button — same event key
  the topbar's `AccountMenu` emits, confirming the shared `useTopUpAction` hook.

### Manual QA — phases 4-6 (2026-08-13)

All manual verification items for phases 4-6 in `plan.md` are now checked off, driven live in Chrome
against the local dev stack with throwaway `@example.com` test accounts. Notes for future QA passes:

- **A stale dev server (started the prior day) was already listening on :4321** before this session
  started anything. It hot-reloaded most edits but silently ignored a `middleware.ts` change — Astro's
  dev server does not always hot-reload middleware the same way it does components/pages. Killed and
  restarted clean when a `credits` fault injection in `middleware.ts` had no effect after two reloads.
  Worth checking `netstat`/process start time before trusting "it didn't work" during future live QA.
- **Chrome autofilled the real signed-in-user credentials into `/auth/signin` on every page load** in
  this browser profile (saved credential matching the `localhost:4321` origin from prior manual use).
  Handled by always overwriting both fields with test credentials before any interaction and never
  submitting a form population came from autofill rather than typed input.
- **Fault injection (temporary `throw`, reverted immediately after screenshotting, confirmed via
  `git diff`) was used for three states that are impractical to hit organically**: 5.4's read-failed
  list (`summaries.astro`), 6.4's cost gate (`generate.ts` — padded a real fetched transcript past the
  40,000-char threshold rather than hunting for a real video in the 40k-200k char transcript window),
  and 6.8's unknown-balance shimmer (`middleware.ts`). Same technique the plan itself prescribes for 5.4.
- **6.6 (amber isolation)** was verified by grepping `--attention` usage across `src/` and confirming
  ghost/outline button and dropdown-menu hover states are `hover:bg-accent` in the untouched shadcn
  primitives — a visual hover screenshot on a dark-on-dark JPEG was too subtle to trust.
- **6.9**: navigating away before the debit landed aborted the in-flight request entirely (no card, no
  charge) rather than completing in the background — consistent with "no incorrect debit", the
  criterion's actual intent, even though the specific timing didn't exercise the "completes anyway"
  path. Cloudflare Workers' behavior on client disconnect mid-request was not investigated further.

Phases 7 (account), 8 (landing) and 9 (failure-copy branch + sweep guard) remain unimplemented — this
QA pass only closed out manual verification for already-shipped phases 4-6.

### Fix — capture bar row layout broke below ~1024px, and stayed broken above it too (2026-08-13)

Found by the user manually resizing Chrome to 640px during the QA pass above and screenshotting the
result: the three-part capture bar (URL field, character radiogroup, submit button) crammed into one
`sm:flex-row` (640px) row with no room, squeezing the URL input to a sliver and wrapping its error
message into a vertical column of single words.

**First attempt (raising the breakpoint to `lg:` / 1024px) did not actually fix it.** `summaries.astro`
wraps the page in `max-w-3xl` (768px) — the content column's width is capped there regardless of
viewport, so once a `flex-row` layout triggers at *any* viewport ≥ ~800px, the row only ever has ~702px
to work with. The radiogroup (~392px) and button (~208px) alone need ~624px of that, leaving ~78px for
the URL field — confirmed by re-testing at 1200px after the first "fix" and finding it just as broken.
Meaning: no breakpoint choice for a 3-way `flex-row` fixes this, because the container's max-width never
grows past 768px on any screen.

**Real fix**: `GenerateSummaryForm.tsx` now puts the URL field on its own full-width row, with the
character radiogroup and submit button sharing a second `sm:flex-row` row below it (their combined
~624px fits comfortably inside the ~702px available). Verified at 640px, ~657px (Chrome's practical
desktop minimum), 960px and 1200px — URL field always full-width, error message always one line.

**Lesson for future responsive checks in this codebase**: a component's own breakpoint classes are not
enough evidence — check the width of its actual containing element (`max-w-3xl` pages cap at 768px
regardless of viewport) before concluding a `sm:`/`lg:` bump fixes a squeeze.

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
