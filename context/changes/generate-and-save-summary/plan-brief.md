# Generate and Save a Video Summary (S-01) — Plan Brief

> Full plan: `context/changes/generate-and-save-summary/plan.md`

## What & Why

S-01 is the roadmap's north star: prove the product's core loop — paste a YouTube URL, pick the channel character (informational or educational), get a Polish summary, and save it. The transcript→LLM→persist backend already works (built and verified live during the F-02 probe); this slice turns that spike into the user-facing feature and carries F-02's three deferred follow-ups.

## Starting Point

The full pipeline exists in `POST /api/summaries/probe` (auth, validation, credit gate, transcript, summarize, append-only save, spend). Services (`transcript`/`llm`/`summaries`/`credits`) and the F-01/S-05 schema (videos, summaries, user_credits with RLS) are done. What's missing: any generation **UI** (the dashboard only shows a credit count), a production endpoint name, the long-video cost path, upstream-error handling, and real prompt engineering (current prompts are one-liners).

## Desired End State

A signed-in user on `/dashboard` fills a form (URL + character + "allow long videos" toggle), submits, and sees the Polish summary inline while the credit count decrements. Long videos (>40k transcript chars) cost 2 credits with a confirmation step; every failure surfaces as a clear English message. The `probe` route is gone, replaced by `POST /api/summaries/generate`.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) | Source |
| --- | --- | --- | --- |
| Endpoint | Rename `probe` → `/api/summaries/generate`, harden in place | Probe was a spike name; F-02 always intended S-01 to keep the services | Plan |
| UI surface | Form + result on `/dashboard` | One protected surface the user already lands on; credits + generation together | Plan |
| Result/error UX | Inline below the form, per-status messages, inputs kept | Self-contained; no detail page (S-02 territory) | Plan |
| UI copy | English (incl. translating existing Polish chrome) | Consistent chrome; summaries stay Polish | Plan |
| LLM prompts | Rewrite to PRD's two shapes; **authored in English, output Polish** | Biggest lever on the 75% "good-enough" metric; English instructions are followed reliably | Plan |
| Long-video cost | >40k chars ⇒ 2 credits (char count as proxy) | Cheap to measure; coarse budget signal, not exact billing | Plan |
| Confirm mechanism | Up-front toggle **and** 409 "Generate anyway" — both set `allowLong` | Toggle for known-long videos; button as the safety net | Plan |
| Testing | Manual only | Roadmap defers testing to Module 3 | Roadmap |

## Scope

**In scope:** English-copy cleanup; `spend_credits(amount)` migration; length→cost policy; prompt rewrite; endpoint rename + 502 upstream handling; `allowLong` + 409 confirmation + cost-aware 402; dashboard generation island with live credit count.

**Out of scope:** browse list (S-02), delete (S-03), design system (S-06), summary detail/permalink, storing per-summary cost, video metadata, markdown rendering, streaming, tests, any F-01 schema/RLS change.

## Architecture / Approach

`GenerateSummaryForm` island → `POST /api/summaries/generate` → **min-1 credit gate** → `fetchTranscript` (502 on failure, 422 if unavailable) → `summaryCost(length)` → **409 if long & not allowed** → **cost gate (402)** → `summarize` (502 on failure) → append-only persist → `spend_credits(cost)` (best-effort post-save) → `200 { summary, cost, creditsRemaining, … }`. The endpoint stays thin; cost policy and the atomic variable spend are the two new primitives.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Copy → English | `config-status.ts` + `Layout.astro` banner in English | (low) chrome only |
| 2. DB variable spend | `spend_credits(amount)` RPC, retire `spend_credit()` | Least-privilege / migration correctness |
| 3. Cost policy | `summaryCost()` + 40k threshold | (low) pure function |
| 4. Prompt engineering | PRD's two output shapes, English prompt → Polish output | Prompt quality vs the 75% bar |
| 5. Endpoint rename & harden | `generate.ts`, computed-cost spend, 502 handling | Upstream-error mapping; no stale refs |
| 6. Confirmation gate | `allowLong` + 409 + cost-aware 402 | Double transcript fetch on confirm (accepted) |
| 7. Dashboard UI | Island: form, inline result, errors, confirm, live credits | Loading UX for slow Whisper jobs; browser matrix |

**Prerequisites:** local Supabase running (migration) + Supadata/OpenRouter keys set (manual E2E). Backend proven in F-02; F-01/S-05 schema live.
**Estimated effort:** ~2–3 sessions across 7 thin phases (backend phases are curl-verifiable; the UI phase is the substance).

## Open Risks & Assumptions

- **Prompt quality is judged manually** — Phase 4 needs spot-checks of both characters to trust the 75% bar; no automated guard.
- **Char count is a token proxy** — accepted; the surcharge is a coarse signal, not exact billing.
- **Confirm path re-fetches the transcript** — accepted MVP tradeoff; the up-front toggle avoids it.
- **Cloud migration push** — `spend_credits` must reach the cloud project before deploy, or generation breaks in prod.

## Success Criteria (Summary)

- A user generates a Polish, character-appropriate summary from a URL on the dashboard and it is saved; the credit count decrements (1 normal, 2 long).
- Long videos require and honor confirmation; 0-credit users are blocked; missing transcripts and upstream failures surface clear messages with no credit spent.
- Verified end-to-end on latest Chrome and Firefox.
