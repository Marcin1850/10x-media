# Generate and Save a Video Summary (S-01) — Plan Brief

> Full plan: `context/changes/generate-and-save-summary/plan.md`

## What & Why

S-01 is the roadmap's north star: prove the product's core loop — paste a YouTube URL, pick the channel character (informational or educational), get a Polish summary, and save it. The transcript→LLM→persist backend already works (built and verified live during the F-02 probe); this slice turns that spike into the user-facing feature and carries F-02's three deferred follow-ups (prompt engineering, transcript-length guard, upstream-error handling).

## Starting Point

The full pipeline exists in `POST /api/summaries/probe` (auth, validation, credit gate, transcript, summarize, append-only save, spend). Services (`transcript`/`llm`/`summaries`/`credits`) and the F-01/S-05 schema (videos, summaries, user_credits with RLS) are done. What's missing: any generation **UI** (the dashboard only shows a credit count), a production endpoint name, the long-video cost path, upstream-error handling, a hard length cap, and real prompt engineering (current prompts are one-liners). The existing `spend_credit()` RPC spends exactly 1 credit.

## Desired End State

A signed-in user on `/dashboard` fills a form (URL + character + "allow long videos" toggle), submits, and sees the Polish summary inline while the credit count decrements. Long videos (>40k transcript chars) cost 2 credits with a confirmation step; a pathologically long transcript (>200k chars) is rejected outright before any paid work (413). Every failure surfaces as a clear English message with inputs preserved for retry, and a failed generation never charges the user. The `probe` route is gone, replaced by `POST /api/summaries/generate`.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) | Source |
| --- | --- | --- | --- |
| Endpoint | Rename `probe` → `/api/summaries/generate`, harden in place | Probe was a spike name; F-02 always intended S-01 to keep the services | Plan |
| Credit model | **Debit before the paid LLM call (atomic reservation), refund on any failure** | The atomic `UPDATE … WHERE balance >= cost` is the race-safe gate; refund means no charge for failed work — replaces the probe's persist-then-best-effort-spend | Plan (F1) |
| Refund privilege | New `refund_credits(user_id, amount)` granted to **`service_role` only**, via the admin client | A refund raises a balance, so a user-callable one would let anyone self-credit | Plan (F1) |
| Migration strategy | **Expand/contract, two migrations**: this slice adds `spend_credits`+`refund_credits` and leaves `spend_credit()` in place; a follow-up migration drops it after the new Worker is live | Dropping `spend_credit()` now opens a deploy window (DB-first breaks old Worker, Worker-first calls a missing RPC) | Plan (F3) |
| Long-video cost | >40k chars ⇒ 2 credits (char count as proxy) | Cheap to measure; coarse budget signal, not exact billing | Plan |
| Hard length cap | >200k chars ⇒ reject with 413 before any debit/LLM call | `summaryCost` only prices; this is what actually bounds worst-case token cost/latency | Plan (F5) |
| Confirm mechanism | Up-front toggle **and** 409 "Generate anyway" — both set `allowLong` | Toggle for known-long videos; button as the safety net | Plan |
| UI surface | Form + result on `/dashboard` | One protected surface the user already lands on; credits + generation together | Plan |
| Result/error UX | Inline below the form, per-status messages, inputs kept | Self-contained; no detail page (S-02 territory) | Plan |
| UI copy | English (incl. translating existing Polish chrome) | Consistent chrome; summaries stay Polish | Plan |
| LLM prompts | Rewrite to PRD's two shapes; **authored in English, output Polish** | Biggest lever on the 75% "good-enough" metric; English instructions are followed reliably | Plan |
| Testing | Manual only | Roadmap defers testing to Module 3 | Roadmap |

## Scope

**In scope:** English-copy cleanup; `spend_credits(amount)` + `refund_credits(user_id, amount)` migration (expand-only); length→cost policy + hard-max cap; endpoint rename with debit-before-LLM / refund-on-failure and 502/500/413 handling; `allowLong` + 409 confirmation + cost-aware 402; dashboard generation island with live credit count; final prompt rewrite and manual quality pass.

