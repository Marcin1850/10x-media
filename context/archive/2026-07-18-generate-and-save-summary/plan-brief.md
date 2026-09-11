# Generate and Save a Video Summary (S-01) — Plan Brief

> Full plan: `context/changes/generate-and-save-summary/plan.md`
>
> **Resynchronized 2026-07-23 (impl-review F25)** with the accepted post-review fixes F1–F24. This brief is the compressed *current* contract, not the as-originally-planned one; superseded decisions are named inline where the change is load-bearing, and the full history lives in `reviews/` plus the amendment notes in `plan.md`.

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
| Credit model | **Debit before the paid LLM call, as a durable reservation; refund on any failure** | The atomic `UPDATE … WHERE balance >= cost` is the race-safe gate; a ledger row (not a bare decrement) means a failed compensation leaves a recoverable debt, not a silent charge | Plan (F1 → F9) |
| Debit RPC | `begin_generation(target_user, request, amount)` — claims the idempotency key **and** opens the reservation in one transaction | Deciding "new or repeat?" and acting on it must be one transaction, or two concurrent duplicates both decide "new" | Plan (F22) |
| Persistence | `persist_summary()` — upsert video + insert linked summary + settle the reservation, atomically | Separate insert/settle left the ledger indistinguishable from failed work for the whole LLM call, and a deletable summary is mutable billing evidence | Plan (F16, F23) |
| Refund privilege | `refund_reservation(user_id, reservation_id)` granted to **`service_role` only**, via the admin client | A refund raises a balance, so a user-callable one would let anyone self-credit; keying it to a reservation means a retry can't credit twice | Plan (F1, F9) |
| Concurrency | One generation in flight per user via an **owner-scoped lease** (`acquire`/`release_generation_lease` with an opaque lease id) | Without it every concurrent request pays for its own transcript fetch before the debit rejects it; the lease id stops a displaced request from unlocking its successor | Plan (F4, F10) |
| Provider-spend guards | Per-user transcript rate cap (10 / 10 min, fails **closed**) + a 10-min transcript **quote** reused by the confirmation retry | The 409 returns before any debit, so an unguarded confirm loop is free unbounded Supadata spend | Plan (F17, F24) |
| Migration strategy | **Expand/contract**: nine expand-only forward migrations, each leaving its predecessor in place; **Phase 8** drops all six superseded RPCs together after the new Worker is live | Dropping alongside the expand opens a deploy window (DB-first breaks the running Worker, Worker-first calls a missing RPC); one shared precondition means one contract migration | Plan (F3, F22) |
| Summary rendering | Markdown via `react-markdown` behind an element allow-list (`unwrapDisallowed`, no raw HTML) | LLM output is untrusted — `img`/`a` would give a transcript-steered model a fetch or navigation target | Plan (F2) |
| Long-video cost | >40k chars ⇒ 2 credits (char count as proxy) | Cheap to measure; coarse budget signal, not exact billing | Plan |
| Hard length cap | >200k chars ⇒ reject with 413 before any debit/LLM call | `summaryCost` only prices; this is what actually bounds worst-case token cost/latency | Plan (F5) |
| Confirm mechanism | Up-front toggle **and** 409 "Generate anyway" — both set `allowLong` | Toggle for known-long videos; button as the safety net | Plan |
| UI surface | Form + result on `/dashboard` | One protected surface the user already lands on; credits + generation together | Plan |
| Result/error UX | Inline below the form, per-status messages, inputs kept | Self-contained; no detail page (S-02 territory) | Plan |
| UI copy | English (incl. translating existing Polish chrome) | Consistent chrome; summaries stay Polish | Plan |
| LLM prompts | Rewrite to PRD's two shapes; **authored in English, output Polish** | Biggest lever on the 75% "good-enough" metric; English instructions are followed reliably | Plan |
| Testing | Manual only | Roadmap defers testing to Module 3 | Roadmap |

## Scope

**In scope:** English-copy cleanup; the credit-ledger migrations (variable spend → reservation ledger → summary↔reservation link → atomic persist+settle → idempotency key, all expand-only); the generation-lock lease; transcript spend guards and quote lifecycle; length→cost policy + hard-max cap; endpoint rename with debit-before-LLM / refund-on-failure and 502/500/413/429 handling; `allowLong` + 409 confirmation + cost-aware 402; dashboard generation island with live credit count, Markdown rendering, and a client-owned idempotency key; prompt rewrite and manual quality pass; the **Phase 8** contract migration dropping all six superseded RPCs (deploy-gated — applied to cloud only after the phases 1–7 Worker is live).

**Out of scope:** browse list (S-02); delete (S-03); design system (S-06); summary detail/permalink; storing per-summary cost; video metadata; streaming; tests; any change to F-01's *existing* columns or RLS.

*Two original exclusions were reversed during implementation:* **Markdown rendering** was pulled in during the Phase 7 quality pass (summary content formatting, not app design — S-06 is unaffected), and **`summaries.reservation_id`** was added as an *additional* nullable column (F16) to carry billing provenance. No existing F-01 column, constraint, or policy was altered.

## Architecture / Approach

