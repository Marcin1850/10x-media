# Transcript Cost Guardrail Implementation Plan

## Overview

Bound the operator's Supadata spend per generation, and bound it across the fleet. Three mechanisms,
in order of how much they save: `mode: "native"` caps a single transcript at 1 credit (lever A); a
`metadata_cache` drives a repeat generation to 0 credits (D6); a budget breaker refuses to start paid
work when the monthly plan is nearly exhausted (lever C, minimal form). A new `summaries.metadata_via`
column records which of the three paths each generation actually took.

The design is **locked** — `context/foundation/roadmap.md` §S-09 carries the lever choice (A + C; B and
D rejected) and twelve numbered decisions D1–D12. This plan implements them; it does not re-open them.
Four things D1–D12 left genuinely open were decided during planning (2026-07-31) and are recorded in
`plan-brief.md`'s Key Decisions table.

## Current State Analysis

Every fact below was verified against the working tree, not carried over from the roadmap.

**The exposure is live and unbounded.** `fetchTranscript` builds its query inline at
`src/lib/services/transcript.ts:255` with `mode=auto`, whose documented behaviour is "try native, fall
back to generate" — silently. Supadata bills 2 credits/minute for a generated transcript against a
`Free (100/mo)` plan, so one ~50-minute video drains the month. `HARD_MAX_TRANSCRIPT_CHARS` cannot
help: it is evaluated at `generate.ts:410` and `:462`, both *after* the fetch that spends the money.

**Metadata is the entire cost of a repeat generation.** `fetchVideoMetadata` is called
unconditionally at `generate.ts:568` with no lookup, even though S-08 already persists
`channel_name` / `duration_seconds` / `published_at` to `videos`. With S-07's `transcript_cache` live,
the transcript on a repeat costs 0 and this call costs 1 — 100% of the spend.

**The `unavailable` 422 has three server-side sources and one client-side string.** `generate.ts:345`
(cache hit, `outcome !== 'ok'`), `:401` (fresh fetch returned `unavailable`), `:450` (whitespace-only
content) all emit `"Transcript unavailable for this video"`. Two details matter and are easy to miss:

- `:345` answers for **both** `'empty'` and `'unavailable'` cache rows. Only the second is the
  "no caption track exists" case D3 is about; `'empty'` is a vendor success on a wordless video.
- **The client discards the server's 422 string.** `GenerateSummaryForm.tsx:73` hardcodes
  `"No transcript is available for this video."` in `messageForStatus`. Cases 429, 500 and 400 already
  prefer `serverError`; 422 does not. A new server string alone would never reach a user.

**The negative-cache constant's comment is now false, not just its value.**
`TRANSCRIPT_CACHE_UNAVAILABLE_MAX_AGE_SECONDS` (`transcript-cache.ts:37`) justifies 24 h partly on
`unavailable` possibly meaning "Whisper failed". Under native-only that reading is void — the outcome
can only mean "no caption track exists".