**Out of scope:** the follow-up contract migration that drops `spend_credit()` (deferred until the new Worker is live); browse list (S-02); delete (S-03); design system (S-06); summary detail/permalink; storing per-summary cost; video metadata; markdown rendering; streaming; tests; any F-01 schema/RLS change.

## Architecture / Approach

`GenerateSummaryForm` island → `POST /api/summaries/generate`:

1. **min-1 credit read gate** (402 at 0) — before any paid call
2. `fetchTranscript` — 502 on failure, 422 if unavailable
3. `summaryCost(length)`; **413 if length > 200k** (hard cap, before any debit/LLM)
4. **409 confirmation** if long & not `allowLong` — before any debit
5. **atomic debit** `spend_credits(cost)` — this *is* the race-safe cost gate; insufficient sentinel → 402
6. `summarize` (502) → append-only persist (stable 500); **on any failure here, `refund_credits(cost)`** so the user isn't charged
7. `200 { summary, cost, creditsRemaining, transcriptLength, … }`

The endpoint stays thin; the cost policy, the atomic variable spend, and the compensating refund are the new primitives.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Copy → English | `config-status.ts` + `Layout.astro` banner in English | (low) chrome only |
| 2. DB variable spend + refund | `spend_credits(amount)` + `refund_credits(user_id, amount)` RPCs (expand-only; keeps `spend_credit()`) | Least-privilege (refund is service_role-only) / migration correctness |
| 3. Cost policy | `summaryCost()` + 40k threshold + 200k hard-max | (low) pure function |
| 4. Endpoint rename & harden | `generate.ts`, debit-before-LLM + refund-on-failure, 502/500/413 handling, stale-ref cleanup | Error-path mapping; no stale `probe` refs |
| 5. Confirmation gate | `allowLong` + 409 (before debit) + cost-aware 402 | Double transcript fetch on confirm (accepted) |
| 6. Dashboard UI | Island: form, inline result, errors, confirm, live credits | Loading UX for slow Whisper jobs; browser matrix |
| 7. Prompt engineering | PRD's two output shapes, English prompt → Polish output | Final manual prompt-quality iteration vs the 75% bar |

**Prerequisites:** local Supabase running (migration) + Supadata/OpenRouter keys set (manual E2E). Backend proven in F-02; F-01/S-05 schema live.
**Estimated effort:** ~2–3 sessions across 7 thin phases (backend phases are curl-verifiable; the UI phase is the substance).

## Open Risks & Assumptions

- **Prompt quality is judged manually** — Phase 7 intentionally comes last and needs spot-checks of both characters to trust the 75% bar; no automated guard.
- **Char count is a token proxy** — accepted; the 2-credit surcharge is a coarse signal, not exact billing.
- **Confirm path re-fetches the transcript** — accepted MVP tradeoff; the up-front toggle avoids it. A race-losing request may also pay the cheaper transcript fetch — same accepted tradeoff.
- **Expand/contract migration must reach cloud in order** — the expand migration (adds `spend_credits`/`refund_credits`) must be pushed to the cloud project before/with the Worker deploy; the `spend_credit()` drop is a **separate follow-up migration** run only after the new Worker is confirmed live.
- **Refund is best-effort** — if the service-role key is unset or the refund RPC errors, it logs and resolves without throwing, so it never masks the original failure returned to the user (but the debit may stand in that edge case).

## Success Criteria (Summary)

- A user generates a Polish, character-appropriate summary from a URL on the dashboard and it is saved; the credit count decrements (1 normal, 2 long).
- Long videos require and honor confirmation; over-long videos are rejected (413); 0-credit users are blocked; missing transcripts and upstream failures surface clear messages with the balance net-unchanged (any debit is refunded).
- Verified end-to-end on latest Chrome and Firefox.