`GenerateSummaryForm` island → `POST /api/summaries/generate` (preflight: both provider keys **and** the service-role admin client, else 503 — without the admin client the refund path can't run at all):

0. **generation lease** (`acquire_generation_lease`) — contention → 429; released in a `finally` with its lease id
1. **idempotency probe** `begin_generation(…, amount: null)` when the client sent a `requestId` — `replay` → 200 with the original summary, `in_progress` → 429, `unavailable` → 409; fails **closed** on error. Before the paid fetch, since the work can't be priced until the transcript exists
2. **min-1 credit read gate** (402 at 0) — before any paid call
3. **transcript**: quote cache hit (on `allowLong`) → free; else rate limit (429 when capped, fails **closed**) → `fetchTranscript` (502 on failure, 422 if unavailable **or** whitespace-only)
4. `summaryCost(length)`; **413 if length > 200k** (hard cap, before any debit/LLM)
5. **409 confirmation** if long & not `allowLong` — caches the transcript as a quote first; no debit
6. **atomic idempotent debit** `begin_generation(…, amount: cost)` — the race-safe cost *and* identity gate; `insufficient` → 402, repeat outcomes mapped as in step 1
7. `summarize` (300s deadline; 502 on failure) → `persist_summary()`: video + linked summary + settle in **one transaction** (stable 500). **On any failure here, `refund_reservation`** so the user isn't charged
8. `discard_transcript_quote` on success (the quote's round-trip is over)
9. `200 { summary, cost, creditsRemaining, transcriptLength, … }`

The endpoint stays thin; the durable reservation ledger, the idempotent debit, the atomic persist+settle, and the provider-spend guards are the primitives that carry the correctness.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Copy → English | `config-status.ts` + `Layout.astro` banner in English | (low) chrome only |
| 2. DB variable spend + refund | Shipped `spend_credits(amount)` + `refund_credits(user_id, amount)`; both since superseded by the reservation ledger and `begin_generation` | Least-privilege (refunds are service_role-only) / migration correctness |
| 3. Cost policy | `summaryCost()` + 40k threshold + 200k hard-max | (low) pure function |
| 4. Endpoint rename & harden | `generate.ts`, debit-before-LLM + refund-on-failure, 502/500/413 handling, stale-ref cleanup | Error-path mapping; no stale `probe` refs |
| 5. Confirmation gate | `allowLong` + 409 (before debit) + cost-aware 402 | ~~Double transcript fetch on confirm~~ — eliminated by the F17 quote cache |
| 6. Dashboard UI | Island: form, inline Markdown result, errors, confirm, live credits, idempotency key | Loading UX for slow Whisper jobs; browser matrix |
| 7. Prompt engineering | PRD's two output shapes, English prompt → Polish output | Final manual prompt-quality iteration vs the 75% bar |
| 8. Contract migration | Drops all **six** superseded RPCs and the dead `reserveCredits` wrapper | **Deploy-gated** — apply to cloud only after the phases 1–7 Worker is live; may land in a separate commit/PR |

*Post-review work (F1–F24) landed as fixes on top of phases 1–7 rather than as new phases: the reservation ledger, the owner-scoped lease, the summary↔reservation link and reconciliation, transcript spend guards and quote lifecycle, atomic persist+settle, and the idempotency key.*

**Prerequisites:** local Supabase running (migration) + Supadata/OpenRouter keys set (manual E2E). Backend proven in F-02; F-01/S-05 schema live.
**Estimated effort:** ~2–3 sessions across 8 thin phases (backend phases are curl-verifiable; the UI phase is the substance; Phase 8 is a one-line migration gated on deployment).

## Open Risks & Assumptions

- **Prompt quality is judged manually** — Phase 7 intentionally comes last and needs spot-checks of both characters to trust the 75% bar; no automated guard.
- **Char count is a token proxy** — accepted; the 2-credit surcharge is a coarse signal, not exact billing.
- ~~**Confirm path re-fetches the transcript**~~ — resolved by the F17 quote cache; a re-fetch now happens only on a quote miss/expiry. A race-losing request may still pay the cheaper transcript fetch, now bounded by the per-user rate cap.
- **Expand/contract migrations must reach cloud in order** — all nine expand migrations must be pushed to the cloud project before/with the Worker deploy; the six-RPC drop is **Phase 8's contract migration**, run only after the new Worker is confirmed live (folded in from the former roadmap `S-01-fu` and widened).
- **Refund is best-effort, but the debt is durable** — `refundReservation` still logs and resolves without throwing (so it never masks the original failure), but a failed refund now leaves the row in `reserved`: a queryable debt recoverable via `reconcile_reservation()`, not a silent charge. The service-role key being unset is no longer an edge case here — the endpoint refuses with 503 in preflight.
- **Unbounded summary length is an unmeasured cost vector** (Phase 7 amendment) — cost is priced off transcript length (input) only, so a fact-dense video yields a long, more expensive completion at the same credit price. Revisit if per-summary cost drifts.
- **Manual acceptance evidence is still pending** (F8/F15) — 16 manual items across Phases 1–6 plus the post-review scenarios remain unchecked; this is the accepted release gate, not a code defect.

## Success Criteria (Summary)

- A user generates a Polish, character-appropriate summary from a URL on the dashboard and it is saved; the credit count decrements (1 normal, 2 long).
- Long videos require and honor confirmation (reusing the cached transcript, not re-fetching it); over-long videos are rejected (413); 0-credit users are blocked; missing, empty, or unavailable transcripts and upstream failures surface clear messages with the balance net-unchanged (any debit is refunded, and a failed refund leaves a recoverable `reserved` row rather than a silent charge).
- A retried POST carrying the same `requestId` replays the original summary — no second charge, no second OpenRouter call, no second row.
- Verified end-to-end on latest Chrome and Firefox.
