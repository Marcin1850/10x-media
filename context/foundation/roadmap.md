---
project: "10xMedia"
version: 1
status: draft
created: 2026-06-11
updated: 2026-07-18
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
| S-01 | generate-and-save-summary | paste URL + pick character → get and save a Polish summary   | F-01, F-02    | US-01, FR-003, FR-004, FR-005 | in progress |
| S-02 | browse-summary-list       | browse the list of saved summaries                           | S-01          | FR-006                        | proposed |
| S-03 | delete-summary            | delete a summary                                             | S-01          | FR-007                        | proposed |
| S-04 | delete-account            | delete their account and all associated data (GDPR)          | F-01          | Access Control, NFR (privacy) | done        |
| S-05 | summary-credits           | start with 5 credits; each generation spends one             | F-01          | — (cost guardrail)            | done        |
| S-06 | app-design-system         | use the app through a coherent, production-like UI           | S-02          | — (product polish)            | planned     |

## Streams

Navigation aid — groups items that share a Prerequisites chain. Canonical ordering still lives in the dependency graph below; this table is the proposed reading order across parallel tracks.

| Stream | Theme                          | Chain                             | Note                                                                                          |
| ------ | ------------------------------ | --------------------------------- | --------------------------------------------------------------------------------------------- |
| A      | Core: transcript→summary       | `F-02` → `S-01` → `S-02` / `S-03` | Front-loads the top risk (external) per the "speed" goal; `S-02` and `S-03` run parallel after `S-01`. |
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
- **Status:** in progress — 7-phase plan written 2026-07-18 (`context/changes/generate-and-save-summary/plan.md`). Approach: productionize the F-02 probe pipeline (rename `probe`→`/api/summaries/generate`), add a dashboard generation UI, carry F-02 follow-ups (prompt-engineering, transcript-length guard, upstream-error handling), and add a variable-cost path (>40k transcript chars ⇒ 2 credits via new `spend_credits(amount)` RPC + `allowLong` confirmation). Testing manual-only (Module-3 deferral). **Plan-reviewed + hardened 2026-07-18→19** (RETHINK → SOUND, all 7 findings triaged/fixed): credit flow reworked to **debit-before-LLM + refund-on-failure** (new `refund_credits` service_role RPC) to close a concurrency budget bypass; migration made **expand-only** (drop of `spend_credit()` deferred to a follow-up contract migration to avoid a deploy window); added `HARD_MAX_TRANSCRIPT_CHARS` → 413 cap. **Implementation started 2026-07-19 (branch `generate-and-save-summary`): phases 1–3 of 7 landed** — P1 English UI copy (`4f48536`), P2 variable-cost `spend_credits`/`refund_credits` migration + credits service (`23d59cc`), P3 cost-policy helper (`b22d6f1`); automated checks green (migration up, build, lint), DB-level manual checks (spend/refund grants) pending. Phases 4–7 (endpoint rename/harden, `allowLong` confirmation gate, dashboard UI, prompt engineering) remain.

### S-02: User browses the list of summaries

- **Outcome:** the user browses the list of their saved summaries.
- **Change ID:** browse-summary-list
- **PRD refs:** FR-006
- **Prerequisites:** S-01
- **Parallel with:** S-03
- **Blockers:** —
- **Unknowns:** —
- **Risk:** Low risk. After S-01 the data already exists; this visible list surface is also the mechanism by which the user judges the "75% good-enough summaries" criterion over time. Sequenced after S-01 because without saved summaries there is nothing to browse.
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

## Backlog Handoff

| Roadmap ID | Change ID                 | Suggested issue title                          | Ready for `/10x-plan` | Notes                                       |
| ---------- | ------------------------- | ---------------------------------------------- | --------------------- | ------------------------------------------- |
| F-01       | video-summary-schema      | Data schema: videos/summaries tables + RLS     | done                  | Implemented + impl-reviewed (`impl_reviewed`); pending `/10x-archive`. |
| F-02       | transcript-llm-probe      | Spike: YouTube transcript → LLM on the Worker  | done                  | De-risk complete — free CF plan sufficient, Railway not needed. Implemented + impl-reviewed (`impl_reviewed`); pending `/10x-archive`. |
| S-01       | generate-and-save-summary | Generate and save a video summary              | in progress           | Plan written 2026-07-18 (7 phases), plan-reviewed + hardened 2026-07-18→19 (RETHINK → SOUND; all 7 findings fixed). **Implementation started 2026-07-19 (branch `generate-and-save-summary`, Linear MAR-7 → In Progress): phases 1–3 of 7 done** — P1 English copy (`4f48536`), P2 `spend_credits`/`refund_credits` (`23d59cc`), P3 cost policy (`b22d6f1`); automated checks green. Next: `/10x-implement generate-and-save-summary phase 4`. DB manual checks (2.4–2.6) + P1 banner (1.3) still pending. |
| S-02       | browse-summary-list       | List of saved summaries                        | no                    | Waiting on S-01                              |
| S-03       | delete-summary            | Delete a summary                               | no                    | Waiting on S-01; FR-007 nice-to-have         |
| S-04       | delete-account            | Delete account + all data (GDPR)               | done                  | Merged to `master` 2026-07-13 (`78bca68`), Linear MAR-10 → Done. Both phases implemented; Workers Secret set. Manual E2E passed; impl-review NEEDS ATTENTION (2 warnings, 3 observations), triage complete (F1/F3/F4 fixed, F2 skipped baseline drift, F5 tracker sync); lint + build green. Pending `/10x-archive`. |
| S-05       | summary-credits           | Credit budget for summary generation           | done                  | Merged to `master` 2026-07-14 (`482b686`), CI green + Worker deployed, Linear MAR-11 → Done. Formal review: **NEEDS ATTENTION** (5 warnings + 3 observations), 2026-07-13; **all 8 findings triaged + fixed 2026-07-14** (`10f91f4`), every dimension now PASS. All 4 phases implemented + manually verified. All 6 DB migrations are **live on cloud** (2026-07-14), privilege state verified post-push. Pending `/10x-archive`. |
| S-06       | app-design-system         | Production-like application design             | no                    | Waiting on S-02 (needs the surfaces it styles to exist); presentational scope only |

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