**The ledger's null has two meanings, and a flat sum is wrong.** S-07 observed both: a `206
transcript-unavailable` is billed **1** credit and sends no `x-billable-requests` header, while a
*failed* metadata call is billed **0** and also sends none. `supadata_calls.billable_credits` is `null`
in both cases (`supadata-ledger.ts:133` stores the header verbatim and never guesses). Any credit total
derived from this table must branch on `outcome`.

**Patterns this plan follows rather than invents:**

- Shared user-agnostic cache keyed by `youtube_id`, definer-only, read/written through service-role
  RPCs, service wrapper that never throws — `transcript_cache` + `transcript-cache.ts` end to end.
- `persist_summary` is swapped by `drop function` + `create function`, never `create or replace`:
  a differing argument list produces a **second overload**, and grants are signature-scoped
  (`20260728120000_generation_telemetry.sql:18-19`, and the same reasoning again in
  `20260729120000_transcript_cache_too_long.sql:57-61`).
- Definer-only tables get `enable row level security` with **no policies** plus
  `revoke all … from public, anon, authenticated`, and each RPC is revoked then granted to
  `service_role` alone.
- A guard that cannot read its own state chooses a documented direction: `getCachedTranscript` fails
  **open** (a miss costs a credit), `recordTranscriptAttempt` fails **closed** (`generate.ts:360-365`,
  a 500 rather than proceed to the unbounded fetch it guards).

### Key Discoveries

- `transcript.ts:255` — the `mode=auto` literal. Lever A is one word; D2 makes it a named constant.
- `GenerateSummaryForm.tsx:66-90` — `messageForStatus`; 422 must join the `serverError`-preferring cases.
- `generate.ts:552-556` — the comment declaring `fetchVideoMetadata`'s placement load-bearing for three
  reasons, and naming relocation as "S-09 lever B's job". Lever B is rejected, so the comment stands and
  the call does not move (D7).
- `generate.ts:317-322` — the existing two-tier lookup (per-user quote, then shared cache) that the
  metadata lookup mirrors in shape.
- `20260728120000_generation_telemetry.sql:351-373` — `persist_summary`'s 23 parameters, the list this
  plan grows to 24.
- `20260728120000_generation_telemetry.sql:440-459` — the **coalescing** `videos` upsert. This is why
  D12 works by simply feeding cached values into the same `metadata` argument: no new write path.
- `supadata_calls.resolved_via` is deliberately **unconstrained** (no CHECK); `operation` and `outcome`
  are CHECKed. Relevant to what a migration is and is not needed for.
- `save_transcript_cache` serializes its duplicate-fetch signal with `pg_advisory_xact_lock(hashtext(...))`
  because a cold row cannot be `for update`-locked. `save_metadata_cache` needs no such signal.

## Desired End State

Per-generation Supadata spend is bounded at **2 credits** and knowable before any work starts:

| Case | Transcript | Metadata | Total |
| --- | --- | --- | --- |
| Cold video with captions | 1 | 1 | **2** |
| Cold video without captions | 1 | — (422 exits first) | **1** |
| Warm video, both windows | 0 | 0 | **0** |
| Caption-less retry past the 2 h window | 1 | — | **1** |

Verified by: a live pass reconciling `GET /v1/me`'s `usedCredits` delta against the per-outcome ledger
total for the same window, plus `summaries.metadata_via` showing `'stored'` on the repeat.

A user submitting a caption-less video is told *that specific thing* rather than a generic failure. The
operator's remaining budget is checked before every paid call, and a near-exhausted or exhausted plan
emits a structured event through one function that a monitoring tool can later receive.

## What We're NOT Doing

- **Not changing what a summary costs the user in app credits.** That is S-05's model. This slice
  changes only what the *operator* pays Supadata.
- **Not upgrading the Supadata plan.** Informed by this slice, decided elsewhere.
- **Not delivering the budget notification anywhere.** D5b: the seam is built, the receiver (Sentry or
  equivalent) lands later. **The warn threshold is decorative on delivery** — this is known and accepted.
- **Not backfilling `metadata_cache` from existing `videos` rows** (D11). Mixed provenance, unknown age.
- **Not negative-caching metadata failures** (D9). A failed metadata call is billed 0, so caching the
  failure saves nothing and persists nulls for a video whose next attempt would succeed.
- **Not restructuring the pipeline.** `fetchVideoMetadata` stays at `generate.ts:568` (D7).
- **Not adding an env var for `mode`** (D2). A secret-driven toggle re-enables the expensive path with
  no trace in the code.
- **Not screening the transcript for injection.** That is S-10, deliberately sequenced after this.
- **Not answering "is the Whisper job path reachable?"** D1 closes it permanently: under `native`,
  `resolved_via = 'job'` can never appear again, so S-07's hand-over item becomes unanswerable. Accepted.

## Implementation Approach

Four phases, ordered by dependency and by how much each can be verified on its own.

Phase 1 is the headline bound and needs no migration — it is the cheapest fix for the live exposure and
touches three files. Phase 2 adds the metadata cache, which is where the repeat-generation saving
actually comes from, and carries the one risky migration step (the `persist_summary` swap). Phase 3 adds
the breaker on top, and depends on Phase 2 having hoisted the metadata lookup — that lookup is what tells
the second check point whether it is needed at all. Phase 4 is the single deploy + live verification gate.

**Two honest caveats, carried from the roadmap rather than quietly dropped:**

1. **Lever A may save nothing measurable.** S-07 could not force the Whisper path at all — five submits
   across three videos returned `206 transcript-unavailable` under **both** `auto` and `generate`, never
   a `202`. If that path is unreachable on this plan, `mode: "auto"` never actually cost 2 credits/minute,
   and A buys a **contractual** worst-case bound rather than a measured saving. Worth having; not what the
   slice was originally sold as.
2. **A + C do not remove the fleet ceiling.** The resulting envelope still allows only ~50 cold videos per
   month on the Free (100/mo) plan. C bounds the overrun; it does not raise the ceiling.

## Critical Implementation Details

**The ledger delta must branch on `outcome`.** The breaker's "spend since the stored reading" figure
cannot be `sum(billable_credits)`: a `206 transcript-unavailable` is billed 1 credit and reports no
header, while a failed metadata call is billed 0 and also reports no header — both land as `null`. A
flat sum under-counts exactly the outcome that costs money. The per-outcome shape is load-bearing and
must not be simplified back:

```sql
sum(case
  when outcome = 'unavailable' then 1                      -- billable, never reports a header
  when outcome = 'error'       then coalesce(billable_credits, 0)
  else                              coalesce(billable_credits, 0)
end)
```

**Ordering inside Phase 2's migration.** The `metadata_cache` table and its RPCs are additive and safe
in any order, but `persist_summary` must be `drop`ped before being recreated, and its grants re-issued
against the **new** 24-argument signature — the old signature's grants disappear with the dropped
function. Getting this wrong leaves a stale 23-argument overload callable.

**Phase 2 opens a push/deploy window.** Between `supabase db push --linked` and `wrangler deploy`, the
live Worker calls a `persist_summary` signature that no longer exists, and every generation fails at
persist — after the LLM has been paid for. S-07 and S-08 both flagged this as their riskiest step and
both ran the two commands back to back. Phase 4 does the same.

**`metadata_ms` semantics change on a hit.** The column currently brackets a real HTTP call including
its ~1.2 s rate-limit retry sleep. On a cache hit it will bracket a DB read and read near zero — the
same situation `transcript_ms` is already in for a `'stored'` transcript, and `metadata_via` is what
explains it. Any query comparing `metadata_ms` across rows must filter on `metadata_via = 'fetched'`.

## Phase 1: Lever A and the `unavailable` split

### Overview

Stop generating transcripts, shorten the negative-cache window, and give the caption-less 422 its own
user-facing copy — end to end, server through client. No migration, no new tables.

### Changes Required:

#### 1. The `mode` lever

**File**: `src/lib/services/transcript.ts`

**Intent**: Stop the app ever requesting a Whisper-generated transcript, so a transcript costs exactly
1 credit and worst-case spend is knowable in advance (D1). Hard-coded, not configurable (D2) — a
secret-driven toggle would let the expensive path be re-enabled with no trace in the code.

**Contract**: A module-level named constant replaces the `mode=auto` literal in the query string at
line 255. The constant's comment must carry three things: the 1 vs 2-credits/minute price difference, the
capability loss (caption-less videos become permanently unsummarizable), and D1's consequence — that
`resolved_via = 'job'` can now never appear, closing S-07's open question by construction. `fetchTranscript`'s
signature, its three-way failure arm, and every meter call are unchanged. The `pollTranscriptJob` path
becomes unreachable in practice but is **not deleted** — it is the vendor's documented behaviour for a
`202`, and removing it would make re-enabling `auto` a rewrite instead of a one-word change.

#### 2. The negative-cache window

**File**: `src/lib/services/transcript-cache.ts`

**Intent**: Cut `TRANSCRIPT_CACHE_UNAVAILABLE_MAX_AGE_SECONDS` from 24 h to 2 h (D4), so a freshly
published video whose auto-captions arrive late is retryable within hours instead of a day.

**Contract**: `86_400` → `7_200`. **The comment must be rewritten, not just the value.** Its current
justification rests on `unavailable` possibly meaning "Whisper failed" — void under native-only, where
the outcome can only mean "no caption track exists". The new comment must also state the trade
explicitly, because it runs opposite to the rest of this slice: a caption-less video resubmitted five
times in a day now costs 5 credits instead of 1, buying user-visible correctness with operator credits.
Record that D4 and lever C are load-bearing for each other — if C is ever dropped, D4 is revisited in the
same breath. `TRANSCRIPT_CACHE_MAX_AGE_SECONDS` (30 days) is untouched.

#### 3. The `unavailable` 422, server side

**File**: `src/pages/api/summaries/generate.ts`

**Intent**: Under native-only, "this video has no captions" stops being a rare accident and becomes the
predictable answer for a whole class of videos. It gets its own copy; the other two causes keep the
generic string (D3).

**Contract**: Of the three 422 sites, **only** the `unavailable` cause changes. `:401` (fresh fetch,
`reason === "unavailable"`) takes the new string. `:345` must be **split** — it currently answers for both
`'empty'` and `'unavailable'` cache rows, and only the latter is D3's case; `'empty'` (a vendor success on a
wordless video) keeps the generic string, as does `:450` (whitespace-only content). Status stays 422 in all
three cases; only the `error` body differs. The new copy should name the cause and what the user can do —
that this video has no caption track, and that the app only summarizes videos that have one.

#### 4. The client's 422 handling

**File**: `src/components/summaries/GenerateSummaryForm.tsx`

**Intent**: Without this, item 3 is invisible — `messageForStatus` hardcodes the 422 string and drops the
server's.

**Contract**: `case 422` starts preferring `serverError` with the current string as its fallback, exactly
as `case 429`, `case 500` and `case 400` already do. The comment should follow the 429 precedent and name
why: three distinct causes answer 422, each with its own server message, and the fallback covers a non-JSON
response. No other client change — no new status, no new payload field.

### Success Criteria:

#### Automated Verification:

- Type checking and lint pass: `npm run lint`
- Build succeeds: `npm run build`
- No `mode=auto` or `mode=generate` literal remains: `grep -rn "mode=" src/lib/services/transcript.ts`
- All three 422 sites reviewed and only one string changed: `grep -n "status: 422" src/pages/api/summaries/generate.ts`

#### Manual Verification:

- A video with captions still summarizes end to end against the local stack.
- A caption-less video returns 422 and the **new** copy is what appears in the UI — not the client's fallback.
- An `'empty'` transcript still shows the generic copy (verifiable by writing an `'empty'` cache row directly).
- `transcript_cache` shows an `unavailable` row expiring in 2 h, not 24 h.

**Implementation Note**: Pause here for manual confirmation before starting Phase 2.

---

## Phase 2: `metadata_cache` and the hit marker

### Overview

A repeat generation of the same video stops re-paying for metadata. A `metadata_via` column on
`summaries` records whether each generation fetched, reused, or skipped it — without which
cost-per-generation queries start lying within a week of shipping (D10).

### Changes Required:

#### 1. Migration — cache table, RPCs, column, and the `persist_summary` swap

**File**: `supabase/migrations/20260731120000_metadata_cache.sql`

**Intent**: Add the shared metadata cache and the marker that makes its hits countable.

**Contract**: Four parts in one migration.

*`public.metadata_cache`* — keyed by `youtube_id` (primary key), holding the five fields
`VideoMetadata` carries (`title`, `thumbnail_url_reported`, `channel_name`, `duration_seconds`,
`published_at`) plus `fetched_at`. Keyed by video and **not** placed on `videos` for the same reason
S-07 kept transcripts off it (D6): `videos` is per-user with `on delete cascade`, so one account
deletion would evict data every other user shares. Column names and types mirror `videos` exactly, so a
cached row feeds the existing upsert without a mapping layer. RLS enabled with **no policies**, `revoke
all … from public, anon, authenticated` — definer-only, like `transcript_cache`. No negative-outcome
column: D9 declines to cache failures at all.

*`get_metadata_cache(p_youtube_id text, p_max_age_seconds integer)`* — returns the row if
`fetched_at > now() - interval`, else nothing. Simpler than `get_transcript_cache`, which needs two
windows because its outcomes expire differently; metadata has one outcome and one window (D8: 30 days,
for symmetry with `TRANSCRIPT_CACHE_MAX_AGE_SECONDS`). The window is a **caller-supplied argument**, not
baked in, following the same convention — the constant and its reasoning live together in the service.

*`save_metadata_cache(...)`* — upsert overwriting every field including `fetched_at`, non-coalescing,
matching `save_transcript_cache`'s rationale: a refresh past the window is exactly when the new value must
win. Returns `void`, **not** a duplicate-fetch signal — that signal exists for `transcript_cache` because a
duplicate transcript fetch is expensive and was worth measuring; a duplicate metadata fetch costs 1 credit
and is already visible in the ledger. No advisory lock, for the same reason.

*`summaries.metadata_via`* — `text`, nullable, `check (metadata_via is null or metadata_via in
('fetched', 'stored', 'skipped_budget'))`. Null on rows predating this migration. `'skipped_budget'` is
written by Phase 3 and is declared here so the constraint is not altered twice; nothing writes it yet.
A column comment must state that `metadata_ms` is only comparable across `'fetched'` rows.

*`persist_summary` swap, 23 → 24 arguments* — `drop function` with the **full old signature**, then
`create function` with `p_metadata_via text` appended, then `revoke`/`grant` against the **new**
signature. `create or replace` would produce a second overload rather than a replacement. Everything
about how the function decides — the `for update` ledger lock, the replay guard, the status gate, the
outcome tags, the settle, and the **coalescing** `videos` upsert — is preserved verbatim; only the
`summaries` insert column list grows by one.

#### 2. Metadata cache service

**File**: `src/lib/services/metadata-cache.ts` (new)

**Intent**: Wrap the two RPCs the way `transcript-cache.ts` wraps its own, and own the 30-day window
constant with its reasoning attached.

**Contract**: Exports `METADATA_CACHE_MAX_AGE_SECONDS` (2_592_000), `getCachedMetadata(admin,
youtubeId): Promise<VideoMetadata | null>` and `saveCachedMetadata(admin, youtubeId, metadata):
Promise<void>`. Both **best-effort and never throw**, mirroring `getCachedTranscript` — a miss on error
means a paid fetch, a wasted credit at worst, never a correctness problem. The RPC result is narrowed at
the boundary rather than destructured as `any` (the admin client is supabase-js's untyped default). The
window constant's comment must carry D8's reasoning: titles and thumbnails do change while
`duration_seconds` and `published_at` effectively do not, and a longer window is a decision to be argued
on its own merits rather than drifted into because it is cheaper.

#### 3. Endpoint wiring

**File**: `src/pages/api/summaries/generate.ts`

**Intent**: Look the video up before paying for it; keep the fetch where it is; make sure a hit still
populates the per-user `videos` row.

**Contract**: Three edits.

The **lookup is hoisted early** (D7) — placed alongside the existing transcript-cache lookup around
`:317-322`, ahead of the 413/409/402 exit gates. It is a free DB read, so none of the three reasons
documented at `:552-556` for the *fetch's* placement apply to it; and Phase 3 depends on knowing before
the debit whether metadata will be a paid call.

The **fetch does not move** (D7). At `:565-573`, `fetchVideoMetadata` is called only when the lookup
missed; the surrounding `try`/`catch`, the `metadata_ms` bracket, and the comment block at `:552-556`
stay exactly as they are. That comment must be **extended, not replaced**: a hit removes the request
outright so its 1 req/s reason lapses on its own, but its other two reasons still govern the miss path.
A successful fetch writes the cache.

`persistSummaryAndSettle` receives the new `metadataVia` argument. **The `metadata` argument is
populated on a hit exactly as on a fetch** — D12, stated explicitly because "hit → skip the write" is the
natural regression: S-02 renders its list from `videos`, so the per-user row must be populated on a hit
too. The cache **feeds** the upsert; it does not replace it.

#### 4. Service and type wiring

**Files**: `src/lib/services/summaries.ts`, `src/types.ts`

**Intent**: Carry `metadata_via` through the persist layer and the local schema shapes.

**Contract**: `MetadataVia = "fetched" | "stored" | "skipped_budget"` in `src/types.ts`, next to
`TranscriptResolvedVia` and documented the same way — that `'stored'` means no paid call was made, which
is what explains a near-zero `metadata_ms`. `summaries.ts` gains the field on `SummaryRow`, on
`persist_summary`'s `Args` in `AppDatabase`, and on `persistSummaryAndSettle`'s parameters, threaded to
`p_metadata_via`.

### Success Criteria:

#### Automated Verification:

- Migration applies cleanly to the local stack: `npx supabase migration up`
- Exactly one `persist_summary` overload exists afterwards (query `pg_proc`) — no stale 23-argument version
- `metadata_cache` and `summaries.metadata_via` exist with the intended constraints and grants
- Type checking and lint pass: `npm run lint`
- Build succeeds: `npm run build`

#### Manual Verification:

- First generation of a fresh video: `metadata_via = 'fetched'`, one `metadata` row in `supadata_calls`,
  a `metadata_cache` row written.
- Second generation of the same video (different character, or a second account): `metadata_via = 'stored'`,
  **no new `metadata` ledger row**, `metadata_ms` near zero.
- **D12 explicitly**: after the cache-hit generation, the second user's `videos` row carries title,
  thumbnail, channel, duration and published date — not nulls.
- A cache row aged past 30 days (by editing `fetched_at` directly) produces a fresh fetch.

**Implementation Note**: Pause here for manual confirmation before starting Phase 3. Nothing is deployed
yet — the `persist_summary` swap reaches production in Phase 4.

---

## Phase 3: The budget breaker

### Overview

Refuse to start paid work when the monthly Supadata plan is nearly exhausted, and emit a structured
event when it is close or tripped. Minimal form (D5): the breaker gates **spend, not the request** — a
cache hit costs 0 and is never blocked.

### Changes Required:

#### 1. Migration — budget reading table and RPCs

**File**: `supabase/migrations/20260731130000_supadata_budget.sql`

**Intent**: Persist the last `GET /v1/me` reading so it can be refreshed lazily instead of called
in-line on every request, and compute spend since that reading from the ledger.

**Contract**: Three parts, all additive — **no function is dropped**, so this migration opens no
deploy window of its own.

*`public.supadata_budget`* — a single row. `max_credits`, `used_credits`, `read_at`, and a `singleton
boolean primary key default true check (singleton)` so a second row is impossible by construction. RLS
enabled, no policies, `revoke all` — definer-only like every other guard table here.

*`get_supadata_budget(p_max_age_seconds integer)`* — returns the stored reading plus the per-outcome
ledger delta since `read_at`, and whether the reading is stale. The delta **must** use the
`case`-per-outcome form in Critical Implementation Details, not `sum(billable_credits)`. Returning both
in one call keeps the endpoint to a single round trip on the common path.

*`save_supadata_budget(p_max_credits integer, p_used_credits integer)`* — upsert the singleton row with
`read_at = now()`.

Why neither source suffices alone (D5): `/v1/me` is authoritative but is an HTTP call that would land
directly before the transcript fetch and break the 1 req/s spacing `generate.ts:552-556` maintains, while
`supadata_calls` is free and instant but does not know when the vendor's billing period resets, so a
purely ledger-derived total drifts out of phase.

#### 2. Budget service

**File**: `src/lib/services/supadata-budget.ts` (new)

**Intent**: Own the thresholds, the refresh, and the notification seam.

**Contract**: Exports the three constants with their reasoning, plus two functions.

Constants: `BUDGET_READING_MAX_AGE_SECONDS = 900` (15 min); `BUDGET_WARN_FRACTION = 0.8`;
`BUDGET_STOP_RESERVE = 2`. The stop reserve is **derived, not picked** — 2 is the worst-case cost of one
generation under lever A (1 transcript + 1 metadata), so refusing when `max - used - delta < 2` is exactly
the condition under which a generation could overdraw the plan. Its comment must say so, or the number
will be retuned by someone who reads it as arbitrary.

`checkBudget(admin, apiKey)` — reads the stored row; if stale, calls `GET /v1/me` in-line, saves the new
reading, and evaluates **warn** (D5a: only on refresh, at most once per TTL, which is what removes the
need for a `warned_at` column or period-reset logic — a naive "fire whenever above threshold" would be
one issue with thousands of events). Evaluates **stop** on **every** call with the ledger delta included:
it is the protection, so it must be exact to the call. Returns whether paid work may proceed.

**Fails open.** If neither a stored reading nor `/v1/me` is available, the call returns "proceed" — a
vendor outage on a free bookkeeping endpoint must not break a product whose transcript API is fine.
This differs from `recordTranscriptAttempt`'s fail-closed rate limit and the difference is deliberate:
that guard protects against unbounded spend, this one against a bounded overrun of a recoverable
budget. **The unreadable state is itself reported through the seam** — otherwise the guard is silently
off during exactly the window nobody can see.

`reportBudgetThreshold(...)` — **one named function** (D5). Not cosmetic and not a logging abstraction:
error-monitoring tools capture exceptions and treat console output as breadcrumbs attached to *other*
events, so a bare `console.warn` may never become an alert. One swappable call site for when a receiver
lands. It currently only logs. The payload must be **self-sufficient** — `used`, `max`, delta since the
reading, which threshold fired, and the reading's age — so the event is legible without a database query.
**Stop emits at higher severity than warn**: a refusal is an incident, not a warning, and reporting only
the warn level would surface the near-miss while hiding the actual outage.

**Deliberately incomplete (D5b)**: nothing receives these events. The monitoring tool lands later,
tracked outside this roadmap. Until then the warn threshold is decorative and budget exhaustion
surfaces via the stop threshold — users seeing an error, the worst channel and the one C exists to avoid.

#### 3. Endpoint wiring — two check points

**File**: `src/pages/api/summaries/generate.ts`

**Intent**: Gate each paid call, and nothing else.

**Contract**: Two call sites, both on a **miss** path.

*Before the transcript fetch* — inside the `else` branch that performs a real paid fetch (`:355`
onward), after the rate-limit check and before `fetchTranscript`. Never at the endpoint entrance: a
cache hit costs 0 and blocking it would break the product for no saving. On a trip, return a distinct
status with operator-shaped copy — the user should learn the service is temporarily unable to process
new videos, not see a generic failure. Reuse `messageForStatus`'s `serverError` preference rather than
adding a client branch.

*Before `fetchVideoMetadata`* — only reached when Phase 2's lookup missed. This point exists because on
a warm transcript with cold metadata, the metadata call **is** the first paid call: a breaker sitting only
in front of the transcript fetch is bypassed on exactly the traffic Phase 2's cache is designed to create.
On a trip here the generation is **not** refused — the user has already been debited and the LLM already
paid for, so refusing to protect a decorative thumbnail would be strictly worse. Skip the call, persist
nulls exactly as a metadata failure already does, and record `metadata_via = 'skipped_budget'` so the
degraded row explains itself.

### Success Criteria:

#### Automated Verification:

- Migration applies cleanly: `npx supabase migration up`
- `supadata_budget` cannot hold a second row (attempting an insert fails)
- The delta RPC returns 1 for an `unavailable` row with a null header, and 0 for an `error` row with a
  null header — the per-outcome branch, verified directly rather than assumed
- Type checking and lint pass: `npm run lint`
- Build succeeds: `npm run build`

#### Manual Verification:

- With `BUDGET_STOP_RESERVE` temporarily raised past the remaining balance, a cold video is refused
  **before** any Supadata call — verified by `usedCredits` not moving.
- Under the same override, a **warm** video still generates successfully. This is the D5 reshape that
  matters most: the breaker gates spend, not the request.
- Under the same override with a warm transcript and cold metadata: the summary is produced,
  `metadata_via = 'skipped_budget'`, and no `metadata` ledger row is written.
- With the stored reading deleted and an invalid API key, generation **proceeds** and the unreadable
  state is reported (fail-open, visibly).
- The warn event fires at most once per TTL, not once per request.

**Implementation Note**: Pause here for manual confirmation. The overrides must be reverted before Phase 4.

---

## Phase 4: Deploy and live verification

### Overview

One deploy covering all three phases, then a ~4-credit live pass against the real vendor.

### Changes Required:

#### 1. Deploy

**Intent**: Close the `persist_summary` swap window.

**Contract**: `npx supabase db push --linked` immediately followed by `npx wrangler deploy` — back to
back, as S-07 and S-08 both did. Between the two commands the live Worker calls a signature that no
longer exists and **every generation fails at persist, after the LLM has been paid for**. Confirm with
`npx supabase migration list --linked` that both migrations are in sync. No new Worker secrets: the
breaker uses the existing `SUPADATA_API_KEY`.

#### 2. Live verification pass

**File**: `context/changes/transcript-cost-guardrail/reviews/manual-verification.md` (new)

**Intent**: Prove the cost envelope against the vendor's own billing, the way S-07 proved cross-user
transcript reuse. Budget: **~4 credits**.

**Contract**: Record `GET /v1/me` before and after each step, alongside the per-outcome ledger total for
the same window; the two must agree. Four steps: a cold captioned video (expect +2); an immediate repeat
of it (expect **+0** — both caches hit, `resolved_via = 'stored'` and `metadata_via = 'stored'`); a
caption-less video (expect +1, a 422, and the **new** D3 copy visible in the UI); one metadata-only case
where the transcript is warm but metadata is cold (expect +1).

The document must state what was **not** verified live and why: the stop threshold cannot be reached
without spending ~95 credits, so Phase 3 verified it by overriding the constant; and D1 means the Whisper
job path is now unreachable by construction and will never be verified at all.

### Success Criteria:

#### Automated Verification:

- `npx supabase migration list --linked` shows both migrations applied
- The deployed Worker version is recorded
- Reconciliation query: the per-outcome ledger total for the verification window equals the observed
  `usedCredits` delta

#### Manual Verification:

- Total spend for the pass is within the ~4-credit budget.
- The repeat generation moves `usedCredits` by **0** — the headline claim.
- The caption-less video shows the new copy to the user, not the client fallback.
- `roadmap.md` §S-09 status and the Linear issue both reflect completion.

---

## Testing Strategy

This repo has no automated test suite (README, "Project status"), so verification is the two-tier
automated/manual split above: `npm run lint` + `npm run build` + direct SQL assertions as the automated
tier, and structured manual passes as the real coverage.

**SQL assertions worth writing directly** (Phases 2 and 3, cheap and repeatable):

- One `persist_summary` overload, not two, after the swap.
- `metadata_cache` and `supadata_budget` reachable by `service_role` only.
- The delta RPC's per-outcome branch, against hand-inserted `unavailable`/`error` rows with null headers.
  This is the one piece of logic where a plausible-looking simplification silently under-counts.

**Manual scenarios by phase**: caption-less 422 copy and the 2 h window (P1); cache hit / miss and the
D12 `videos` write (P2); the three breaker cases and fail-open (P3); the four-step credit pass (P4).

## Performance Considerations

Each cache lookup adds one Supabase round trip to a request that already makes several, and removes an
HTTP call to an external vendor when it hits — net faster on a hit, negligibly slower on a miss. The
breaker adds one round trip on the miss path and one `GET /v1/me` per 15-minute TTL, never per request.

`metadata_cache` grows one small row per distinct video, with no body — unlike `transcript_cache`, which
needed a `too_long` outcome to bound its rows. No pruning is needed at MVP scale.

## Migration Notes

Two migrations. `20260731120000_metadata_cache.sql` is the risky one — it drops and recreates
`persist_summary`, so it must be pushed and deployed back to back (Phase 4). `20260731130000_supadata_budget.sql`
is purely additive.

**Rollback**: reverting Phase 1 is a one-word change back to `auto` plus the copy. Reverting Phase 2
requires restoring the 23-argument `persist_summary` and dropping `metadata_via`; existing rows carrying
a non-null `metadata_via` are harmless to the old function, which simply never writes it. Reverting Phase
3 is code-only — the tables can be left in place, unread.

## References

- Locked design: `context/foundation/roadmap.md` §S-09, Decisions D1–D12 (2026-07-31)
- Vendor API reference: `context/changes/persist-video-metadata/docs/supadata-transcript.md`,
  `supadata-account-limits.md`, `supadata-metadata.md`
- The pattern this plan mirrors throughout: `context/changes/persist-time-and-cost/plan.md` (S-07)
- S-07's live findings, including the four hand-over items: `context/changes/persist-time-and-cost/reviews/manual-verification.md`
- Cache + ledger precedent: `supabase/migrations/20260728120000_generation_telemetry.sql`,
  `src/lib/services/transcript-cache.ts`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Lever A and the `unavailable` split

#### Automated

- [ ] 1.1 Type checking and lint pass
- [ ] 1.2 Build succeeds
- [ ] 1.3 No `mode=auto` / `mode=generate` literal remains
- [ ] 1.4 All three 422 sites reviewed, only one string changed

#### Manual

- [ ] 1.5 Captioned video still summarizes end to end
- [ ] 1.6 Caption-less video shows the new 422 copy, not the client fallback
- [ ] 1.7 `'empty'` transcript still shows the generic copy
- [ ] 1.8 `unavailable` cache row expires in 2 h, not 24 h

### Phase 2: `metadata_cache` and the hit marker

#### Automated

- [ ] 2.1 Migration applies cleanly to the local stack
- [ ] 2.2 Exactly one `persist_summary` overload exists afterwards
- [ ] 2.3 `metadata_cache` and `summaries.metadata_via` have the intended constraints and grants
- [ ] 2.4 Type checking and lint pass
- [ ] 2.5 Build succeeds

#### Manual

- [ ] 2.6 First generation: `metadata_via = 'fetched'`, ledger row written, cache row written
- [ ] 2.7 Second generation: `metadata_via = 'stored'`, no new ledger row, `metadata_ms` near zero
- [ ] 2.8 D12 — a cache hit still populates the per-user `videos` row
- [ ] 2.9 A row aged past 30 days produces a fresh fetch

### Phase 3: The budget breaker

#### Automated

- [ ] 3.1 Migration applies cleanly
- [ ] 3.2 `supadata_budget` cannot hold a second row
- [ ] 3.3 Delta RPC returns 1 for `unavailable`/null-header, 0 for `error`/null-header
- [ ] 3.4 Type checking and lint pass
- [ ] 3.5 Build succeeds

#### Manual

- [ ] 3.6 Cold video refused before any Supadata call under an overridden reserve
- [ ] 3.7 Warm video still generates under the same override
- [ ] 3.8 Warm transcript + cold metadata: summary produced, `metadata_via = 'skipped_budget'`
- [ ] 3.9 Unreadable budget state: generation proceeds and the state is reported (fail-open)
- [ ] 3.10 Warn fires at most once per TTL
- [ ] 3.11 Overrides reverted

### Phase 4: Deploy and live verification

#### Automated

- [ ] 4.1 `migration list --linked` shows both migrations applied
- [ ] 4.2 Deployed Worker version recorded
- [ ] 4.3 Reconciliation: per-outcome ledger total equals the observed `usedCredits` delta

#### Manual

- [ ] 4.4 Total spend within the ~4-credit budget
- [ ] 4.5 Repeat generation moves `usedCredits` by 0
- [ ] 4.6 Caption-less video shows the new copy live
- [ ] 4.7 `roadmap.md` §S-09 and the Linear issue reflect completion
