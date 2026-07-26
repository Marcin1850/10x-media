---
project: "10xMedia"
version: 1
status: draft
created: 2026-06-11
updated: 2026-07-25
prd_version: 1
main_goal: speed
top_blocker: external
---

# Roadmap: 10xMedia

> Derived from `context/foundation/prd.md` (v1) + auto-researched codebase baseline.
> Edit-in-place; archive when superseded.
> Slices below are listed in dependency order. The "At a glance" table is the index.

## Vision recap

Watching YouTube videos is time-consuming — when regularly following informational and educational channels, the list of potentially interesting content grows faster than the available time. Existing tools summarize single videos but don't help choose WHICH video is even worth watching. 10xMedia turns a video (after pasting a URL and selecting the channel character: informational or educational) into a Polish-language summary on the basis of which the user decides whether to watch or skip it.

## North star

**S-01: user generates and saves a video summary** — the smallest end-to-end flow that proves the product's core (YouTube transcript → Polish summary tailored to the channel character) works. With the "speed" goal, this is the only slice that must land to validate the PRD's single success criterion (75% of summaries "good enough").

> "North star" here means the smallest end-to-end flow whose successful delivery proves the product's core hypothesis — placed as early as dependencies allow, because everything else only matters if this works.

## At a glance

| ID   | Change ID                 | Outcome (user can …)                                         | Prerequisites | PRD refs                      | Status   |
| ---- | ------------------------- | ------------------------------------------------------------ | ------------- | ----------------------------- | -------- |
| F-01 | video-summary-schema      | (foundation) video/summary tables with per-user RLS          | —             | Access Control, NFR, FR-006   | done        |
| F-02 | transcript-llm-probe      | (foundation) transcript→LLM path verified on the Worker      | —             | FR-005, NFR                   | done        |
| S-01 | generate-and-save-summary | paste URL + pick character → get and save a Polish summary   | F-01, F-02    | US-01, FR-003, FR-004, FR-005 | done        |
| S-02 | browse-summary-list       | browse the list of saved summaries                           | S-01, S-08    | FR-006                        | ready to plan |
| S-03 | delete-summary            | delete a summary                                             | S-01          | FR-007                        | proposed |
| S-04 | delete-account            | delete their account and all associated data (GDPR)          | F-01          | Access Control, NFR (privacy) | done        |
| S-05 | summary-credits           | start with 5 credits; each generation spends one             | F-01          | — (cost guardrail)            | done        |
| S-06 | app-design-system         | use the app through a coherent, production-like UI           | S-02          | — (product polish)            | planned     |
| S-07 | summary-generation-telemetry | (observability) each summary records how long it took, what it cost, and keeps its transcript | S-01 | — (F-02 follow-ups F4/F5)  | proposed |
| S-08 | persist-video-metadata    | see the video's thumbnail, title, channel, length, upload date and language next to a summary | S-01          | FR-006 (list legibility)      | done — manual verification open |
| S-09 | transcript-cost-guardrail | (guardrail) no single video can silently drain the monthly Supadata budget | S-01          | — (cost guardrail)            | proposed |

## Streams

Navigation aid — groups items that share a Prerequisites chain. Canonical ordering still lives in the dependency graph below; this table is the proposed reading order across parallel tracks.

| Stream | Theme                          | Chain                             | Note                                                                                          |
| ------ | ------------------------------ | --------------------------------- | --------------------------------------------------------------------------------------------- |
| A      | Core: transcript→summary       | `F-02` → `S-01` → `S-08` → `S-02` / `S-03` | Front-loads the top risk (external) per the "speed" goal. `S-08` gates `S-02` so the list ships with video metadata; `S-03`, `S-07` and `S-09` run parallel after `S-01` and do not wait on `S-08` — though `S-09` is cheapest to land *before* `S-08` if it takes the duration-pre-gate lever, which relocates `S-08`'s metadata call. |
| B      | Data & privacy                 | `F-01`                            | Minimal schema + RLS; joins Stream A at `S-01`.                                                |

## Baseline

What's already in place in the codebase as of `2026-06-11` (auto-researched + user-confirmed).
Foundations below assume these layers exist and do NOT re-scaffold them.

- **Frontend:** present — Astro 6 + React 19; auth forms, layout, dashboard (`src/pages`, `src/components`).
- **Backend / API:** present — Astro SSR endpoints for auth (`src/pages/api/auth/{signin,signup,signout}`).
- **Data:** partial — Supabase configured (`supabase/config.toml`), only `auth.users` used; no migrations or domain tables (`videos`/`summaries` do not exist).
- **Auth:** present — full sign-up/sign-in/sign-out/callback flow + middleware; deployed and verified end-to-end (`deploy-plan.md`). Covers FR-001, FR-002.
- **Deploy / infra:** present — Cloudflare Workers live (`10x-media.nightshiftlab.workers.dev`); CI auto-deploy on merge to `master`.
- **Observability:** present (basic) — `observability.enabled` in `wrangler.jsonc` + `wrangler tail`.
- **AI / LLM:** absent — no AI SDK and no transcript-fetch path; FR-005 not implemented (see `F-02`).

## Foundations

### F-01: Data schema for videos and summaries + RLS

- **Outcome:** (foundation) `videos` and `summaries` tables exist in Supabase with per-user RLS policies; multi-tenant privacy enforced at the database level.
- **Change ID:** video-summary-schema
- **PRD refs:** Access Control, NFR (data privacy), FR-006
- **Unlocks:** S-01, S-02, S-03; reduces the privacy-guarantee risk (the PRD's only guardrail) before any user data lands in the database
- **Prerequisites:** — (auth present in baseline)
- **Parallel with:** F-02
- **Blockers:** —
- **Unknowns:** —
- **Risk:** Low risk. Sequenced early because every data slice assumes these tables, and skipping RLS here would break the privacy guarantee. Scope capped to two tables + policies — it does not build "the whole data layer"; S-01 still integrates this layer through real summary writes.
- **Status:** done (implemented + reviewed; change `video-summary-schema`, Linear MAR-5). Not yet archived.

### F-02: Transcript→LLM path verified on the deployed Worker

- **Outcome:** (foundation) AI provider wired in (key as a Workers Secret), and the "fetch YouTube transcript → call LLM" path is verified on a live, deployed Worker; confirmed whether the free Cloudflare plan is sufficient or a paid plan / workaround is needed.
- **Change ID:** transcript-llm-probe
- **PRD refs:** FR-005, NFR
- **Unlocks:** S-01; reduces the top risk (external: YouTube blocking Cloudflare datacenter IPs + the free Cloudflare plan's CPU limit)
- **Prerequisites:** — (deploy present and verified in baseline)
- **Parallel with:** F-01
- **Blockers:** —
- **Unknowns:**
  - Can the YouTube transcript be fetched from Cloudflare datacenter IPs (not just the dev machine)? — Owner: user/team. Block: no (this spike is what resolves it).
  - Will the free Cloudflare plan (~10ms CPU limit) handle transcript parsing, or is a paid plan / Railway escape-hatch required? — Owner: user. Block: no.
- **Risk:** The riskiest element of the whole roadmap (top risk = external). Sequenced as the first de-risk: with the hard deadline of 2026-07-31 and after-hours work, any blocker on the live Worker must be discovered while schedule slack still exists. `infrastructure.md` names Railway (`@astrojs/node`) as the documented workaround if workerd / IP-blocking fail.
- **Status:** done (implemented + impl-reviewed; change `transcript-llm-probe`, Linear MAR-6 Done 2026-07-10). De-risk verdict: free Cloudflare plan sufficient — Railway escape hatch not needed. Not yet archived. Follow-ups carried to S-01: LLM prompt-engineering, transcript-length guard, upstream-error handling.

## Slices

### S-01: User generates and saves a video summary

- **Outcome:** the user pastes a YouTube video URL, selects the character (informational or educational), and gets a Polish summary tailored to the character, which is then saved.
- **Change ID:** generate-and-save-summary
- **PRD refs:** US-01, FR-003, FR-004, FR-005
- **Prerequisites:** F-01, F-02
- **Parallel with:** —
- **Blockers:** —
- **Unknowns:**
  - How to handle a video without an available transcript (user-facing message, alternative source)? — Owner: user. Block: no.
  - What exact YouTube URL validation rules to apply, and how to communicate validation errors? — Owner: implementation. Block: no.
- **Risk:** This is the north star — the slice that validates the product's core. It depends on F-02: if the transcript→LLM path fails on the chosen plan, this slice must be re-planned (workaround / Railway) before UI work starts. The open questions about missing transcripts and URL validation do not block planning — they have sensible default fallbacks (a message, input-side validation).
- **Status:** done — all 8 phases live in production 2026-07-24 (Linear MAR-7 → Done); pending `/10x-archive`. 8-phase plan written 2026-07-18, extended to 8 phases 2026-07-19 (`context/changes/generate-and-save-summary/plan.md`). Approach: productionize the F-02 probe pipeline (rename `probe`→`/api/summaries/generate`), add a dashboard generation UI, carry F-02 follow-ups (prompt-engineering, transcript-length guard, upstream-error handling — **but not F4/F5, see the note at the end of this status**), and add a variable-cost path (>40k transcript chars ⇒ 2 credits via new `spend_credits(amount)` RPC + `allowLong` confirmation). Testing manual-only (Module-3 deferral). **Plan-reviewed + hardened 2026-07-18→19** (RETHINK → SOUND, all 7 findings triaged/fixed): credit flow reworked to **debit-before-LLM + refund-on-failure** (new `refund_credits` service_role RPC) to close a concurrency budget bypass; migration made **expand-only** (drop of `spend_credit()` moved to a contract migration to avoid a deploy window). The former `S-01-fu` (`drop-spend-credit-contract`) is now **Phase 8** of this slice — a deploy-gated contract migration that drops `spend_credit()` only after the phases 1–7 Worker is live on cloud; added `HARD_MAX_TRANSCRIPT_CHARS` → 413 cap. **Implementation 2026-07-19 (branch `generate-and-save-summary`): phases 1–7 of 8 landed** — P1 English UI copy (`4f48536`), P2 variable-cost `spend_credits`/`refund_credits` migration + credits service (`23d59cc`), P3 cost-policy helper (`b22d6f1`), P4 endpoint rename & harden → `/api/summaries/generate` + 502/413 (`9072baa`), P5 `allowLong` 409 confirmation gate (`17817f2`), P6 dashboard generation island (`10b3ffa`), P7 prompt engineering + **Markdown rendering** (summaries now emit Markdown, rendered via `react-markdown` in the island — amends the original "no markdown rendering" non-goal; `af3bea3`); automated checks green throughout, P7 manual quality pass passed on both characters. DB-level manual checks (spend/refund grants) + P1 banner still to spot-check. **Only Phase 8 remains — deploy-gated**: the contract migration dropping legacy `spend_credit()` applies to cloud only after the phases 1–7 Worker is live. **Incomplete follow-up carry (noted 2026-07-20):** the F-02 Phase 4 impl-review deferred **five** items to S-01, not the three listed above — the two missed are F4 (persist `generation_ms`) and F5 (persist `cost_usd` via OpenRouter usage accounting), `context/changes/transcript-llm-probe/reviews/impl-review-phase-4.md:57-75`. Neither appears in S-01's plan, `src/`, or `supabase/migrations/`; S-01 treated latency and cost only as things to *bound* (the `HARD_MAX_TRANSCRIPT_CHARS` → 413 cap), never to *record*. Both are now tracked as **S-07** (`summary-generation-telemetry`) rather than reopening S-01 — adding a migration here would contend with the deploy-gated Phase 8. **Update 2026-07-24:** phases 1–7 **shipped to production** (merged to `master`, Worker deployed via `wrangler deploy`, the 9 expand migrations pushed to prod Supabase; manual e2e acceptance passed) — this satisfied Phase 8's deploy gate. **Phase 8 is now implemented + committed** (`9085d03`): `20260724120000_drop_legacy_rpcs.sql` drops all six superseded RPCs (widened from the original single `spend_credit()` drop to also cover `spend_credits`/`refund_credits`/`reserve_credits` and the two `generation_lock` fns), and the dead `reserveCredits` wrapper is removed; automated gates + local-DB verification green. **Phase 8 shipped to production 2026-07-24:** merged fast-forward to `master` (`f415f12..c0469d5`), Worker redeployed via CI run 30128397834 (`ci` + `deploy` green), then `supabase db push --linked` applied `20260724120000_drop_legacy_rpcs.sql`; `migration list --linked` in sync. Cloud checks 8.5–8.7 all closed — the deployed Worker had **no call site** for any dropped RPC (`reserveCredits` was defined but uncalled), a production `supabase db dump` shows all six functions absent (definitions *and* grants), and `settle_reservation`/`reconcile_reservation` remain `service_role`-only. The live normal/long generation smoke test was **accepted without re-execution** (user decision 2026-07-24): the drops are structurally verified and the generation path is covered by `reviews/manual-e2e-2026-07-23.md`. Impl-review triage complete (`reviews/impl-review-phase-8.md`, verdict APPROVED, F1 + F2 both FIXED). **All 8 phases live; ready for `/10x-archive`** — Linear MAR-7 → Done 2026-07-24.

### S-02: User browses the list of summaries

- **Outcome:** the user browses the list of their saved summaries.
- **Change ID:** browse-summary-list
- **PRD refs:** FR-006
- **Prerequisites:** S-01, S-08
- **Parallel with:** S-03
- **Blockers:** —
- **Unknowns:** —
- **Risk:** Low risk. After S-01 the data already exists; this visible list surface is also the mechanism by which the user judges the "75% good-enough summaries" criterion over time. Sequenced after S-01 because without saved summaries there is nothing to browse, and after S-08 so the list renders thumbnails, titles, channel names, lengths and upload dates from the start rather than shipping a bare-URL list that is immediately retrofitted.
- **Status:** proposed

### S-03: User deletes a summary

- **Outcome:** the user deletes a summary from their list.
- **Change ID:** delete-summary
- **PRD refs:** FR-007
- **Prerequisites:** S-01
- **Parallel with:** S-02
- **Blockers:** —
- **Unknowns:** —
- **Risk:** Lowest priority (FR-007 = nice-to-have). With the "speed" goal it's the first candidate to defer if the 2026-07-31 deadline presses; kept as a small slice (not in Parked) because it's cheap and closes the CRUD on summaries.
- **Status:** proposed

### S-04: User deletes their account (GDPR)

- **Outcome:** the user permanently deletes their account, and all associated data (videos, summaries, credits) is removed — satisfying the GDPR right to erasure.
- **Change ID:** delete-account
- **PRD refs:** Access Control, NFR (data privacy)
- **Prerequisites:** F-01
- **Parallel with:** —
- **Blockers:** —
- **Unknowns:** resolved during planning —
  - ~~Hard delete vs. soft-delete + purge window?~~ → **hard delete** (immediate, irreversible; no scheduler).
  - ~~How to remove the Supabase `auth.users` record from an SSR endpoint (service-role key vs. client)?~~ → **service-role admin client** calling `auth.admin.deleteUser`; domain rows purge via existing cascade FKs.
- **Risk:** Low-to-medium risk. Depends on F-01 so the domain tables exist to cascade from; the auth account itself already exists in the baseline. Sequenced independently of the summary CRUD — it's a compliance guardrail, not part of the core loop. The main care point is completeness (no orphaned rows) rather than complexity.
- **Status:** done — merged to `master` 2026-07-13 (merge commit `78bca68`, pushed to origin), Linear MAR-10 → Done; pending `/10x-archive`. Both phases implemented + committed 2026-07-12 — Phase 1 `2ebeaaf`, Phase 2 `2b0c78e`, epilogue `2710a3c`; `SUPABASE_SERVICE_ROLE_KEY` set as a Cloudflare Workers Secret. Manual E2E verification **passed** (commit `546e8f0`). Impl-review ran 2026-07-12 — verdict **NEEDS ATTENTION** (0 critical, 2 warnings, 3 observations). Triage complete 2026-07-13 (commit `57851b0`): F1/F3/F4 fixed (server-side delete confirmation, masked error contract, shadcn Dialog a11y), F2 skipped (pre-existing baseline lint drift owned by a parallel branch), F5 = tracker sync; lint + build green on the feature files.

### S-05: New users start with a credit budget

- **Outcome:** each new user starts with 5 credits; generating a summary spends one credit, and generation is blocked at zero credits. Refilling credits is manual-only for now (no self-serve top-up).
- **Change ID:** summary-credits
- **PRD refs:** — (no direct PRD ref; roadmap-originated cost guardrail on FR-005's paid transcript/LLM pipeline)
- **Prerequisites:** F-01
- **Parallel with:** S-04
- **Integrates with:** S-01 (spend-enforcement wires into the generation endpoint)
- **Blockers:** —
- **Unknowns:** resolved during planning (2026-07-11) —
  - ~~Where does the balance live — column on the user profile vs. a dedicated `credits` table / ledger?~~ → **dedicated `user_credits` table** (PK → `auth.users` on delete cascade; read-only RLS; no client writes).
  - ~~What is the manual refill mechanism (direct SQL, Studio, admin script)?~~ → **offline `grant-credits.mjs` service-role script** (`npm run grant-credits -- <email> <n>`).
  - Enforcement model: **spend-on-success + up-front read gate** (no refund, no client-reachable increment, no service-role in the request path); atomic `SECURITY DEFINER spend_credit()`; seed via trigger on `auth.users` insert + backfill.
- **Risk:** Low-to-medium risk. Guards the OpenRouter budget against runaway generation. The storage/seeding/refill half depends only on F-01 and can be built independently; only the spend-and-block enforcement needs a call site, which lives in S-01's generation endpoint (and must be server-side so it can't be bypassed from the client). Because an un-credited S-01 exposes the budget, this slice should land **before or together with** S-01, not after it. Manual-only refill keeps scope small for the MVP.
- **Status:** done — merged to `master` 2026-07-14 (`482b686`), CI green and the Worker auto-deployed. Formal `/10x-impl-review` landed **NEEDS ATTENTION** (2026-07-13: 5 warnings + 3 observations); **all 8 triaged and fixed 2026-07-14** in `10f91f4`, every dimension now PASS (change `summary-credits`, Linear MAR-11). All 4 phases implemented and manually verified. **All 6 DB migrations are live on the cloud project** as of 2026-07-14 (`ukbptccdffiigkdekzcn`) — local and remote histories match, and the post-push privilege state is verified by `db dump`. Pending `/10x-archive`. Enforcement wires into the F-02 probe endpoint now; S-01 reuses the same `credits` service. **Note for future slices:** the push revealed that cloud default privileges grant `ALL` on new tables to `anon`/`authenticated`; `20260714140000` revoked the `anon` half schema-wide, but `authenticated` still gets CRUD on any new table by default — tighten per-table as `user_credits` does.

### S-06: Production-like application design

- **Outcome:** the user works through a coherent, production-like UI instead of the starter template — consistent layout, navigation, typography and states (loading / empty / error) across the auth, generation and summary-list surfaces.
- **Change ID:** app-design-system
- **PRD refs:** — (no direct PRD ref; product-polish slice on the existing UI surfaces)
- **Prerequisites:** S-02
- **Parallel with:** —
- **Blockers:** —
- **Unknowns:**
  - How far to go — restyle the existing shadcn/ui surfaces vs. adopt a fuller design language (colors, spacing scale, brand)? — Owner: user. Block: no.
  - Which surfaces are in scope beyond auth + generation + list (e.g. landing page)? — Owner: user. Block: no.
- **Risk:** Low risk, but ordering matters more than size here. This slice's value is coherence *across* surfaces, so it must run after the surfaces exist: S-01 builds generation, S-02 builds the list. Running it earlier means styling screens that don't exist yet, and contending for the same components in parallel worktrees. S-03 is deliberately not a prerequisite — it lands whenever it lands and inherits the design rather than re-opening this slice. Scope stays presentational — no behavior changes to generation, credits or CRUD. Under the "speed" goal it is deferrable alongside S-03 — polish, not a PRD requirement.
- **Status:** planned

### S-07: Summary generation telemetry (latency, cost, transcript)

- **Outcome:** (observability) every saved summary records how long generation took and what the LLM call cost, and the transcript it was generated from is kept, so models, characters and transcript branches can be compared on speed, spend and input size — not just on content.
- **Change ID:** summary-generation-telemetry
- **PRD refs:** — (no direct PRD ref; carries F-02 impl-review findings F4 and F5, and feeds the PRD's Open Q2 "75% good-enough" tracking mechanism)
- **Prerequisites:** S-01
- **Parallel with:** S-02, S-03
- **Blockers:** —
- **Unknowns:**
  - Single wall-clock `generation_ms` vs. split `transcript_ms` / `llm_ms`? — Owner: implementation. Block: no. (Split is more diagnostic given the 33 s vs. 254 s spread came from the *transcript* branch, not the LLM.)
  - Persist token counts alongside `cost_usd`, or cost only? — Owner: implementation. Block: no.
  - Reuse a stored transcript on re-generation, or always re-fetch? — Owner: user. Block: no. (Reuse saves Supadata cost and closes S-01's accepted double-fetch, but serves a stale transcript if the video's captions later change. A `fetched_at` column keeps the option of a staleness window open without deciding now.)
  - Retention: keep transcripts indefinitely, or purge after N days? — Owner: user. Block: no. (Indefinite is simplest and matches MVP scale; the erasure path is already covered — see Scope notes.)
- **Risk:** Low risk — additive nullable columns on `summaries` (F4/F5) and `videos` (T3), no backfill, no RLS change, same idempotent-migration pattern already used twice for `model` and `resolved_via`. All three parts land in one migration and touch one service each. The only part that is more than bookkeeping is T3's optional reuse-on-regeneration path, which changes generation behaviour — it is listed as an open question and can ship as store-only first. **Provenance:** these were deferred to S-01 by the F-02 Phase 4 impl-review (`context/changes/transcript-llm-probe/reviews/impl-review-phase-4.md` F4 `:57-65`, F5 `:67-75`) but were **not carried into S-01's plan** — S-01 reasoned about latency and cost only as things to *bound* (the `HARD_MAX_TRANSCRIPT_CHARS` → 413 cap), never to *record*. The omission was found 2026-07-20, after S-01 phases 1–7 landed; verified absent from `src/`, `supabase/migrations/` and S-01's plan. Sequenced after S-01 rather than folded into it so the deploy-gated Phase 8 contract migration is not disturbed.
- **Scope notes:**
  - **F4 (latency):** additive `generation_ms integer` (or split `transcript_ms`/`llm_ms`) on `summaries`; thread timing through the persistence service. Motivation: the live F-02 run measured 33 s (inline transcript + LLM) vs. 254 s (async-job poll to exhaustion) — a wide, meaningful spread that is currently unrecorded.
  - **T3 (transcript persistence):** additive nullable `transcript text` + `transcript_fetched_at timestamptz` on **`videos`**, not `summaries` — a video carries one transcript but can have two summaries (one per character; the local DB already has such a pair for `dQw4w9WgXcQ`), so `summaries` would duplicate the text per character. Input size then comes free as `length(transcript)`, directly comparable to `LONG_TRANSCRIPT_CHARS`/`HARD_MAX_TRANSCRIPT_CHARS` (`src/lib/services/summaries.ts:84-85`), which are also char-based. **Motivation (measured 2026-07-20):** the S-01 F1 triage asked how output length compares to input and the question was unanswerable — `summaries` records `content` but nothing about the input. Output measured ~4.2–4.9k chars across 4 rows and is effectively constant in cost (~1.8 ¢/summary at Sonnet 5 intro rates), while input spans ~50× and dominates the bill; without the transcript, the ratio that matters cannot be computed. **Secondary win:** closes S-01's explicitly accepted "double transcript fetch on confirm" tradeoff (plan.md §Critical Implementation Details) — the 409 → "Generate anyway" resubmit currently re-fetches, occasionally re-triggering a paid Whisper job. **Erasure:** no new GDPR work — `videos.user_id` already carries `on delete cascade` to `auth.users` (`20260613145120_videos_and_summaries.sql:6`), so S-04 account deletion removes transcripts with the rest. RLS: reuse the existing per-user `videos` policies; the new columns need no separate policy. **Sizing:** bounded by `HARD_MAX_TRANSCRIPT_CHARS` at 200k chars/row worst case — negligible at MVP scale, worth revisiting only if the user cap lifts.
  - **F5 (cost):** add `usage: { include: true }` to the model options in `getSummaryModel` (`src/lib/services/llm.ts:7-9`, currently no options object), return `providerMetadata?.openrouter?.usage` from `summarize()`, persist to an additive `cost_usd numeric`. Feasibility already confirmed against `@openrouter/ai-sdk-provider` via Context7 — no new dependency. `cost` is `number | undefined`, so persist null-safely.
- **Status:** proposed

### S-08: Persist video metadata

- **Outcome:** the user sees the video's thumbnail, title, YouTube channel name, length, upload date and language alongside a summary, instead of a bare URL — so a saved summary is recognisable at a glance and the watch/skip decision has the context (how long, how old, what language) that the summary text alone doesn't carry.
- **Change ID:** persist-video-metadata
- **PRD refs:** — (no direct PRD ref; makes FR-006's summary list legible)
- **Prerequisites:** S-01
- **Unlocks:** S-02 (the list is the main surface that renders this metadata)
- **Parallel with:** S-07
- **Integrates with:** S-06 (styling of the resulting card)
- **Blockers:** —
- **Unknowns:**
  - Which metadata source? — Owner: implementation. Block: no. Narrowed by a docs check on 2026-07-25: **Supadata's `/metadata` endpoint covers all of it in one call** (`title`, `author.displayName`, `media.duration` in seconds, `media.thumbnailUrl`, `createdAt`) and reuses the key the app already has, so no new provider or quota. YouTube oEmbed is out — it returns title/`author_name`/thumbnail but **neither duration nor upload date**; the YouTube Data API would cover them (`contentDetails.duration`, `snippet.publishedAt`) but needs a new key + quota. The deprecated `GET /youtube/video` should not be used — prefer the unified `/metadata` endpoint.
  - Which "language" do we store — the transcript language or the video's original audio language? — Owner: user. Block: no. Only the first is actually available: Supadata's metadata response has **no language field**, but the transcript response already returns `lang` (ISO 639-1) plus `availableLangs`, and the app already receives it and throws it away (`src/lib/services/transcript.ts:5,40,58`). So language is free but means "the language of the transcript we summarised from" — which, with `lang: "pl"` requested and `mode: "auto"` fallback, is *not* always the video's spoken language. Name and label the column honestly, or drop language from scope.
  - **Input-quality constraint — decided 2026-07-25 (user): never trade the original transcript for a machine-translated one.** The app requests `lang: "pl"` (`src/lib/services/transcript.ts:24`, `src/pages/api/summaries/generate.ts:260`), which is a *preference among existing caption tracks*, not a translation request — Supadata's translation is a separate endpoint (`/youtube/transcript/translation`) the app never calls, and unmatched requests "default to the first available language". Polish output comes from the prompt (`src/lib/services/llm.ts:23,52`, "Always answer in Polish, regardless of the transcript's language"), so `lang: "pl"` buys nothing on a foreign-language video — but if YouTube's **auto-translated** Polish track counts as "available", the request would hand the model a machine-translated Polish transcript instead of the original, i.e. a lossy double translation. **Not yet actionable, and not verified:** the docs retrieved on 2026-07-25 do not say whether auto-translated (or auto-generated) tracks enter the `lang` / `availableLangs` pool at all, and dropping `lang` is not a guarantee either — "first available" has no documented ordering, so it need not be the original. Settle it with a ~2-credit probe (one transcript call on a video known to expose many auto-translations, with and without `lang=pl`, inspecting `lang` + `availableLangs`) before changing the request; until then keep `lang: "pl"` and **persist `lang` and `availableLangs`** so the choice is made on data rather than assumption. `TranscriptResult` currently has no field for `availableLangs` (`transcript.ts:4-6`) — adding one is part of this slice.
  - Hotlink the YouTube thumbnail CDN URL or copy the image into storage? — Owner: implementation. Block: no. (Hotlinking is the cheap default for the MVP.)
  - Duration unit and rendering — store raw seconds and format in the UI, or store an interval? — Owner: implementation. Block: no. (Raw seconds matches the API and keeps sorting/filtering trivial.)
- **Risk:** Low risk. `videos.title` and `videos.thumbnail_url` already exist from F-01 but are never written (`VideoInsert`, `src/lib/services/summaries.ts:14-18`), so part of the slice is populating dead columns; the four new fields (channel, duration, upload date, language) need one additive migration. The care point is failure isolation — metadata is decorative, so a fetch failure must not fail a paid generation that already succeeded; persist nulls and render a fallback. Note this adds a **second Supadata call** per generation alongside the transcript fetch — cheap, but it must be non-fatal and should not be retried aggressively. Sequenced after S-01 to avoid contending with the deploy-gated Phase 8 migration, and made a hard prerequisite of S-02 so the list ships with metadata rather than being retrofitted.
- **Scope notes:**
  - **API reference:** captured in this slice's own change folder — `context/changes/persist-video-metadata/docs/` (fetched 2026-07-25; see its `README.md`). `supadata-metadata.md` carries the response schema and the field→column mapping below; `supadata-transcript.md` carries the `lang` caveat.
  - Additive nullable columns on `videos`, one idempotent migration (same pattern as `model` / `resolved_via`): `channel_name text`, `duration_seconds integer`, `published_at timestamptz`, `language text`. RLS unchanged — the existing per-user `videos` policies cover new columns, and `videos.user_id`'s `on delete cascade` already covers S-04 erasure.
  - Populate the existing dead `title` / `thumbnail_url` on the same insert path.
  - Metadata fetch happens in the generation endpoint next to the transcript fetch, best-effort and non-fatal; `language` comes free from the transcript result already in hand rather than a separate call.
  - **Adjacency with S-07:** both slices add nullable columns and thread extra fields through the same persistence path (`src/lib/services/summaries.ts`). They target different tables' concerns (S-07: `generation_ms`/`cost_usd` on `summaries` + `transcript` on `videos`; S-08: descriptive metadata on `videos`) but will collide on the same insert function if run in parallel worktrees — sequence them or expect a merge.
  - **Supadata cost of the second call (measured 2026-07-25):** `/metadata` is a **flat 1 credit** per request, any platform or media type (docs.supadata.ai/get-metadata §Pricing). Compare with the transcript call: **1 credit** for a native transcript, but **2 credits per minute** for a generated (Whisper) one; job-status polling is free, and a 206 "unavailable" still costs 1 credit. So the second call **doubles** the cost of a cheap generation (native transcript: 1 → 2 credits) and is noise on an expensive one (a 20-min Whisper video is ~40 credits; +1 is ~2%). Live account state via `GET /v1/me`: plan **"Free (100/mo)"**, `maxCredits: 100`, `usedCredits: 29` — so S-08 takes the native-transcript ceiling from ~100 to ~50 generations/month on the current plan. Acceptable at MVP volume, but it is a real halving, not a rounding error.
  - **Rate limit shapes the sequencing:** the free plan allows **1 request/second**. Firing `/metadata` concurrently with the transcript fetch would put two Supadata requests in the same second and earn `limit-exceeded`; because metadata is non-fatal, the failure mode is *silently null metadata* rather than an error — the worst kind of bug for a decorative field. Fetch it **after** `summarize()` returns (seconds past the transcript request, and its own round trip is noise next to the LLM call), then pass it into the persist step. Do not fire it before the cost gates either: the 402/413/409 paths must not spend a credit on a generation that never happens, and the `allowLong` confirmation resubmit would otherwise pay for metadata twice.
  - **The persist path needs a signature change, not just columns:** `videos` is inserted inside the `persist_summary` RPC, which currently takes `p_url`/`p_youtube_id` only and inserts `values (target_user, p_url, p_youtube_id)` (`supabase/migrations/20260723120000_atomic_persist_summary.sql:45-53,113`) — that is *why* `title`/`thumbnail_url` are dead. Writing metadata transactionally means widening that RPC's parameter list. Same function S-07 has to widen, hence the collision noted above.
  - **Pre-existing finding, now tracked as S-09:** at 2 credits/minute for generated transcripts on a 100-credit plan, a single ~50-minute Whisper video would consume the entire monthly Supadata budget, and `fetchTranscript` requests `mode: "auto"`, which falls back to generation silently (`src/lib/services/transcript.ts:30`). Out of scope here; surfaced by this slice's cost check. **Note the coupling:** if S-09 adopts its duration pre-gate lever, `/metadata` moves *before* the transcript fetch and stops being decorative — which overrides the "fetch after `summarize()`" sequencing above and changes the failure policy from "persist nulls" to a fail-open/fail-closed decision. Land S-09 first, or expect to move the call.
  - **Cost-policy note:** `duration_seconds` is *not* a substitute for the char-based `LONG_TRANSCRIPT_CHARS` / `HARD_MAX_TRANSCRIPT_CHARS` gates (`src/lib/services/summaries.ts:84-85`). It is display context for the watch/skip decision; no pricing behaviour changes here.
- **Status:** implemented + deployed 2026-07-26, **manual verification still open**. Branch `persist-video-metadata`, four phases: P1 schema + widened RPC (`bd307b2`) — five new columns, `thumbnail_url` → `thumbnail_url_reported` with its rationale comment, `persist_summary` dropped and recreated at 15 params with a coalescing on-conflict clause; P2 transcript language signals (`6553ac0`) — `lang: "pl"` dropped, `availableLangs` surfaced on both the inline and job paths, large-pool `console.warn`; P3 metadata fetch (`17e9730`) — new total `src/lib/services/metadata.ts` (one retry on `limit-exceeded` or a transport rejection, vendor values normalised before typed columns, never throws) wired in after `summarize()` and before the persistence `try`/`catch`; P4 rollout — `supabase db push` and `wrangler deploy` run back to back 2026-07-26 (version `52657520-eac9-47fe-85a4-19f726db4f79`), closing the RPC-swap window. Automated gates green throughout (`supabase migration up`, `npm run lint`, `npm run build`), and the local DB confirms 12 `videos` columns, exactly one `persist_summary` in `pg_proc` and the comment attached. **What is NOT verified: every manual row in the plan** — no real generation has been run against either stack since the change, so the seven-field populate, the thumbnail URL, the metadata-failure and transport-rejection non-fatality, the second-generation coalesce and the `usedCredits` delta are all unconfirmed. The user chose to deploy ahead of that verification. Earlier planning record: 4-phase plan written 2026-07-25 (`context/changes/persist-video-metadata/plan.md`, brief at `plan-brief.md`). Planning settled six things the scope notes left open. **(1) Language is diagnostic, not display.** The columns are named `transcript_lang` / `transcript_available_langs`, never `language`, and nothing renders them — a card labelled "language" would be false exactly when auto-translated tracks exist, and the honest field (the video's spoken language) needs the Data API this slice rejected. **(2) No probe.** The `lang: "pl"` request is dropped outright — it is the one setting that can ask for a machine-translated track — and `availableLangs` is persisted so the open auto-translation question is answered by real traffic instead of a paid one-off; a `console.warn` fires when the pool is large enough to imply auto-translation (threshold a first guess, native sets run 1–3 tracks vs 100+). Note this is a behaviour change on the paid transcript path, with a narrow regression: a Polish video carrying extra human tracks may now get the wrong one, since "first available" has no documented ordering. **(3) Zero UI** — S-02 owns rendering and must supply the null fallback, which it needs regardless because a failed metadata fetch produces the same shape. **(4) The RPC swap is drop + create in one migration, not expand/contract** (user decision): it avoids a window with two ambiguous `persist_summary` overloads, at the cost of requiring `db push` and `wrangler deploy` back to back — in between, the live Worker 500s and refunds, losing the OpenRouter spend but never charging the user. **(5) One targeted retry** on the metadata call (network errors and `limit-exceeded` only; `not-found`/`invalid-request` are permanent), then null. **(6) No backfill** — each row would cost a credit from the 71 remaining. **Gap found during planning, not in these scope notes:** the `allowLong` confirmation path has no transcript in hand (`transcript_quotes` stores content + `resolved_via` only), so both language columns are null there; accepted, `save_transcript_quote` is deliberately not widened. Two hazards captured in the plan's Critical Implementation Details: the upsert must `coalesce` new columns or a second generation with failed metadata erases the first run's, and vendor values must be normalised before hitting `timestamptz`/`integer` or a malformed `createdAt` aborts persist and refunds an already-paid summary.

### S-09: Bound the Supadata cost of one generation

- **Outcome:** (guardrail) the operator's Supadata spend per generation is bounded and predictable — no single video can silently consume the whole monthly credit budget — and when a video cannot be summarised cheaply the user is told so instead of the cost being absorbed invisibly.
- **Change ID:** transcript-cost-guardrail
- **PRD refs:** — (no direct PRD ref; roadmap-originated cost guardrail, the Supadata-side sibling of S-05's OpenRouter-side guardrail)
- **Prerequisites:** S-01 (the generation endpoint is where the guard lives). Lever B additionally needs S-08 (duration).
- **Parallel with:** S-02, S-03, S-07
- **Integrates with:** S-08 (see the coupling note there — lever B moves the `/metadata` call before the transcript fetch and makes it load-bearing)
- **Blockers:** —
- **Unknowns:**
  - Which lever (see Scope notes A–D), and is losing caption-less videos acceptable? — Owner: user. Block: no. (A is one line and fully predictable but drops a capability; B keeps it behind a confirmation.)
  - If the pre-gate metadata fetch fails, fail open (generate, risk the spend) or fail closed (refuse)? — Owner: user. Block: no. (Fail-closed is the honest default for a cost guard, but it makes a decorative dependency able to block the core flow.)
  - What duration threshold, and should a long Whisper video cost the *user* more than the current 2-credit maximum? — Owner: user. Block: no.
- **Risk:** Nice-to-have, and deferrable alongside S-03 under the "speed" goal — the exposure is operator-side (a drained Supadata budget, recoverable by a plan upgrade or waiting for the reset), not user-facing data loss or a privacy breach. It is worth a slice rather than a footnote because the mismatch is structural, not a tuning problem: **the app prices generation in characters, after the fetch, capped at 2 user credits (`summaryCost`, `src/lib/services/summaries.ts:84-85`), while Supadata charges in minutes, during the fetch, uncapped.** So a user can spend 2 of their credits on a video that costs the operator 100 Supadata credits — and `HARD_MAX_TRANSCRIPT_CHARS` cannot help, because it is evaluated only *after* the money is spent. Low implementation risk in every variant: lever A is a one-word change, and the endpoint already has the return paths (422/409/413) that a refusal or confirmation would reuse.
- **Scope notes:**
  - **API reference lives in S-08's change folder:** `context/changes/persist-video-metadata/docs/` — `supadata-transcript.md` (the `mode` lever, `lang` semantics, per-operation pricing, error enum), `supadata-account-limits.md` (`GET /v1/me`, the measured account state, rate limits, and a warning that the plan/price table is unreliable), `supadata-metadata.md` (the endpoint S-08 adds). Captured 2026-07-25 via Context7 plus one live `GET /v1/me`; `docs/README.md` indexes them. No separate fetch needed to plan this slice.
  - **Measured basis (2026-07-25):** Supadata charges **1 credit** for a native transcript but **2 credits per minute** for a generated (Whisper) one; job polling is free; a 206 "unavailable" still costs 1 credit. The account is on plan **"Free (100/mo)"** (`GET /v1/me`: `maxCredits: 100`, `usedCredits: 29`), so **one ~50-minute video on the Whisper path exhausts the month**. Nothing in the code bounds this today — `fetchTranscript` passes `mode: "auto"` (`src/lib/services/transcript.ts:30`), whose documented behaviour is "try native, fall back to generate", and the fallback is silent.
  - **Provenance correction:** the 2-credits/minute price was **not** discovered on 2026-07-25 — it was already recorded in the F-02 research docs on 2026-07-05 (`context/changes/transcript-llm-probe/docs/supadata.md:43`, alongside the three `mode` values). What was new on 2026-07-25 is the arithmetic against the 100-credit plan and the observation that no code path bounds it. A correctly captured vendor fact sat unacted-on for three weeks, which is the reusable lesson here (candidate for `/10x-lesson`).
  - **Lever A — `mode: "native"`:** stop generating entirely. Documented as "only fetch existing transcript", so every transcript then costs exactly 1 credit and worst-case spend per generation is knowable in advance. Caption-less videos become `transcript-unavailable`, which the endpoint already turns into a 422 with a user-facing message — no new response path. Cheapest and most predictable; the cost is a real capability loss.
  - **Lever B — duration pre-gate:** fetch `/metadata` (1 credit) *before* the transcript, refuse or require confirmation above N minutes, then fetch with `mode: "auto"`. Keeps Whisper available for short videos and reuses the existing `allowLong` 409 confirmation pattern. Two consequences: it needs S-08's metadata call moved to the front of the pipeline (and hardened — see the coupling note in S-08), and it also *fixes* the 1-request/second concern by ordering the two Supadata calls naturally instead of concurrently.
  - **Lever C — org-budget circuit breaker:** poll `GET /v1/me` (free) and refuse generation when `usedCredits` approaches `maxCredits`. Orthogonal to A and B: it caps the fleet rather than the single video, and is the only lever that also covers death-by-many-small-videos. Cheap, but it protects the budget by breaking the product for everyone once tripped, so it belongs behind a warning surface.
  - **Lever D — two-stage native-then-confirm:** try `mode: "native"` first, and on `transcript-unavailable` tell the user the video needs paid transcription and let them opt in to a `mode: "generate"` retry. Most honest UX and needs no metadata call, but burns 1 credit on the failed native attempt (the 206 is billable) and adds a round trip.
  - **Not in scope:** changing what a summary costs the *user* in app credits (S-05's model), or upgrading the Supadata plan. Both are decisions this slice should inform, not make.
  - **Interaction with S-07:** if S-07's transcript persistence lands with reuse-on-regeneration enabled, it independently removes one class of repeat Whisper spend. It is not a substitute — it helps only on a second generation of the same video, never the first.
  - **Language side effect worth knowing:** in `generate` mode Supadata **ignores the `lang` parameter** and returns the video's original language, so the app's `lang: "pl"` request is silently dropped on exactly the expensive path. Relevant to S-08's `language` column caveat and to prompt behaviour, not a cost matter.
- **Status:** proposed

## Backlog Handoff

| Roadmap ID | Change ID                 | Suggested issue title                          | Ready for `/10x-plan` | Notes                                       |
| ---------- | ------------------------- | ---------------------------------------------- | --------------------- | ------------------------------------------- |
| F-01       | video-summary-schema      | Data schema: videos/summaries tables + RLS     | done                  | Implemented + impl-reviewed (`impl_reviewed`); pending `/10x-archive`. |
| F-02       | transcript-llm-probe      | Spike: YouTube transcript → LLM on the Worker  | done                  | De-risk complete — free CF plan sufficient, Railway not needed. Implemented + impl-reviewed (`impl_reviewed`); pending `/10x-archive`. |
| S-01       | generate-and-save-summary | Generate and save a video summary              | done                  | Plan written 2026-07-18 (now 8 phases — former `S-01-fu` folded in as Phase 8, 2026-07-19), plan-reviewed + hardened 2026-07-18→19 (RETHINK → SOUND; all 7 findings fixed). **Implementation 2026-07-19 (branch `generate-and-save-summary`, Linear MAR-7 → In Progress): phases 1–7 of 8 done** — P1 English copy (`4f48536`), P2 `spend_credits`/`refund_credits` (`23d59cc`), P3 cost policy (`b22d6f1`), P4 endpoint rename & harden (`9072baa`), P5 `allowLong` 409 gate (`17817f2`), P6 dashboard island (`10b3ffa`), P7 prompts + Markdown rendering (`af3bea3`); automated checks green, P7 manual pass passed. **Shipped to production 2026-07-24**: phases 1–7 merged to `master`, Worker deployed, 9 expand migrations pushed to prod Supabase, manual e2e acceptance passed. **Phase 8 implemented + committed 2026-07-24** (`9085d03`): `20260724120000_drop_legacy_rpcs.sql` drops all six superseded RPCs (widened from `spend_credit()` alone to also cover `spend_credits`/`refund_credits`/`reserve_credits` + the two `generation_lock` fns) and removes the dead `reserveCredits` wrapper; automated gates 8.1–8.4 + local-DB verification green. **Phase 8 shipped to prod 2026-07-24**: merged to `master` (`f415f12..c0469d5`), Worker redeployed (CI 30128397834), `supabase db push` applied the drop, migrations in sync. Cloud checks 8.5–8.7 closed — deployed Worker had no call site for any dropped RPC, a prod `db dump` shows all six absent, `settle_reservation`/`reconcile_reservation` retained `service_role`-only; the live generation smoke test was accepted without re-execution (covered by the 2026-07-23 manual e2e). Impl-review APPROVED, triage complete. Linear MAR-7 → Done. Pending `/10x-archive`. |
| S-02       | browse-summary-list       | List of saved summaries                        | yes                   | **Unblocked 2026-07-26** — both prerequisites are met: S-01 shipped, and S-08 is implemented and deployed (manual verification still open, but the schema and write path are live, so nothing S-02 renders can change shape). Read the new columns as `thumbnail_url_reported`, `channel_name`, `duration_seconds`, `published_at` — note the thumbnail rename, `videos.thumbnail_url` no longer exists. S-08 ships **no UI**, so S-02 owns all rendering — including a null-metadata fallback, which it needs regardless since existing rows are not backfilled and a failed metadata fetch produces the same shape. Language is stored as `transcript_lang` (the transcript's language, not the video's) and is deliberately **not** for display. |
| S-03       | delete-summary            | Delete a summary                               | no                    | Waiting on S-01; FR-007 nice-to-have         |
| S-04       | delete-account            | Delete account + all data (GDPR)               | done                  | Merged to `master` 2026-07-13 (`78bca68`), Linear MAR-10 → Done. Both phases implemented; Workers Secret set. Manual E2E passed; impl-review NEEDS ATTENTION (2 warnings, 3 observations), triage complete (F1/F3/F4 fixed, F2 skipped baseline drift, F5 tracker sync); lint + build green. Pending `/10x-archive`. |
| S-05       | summary-credits           | Credit budget for summary generation           | done                  | Merged to `master` 2026-07-14 (`482b686`), CI green + Worker deployed, Linear MAR-11 → Done. Formal review: **NEEDS ATTENTION** (5 warnings + 3 observations), 2026-07-13; **all 8 findings triaged + fixed 2026-07-14** (`10f91f4`), every dimension now PASS. All 4 phases implemented + manually verified. All 6 DB migrations are **live on cloud** (2026-07-14), privilege state verified post-push. Pending `/10x-archive`. |
| S-06       | app-design-system         | Production-like application design             | no                    | Waiting on S-02 (needs the surfaces it styles to exist); presentational scope only |
| S-07       | summary-generation-telemetry | Persist summary generation time + LLM cost  | yes                   | Carries F-02 impl-review F4 (`generation_ms`) + F5 (`cost_usd` via OpenRouter usage accounting) — **deferred to S-01 but missed during S-01 planning**, found 2026-07-20. Small and well-specified: one additive migration + two service touches; feasibility already confirmed. Waits on S-01 landing (incl. deploy-gated Phase 8) to avoid contending on the same files. |
| S-08       | persist-video-metadata    | Persist video metadata (thumbnail, title, channel, length, upload date, language) | done                  | **Implemented + deployed 2026-07-26** on branch `persist-video-metadata` (P1 `bd307b2`, P2 `6553ac0`, P3 `17e9730`, P4 `db push` + `wrangler deploy` back to back). Automated gates green; **every manual verification row in the plan is still open** — no real generation has been run since the change, so the seven-field populate, thumbnail resolution, metadata-failure non-fatality and credit delta are unconfirmed. Deployed ahead of verification by user decision. Unblocks S-02. Historical record: gap found 2026-07-20: F-01 created `videos.title` / `videos.thumbnail_url` but no code ever writes them; no column exists for channel, length, upload date or language. **Scope widened + renamed 2026-07-25** to add length, upload date and language. Source decision effectively settled by a docs check the same day: Supadata `/metadata` returns title, `author.displayName`, `media.duration`, `media.thumbnailUrl` and `createdAt` in one call on the existing key (oEmbed lacks duration/upload date; Data API would need a new key + quota), and language comes free from the transcript response's `lang` — with the caveat that it is the *transcript's* language, not necessarily the video's. Needs one additive migration: `channel_name`, `duration_seconds`, `published_at`, `language`. **Hard prerequisite of S-02** so the list ships with metadata rather than being retrofitted. S-01 has since shipped, so this is unblocked. **Planned 2026-07-25** — 4-phase plan + brief in the change folder; language rescoped to two diagnostic columns (`transcript_lang`, `transcript_available_langs`) with no UI, `lang: "pl"` dropped from the transcript request, `persist_summary` widened via drop+create in one migration. Next: run the plan's manual verification, then `/10x-impl-review` and `/10x-archive`. |
| S-09       | transcript-cost-guardrail | Bound the Supadata cost of one generation      | yes                   | **API reference already captured** — `context/changes/persist-video-metadata/docs/` (S-08's folder): `supadata-transcript.md` + `supadata-account-limits.md` cover every fact this slice needs, no fetch required. Tracked 2026-07-25 while costing S-08's second Supadata call; the underlying price was already in the F-02 docs since 2026-07-05 (`transcript-llm-probe/docs/supadata.md:43`) — what was new is the arithmetic, not the fact. Supadata bills **2 credits/minute** for generated (Whisper) transcripts vs. 1 for native, and `fetchTranscript` uses `mode: "auto"`, which falls back to generation silently (`src/lib/services/transcript.ts:30`) — so on the current "Free (100/mo)" plan **one ~50-minute video drains the month**. Structural mismatch, not tuning: the app prices in characters *after* the fetch and caps the user at 2 credits, Supadata bills in minutes *during* it, uncapped, so `HARD_MAX_TRANSCRIPT_CHARS` cannot help. Four candidate levers (native-only / duration pre-gate / org circuit breaker / native-then-confirm) — needs a user decision on which, and on whether losing caption-less videos is acceptable. **Nice-to-have**: deferrable alongside S-03, exposure is operator-side. Couples to S-08 if the duration pre-gate is chosen. |

## Open Roadmap Questions

1. **What exactly does "good enough" mean for the 75% criterion?** A lightweight tracking/assessment mechanism is needed (e.g., a periodic self-review). — Owner: user. Block: roadmap-wide (does not block any single slice, but defines when the MVP meets its only success criterion). Source: PRD Open Q2.

## Parked

- **Automatic summary generation for new videos on a channel** — Why parked: PRD §Non-Goals (no channel subscription/monitoring; manual URL addition only).
- **Links to specific video moments (timestamps)** — Why parked: PRD §Non-Goals (a separate feature).
- **Sharing summaries between users** — Why parked: PRD §Non-Goals (data is private; no share mechanism).
- **Sources other than YouTube (podcasts, articles)** — Why parked: PRD §Non-Goals (MVP is YouTube only).
- **Channel character definitions other than informational/educational** — Why parked: PRD §Non-Goals.
- **Automatic channel character selection** — Why parked: PRD §Non-Goals.
- **Editing channel character definitions** — Why parked: PRD §Non-Goals.
- **Mobile applications** — Why parked: PRD §Non-Goals (MVP is web only).
- **S-03: deleting a summary (FR-007)** — Why parked-as-first-to-cut: nice-to-have; with the "speed" goal and the hard 2026-07-31 deadline, it's the first slice to defer if time runs short (remains in `## Slices` as proposed, but is deliberately ranked lowest).

## Done

(Empty on first generation. `/10x-archive` appends an entry here — and flips that item's `Status` to `done` — when a change whose `Change ID` matches is archived. Do NOT pre-populate.)
