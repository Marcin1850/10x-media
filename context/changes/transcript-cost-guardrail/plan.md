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

**Scope extended 2026-08-01 (user), after Phase 1's manual verification.** That pass made two gaps
concrete enough to act on, and both are now phases of their own:

- **The 206 leaves no hard trace.** The ledger records `outcome`, never the HTTP status, so "this call
  cost a credit despite reporting no header" is a *derived* claim rather than an observed one. Phase 2
  records the status for transcript calls (D13).
- **A caption-less submit costs the operator 1 credit and the user 0.** The refusal exits ~200 lines
  before the debit, so nothing in the app makes the user feel a call we paid for. D4's 2 h window
  multiplies exactly this traffic. Phase 3 charges 1 app credit for a refusal in the billable class
  (D14). **This deliberately reopens what the original scope fenced off** — the "not changing what a
  summary costs the user" boundary below is gone, replaced by a narrower one.

## Current State Analysis

**This section is the pre-Phase-1 baseline, not the current working tree.** Every fact below was verified
against the tree as it stood on 2026-07-31, before any phase landed — that is what makes it the record of
*why* each phase exists. Phase 1 has since shipped locally (`TRANSCRIPT_MODE = "native"` at
`transcript.ts:72-99`, the 2 h negative window, the split 422 copy), so the first paragraph below no
longer describes the code; it describes what the code was rescued from. **Nothing is deployed** — Phase 7
is still the first push to production, so the baseline remains exactly true of what live users are
running today. Later phases were planned against this baseline and are unaffected.

**The exposure is live and unbounded** (as of the baseline; closed locally by Phase 1).
`fetchTranscript` built its query inline at `src/lib/services/transcript.ts:255` with `mode=auto`, whose
documented behaviour is "try native, fall back to generate" — silently. Supadata bills 2 credits/minute for a generated transcript against a
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

**The refusal exits long before the debit.** Verified against the working tree 2026-08-01. The order is:
402 balance gate (`:298-316`) → transcript acquisition with its 422 exits (`:345`, `:401`, `:450`) →
pricing (`:495`) → **`beginGeneration`** (`:551`, the actual debit) → LLM → `persist_summary` + settle.
Every 422 is roughly 200 lines upstream of the only place a credit is currently taken, which is why a
caption-less submit is free to the user. Charging on that path is therefore a **new** operation, not a
flag on an existing one.

**The credit ledger already supports a charge with no summary.** `credit_reservations` carries
`request_id` with a unique index on `(user_id, request_id) where request_id is not null and status <>
'refunded'` — idempotency for a retried request is already solved. `summaries.reservation_id` is the FK
and it points *from* summaries, so a settled reservation with no summary is a legal row, not an orphan.
The hourly reconciliation sweep refunds rows left in `'reserved'`, so a charge that reserves and settles
in one statement is never exposed to it.

**`supadata_calls` has no HTTP status column.** Confirmed against the live schema: `operation`,
`outcome`, `resolved_via`, `billable_credits` and the FKs — nothing records what the vendor actually
answered. So the 206 that costs a credit is identified today only by `outcome = 'unavailable'`, which is
our own classification applied at the call site.

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
- `generate.ts:551` — `beginGeneration`, the single existing debit. Phase 3 adds a second, earlier one
  on the refusal path; both must respect the same `requestId` idempotency key.
- `credits.ts:102-173` — `beginGeneration`'s discriminated outcome union (`reserved` / `replay` /
  `inProgress` / `insufficient` / …). Phase 3's RPC wrapper mirrors this shape rather than inventing
  a second error vocabulary for the same ledger.
- Phase 1's split left **five** 422 return statements, not three: cached `unavailable`, cached `empty`,
  fresh `unavailable`, fresh transient (`failed`/`timeout`), and whitespace. Phase 3's charge applies to
  four of them — the transient one is deliberately exempt (D14).

## Desired End State

Per-generation Supadata spend is bounded at **3 credits** and knowable before any work starts:

| Case | Transcript | Metadata | Total |
| --- | --- | --- | --- |
| Cold video with captions | 1 | 1 | **2** |
| Cold video with captions, metadata retried | 1 | 2 | **3** |
| Cold video without captions | 1 | — (422 exits first) | **1** |
| Warm video, both windows | 0 | 0 | **0** |
| Caption-less retry past the 2 h window | 1 | — | **1** |

**The bound is 3, not 2, and the difference is metadata's retry.** `fetchVideoMetadata` retries a
retryable failure once (`metadata.ts:169-178`), and that retry is **a second billable request** — the
helper's own comment says so (`:43-46`) and is the stated reason S-07 meters inside `requestMetadata`
rather than per generation. The breaker sits *in front of* the helper, so it cannot gate a retry that
happens inside it. Two credits is the **typical** cold cost; three is the **ceiling**, and every number
downstream (the stop reserve, the verification budget) is derived from three.

Verified by: a live pass reconciling `GET /v1/me`'s `usedCredits` delta against the per-outcome ledger
total for the same window, plus `summaries.metadata_via` showing `'stored'` on the repeat.

A user submitting a caption-less video is told *that specific thing* rather than a generic failure. The
operator's remaining budget is checked before every paid call, and a near-exhausted or exhausted plan
emits a structured event through one function that a monitoring tool can later receive.

**Every transcript call carries its HTTP status** (D13), so the reconciliation formula's
`unavailable → 1` branch rests on an observation rather than on our own outcome label — and the two can
be checked against each other.

**An unusable submission costs the user 1 credit** (D14). Four of the five 422 exits charge; the
transient one does not. The rule the app now enforces:

| Outcome for the user | User pays | Operator pays |
| --- | --- | --- |
| Summary delivered | `summaryCost` (1, or 2 long) | 0–3 |
| Video has no usable transcript, cold | **1** | 1 |
| Video has no usable transcript, cached | **1** | **0** |
| Transcript fetch failed transiently | 0 | unknown |
| Blocked at the 402 gate | 0 | 0 |

The third row is the deliberate asymmetry — a charge with no matching operator cost — accepted so that
the same action does not cost differently depending on cache state the user cannot see. The fourth is
the deliberate exemption: we do not resolve our own ambiguity against the user.

## What We're NOT Doing

- ~~**Not changing what a summary costs the user in app credits.**~~ **Removed 2026-08-01 (user).** This
  boundary is what left a caption-less submit free to the user and billable to the operator, and Phase 1's
  verification made the asymmetry concrete. Phase 3 now charges 1 credit for a refusal in the billable
  class. The replacement, narrower boundary: **not changing what a *successful* summary costs.**
  `summaryCost` (1 credit, or 2 for a long video) is untouched — S-05 still owns pricing for delivered
  work; this slice only prices the refusal.
- **Not upgrading the Supadata plan.** Informed by this slice, decided elsewhere.
- **Not charging for a transient transcript failure** (D14). `failed`/`timeout` stays free: the user did
  nothing wrong, and `error` with a null header means the cost is *unknown*, so charging would resolve
  our own ambiguity against them.
- **Not surfacing the charge in the UI** (D14, user's explicit call). The 422 copy is unchanged and the
  response body carries no balance. Consequence, recorded rather than discovered later: a user can lose
  several credits to repeated caption-less submits with no on-screen acknowledgement, including on cache
  hits where the operator paid nothing. Revisit here first if support questions appear.
- **Not backfilling `http_status`** (D13). Nullable, null for every pre-migration row — the same
  reasoning as D11: an unobserved value is not reconstructed from an inference.
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

Seven phases, ordered by dependency and by how much each can be verified on its own.

Phase 1 (**done**, verified 2026-08-01) is the headline bound and needs no migration — it is the cheapest
fix for the live exposure and touches four files.

**Phases 2 and 3 are the 2026-08-01 scope extension**, and both are deliberately cheap and early. Phase 2
adds `http_status` to the transcript ledger: one additive column, no deploy window, and it turns the
"a 206 costs a credit" claim from derived into observed. Phase 3 charges the user 1 credit for a refusal
in the billable class.

**Phase 3 sits ahead of the breaker on purpose.** Both bound the same overspend, but at different
granularity and cost: the charge is per-user, bites from the first event, and needs no vendor call;
the breaker only engages when the plan is nearly exhausted and protects the budget by refusing service
to everyone at once. The cheaper, more targeted guard should land first. Phase 3 also depends on
nothing — not `metadata_cache`, not the reservation ledger — so its placement blocks no other work.

Phase 4 adds the metadata cache, which is where the repeat-generation saving actually comes from, and
carries the one risky migration step (the `persist_summary` swap).

**Phases 5 and 6 are the breaker, split along the line where its verification changes character.** Phase
5 is the reservation ledger — a migration whose central property (concurrent reserves cannot overdraw) is
provable in two psql sessions, with nothing calling it yet. Phase 6 wires that mechanism into the
endpoint, and depends on Phase 4 having hoisted the metadata lookup, since that lookup is what tells the
second check point whether it is needed at all. Splitting them keeps a database-provable invariant from
being verified through a UI, and keeps the phase that touches the paid pipeline small enough to review.

Phase 7 is the single deploy + live verification gate.

**Migration order follows phase order**: `…100000_supadata_call_http_status` (P2),
`…110000_charge_failed_transcript` (P3), `…120000_metadata_cache` (P4), `…130000_supadata_budget` (P5).
Only P4's opens a deploy window; the other three are purely additive.

**Two honest caveats, carried from the roadmap rather than quietly dropped:**

1. **Lever A may save nothing measurable.** S-07 could not force the Whisper path at all — five submits
   across three videos returned `206 transcript-unavailable` under **both** `auto` and `generate`, never
   a `202`. If that path is unreachable on this plan, `mode: "auto"` never actually cost 2 credits/minute,
   and A buys a **contractual** worst-case bound rather than a measured saving. Worth having; not what the
   slice was originally sold as.
2. **A + C do not remove the fleet ceiling.** The resulting envelope still allows only ~50 cold videos per
   month on the Free (100/mo) plan. C bounds the overrun; it does not raise the ceiling.

## Critical Implementation Details

**The breaker does not do live arithmetic over `supadata_calls`.** This is the single most important
structural decision in Phase 5 and the natural design is the wrong one. `supadata_calls` rows are held
in an in-memory meter and flushed once in `POST.finally` (`generate.ts:100-125`), so during the entire
paid window of a request its own spend is invisible to every other request. A breaker that reads the
ledger is reading a figure that is stale by exactly the duration of the work it is trying to bound.
`created_at` compounds it: it is the batch's *insertion* time, not the HTTP call's, so it cannot be
compared against a `/v1/me` snapshot boundary without racing it. And `outcome = 'error'` with a null
header means **unknown**, not zero — a ledger-derived total silently reads a possible charge as free.

So live accounting moves to **reservations**, written synchronously at call time (below), and the
ledger keeps its original job: telemetry and after-the-fact reconciliation.

**Where the ledger total *is* still used — Phase 7's reconciliation — it must branch on `outcome`.**
It cannot be `sum(billable_credits)`: a `206 transcript-unavailable` is billed 1 credit and reports no
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

**The refusal charge must reuse the request's own `requestId`, not a fresh one.** This is the single
easiest way to get Phase 3 wrong. The endpoint already dedupes replays through
`respondToRepeatedRequest`, and `credit_reservations` enforces one row per `(user_id, request_id)`
unless refunded. A charge that generates its own key would bypass both: a client retrying an ambiguous
failure — the exact scenario `requestId` exists for — would be charged once per attempt. When
`requestId` is absent (a pre-F22 client), the charge must be skipped rather than made
non-idempotent — failing toward not charging is the correct direction for a fee the user cannot see.

> **Addendum (2026-08-04, Phase 3 impl review F1).** The skip-when-absent rule above is right *inside*
> the handler, but leaving `requestId` optional in `generateSchema` exported it to the trust boundary:
> any authenticated caller could omit the field and drive the paid `unavailable` path for free. The
> field is now **required** in `generateSchema`; the null-tolerant branches in `refuseAndCharge` and
> `runGeneration` stay as an internal safety net. The pre-F22 compatibility clause is therefore
> superseded — a cached old client receives a 400 until it reloads, accepted because the only
> first-party call site (`GenerateSummaryForm.tsx`) has always sent `crypto.randomUUID()`.

**The charge is settled in the same statement that reserves it.** Not two calls. A `'reserved'` row is
what the hourly reconciliation sweep refunds, so a reserve-then-settle pair would be racing a sweep for
no benefit — there is no work in between to fail. One RPC that inserts the row already `'settled'` is
both simpler and immune to it.

**Ordering inside Phase 4's migration.** The `metadata_cache` table and its RPCs are additive and safe
in any order, but `persist_summary` must be `drop`ped before being recreated, and its grants re-issued
against the **new** 24-argument signature — the old signature's grants disappear with the dropped
function. Getting this wrong leaves a stale 23-argument overload callable.

**Phase 4 opens a push/deploy window.** Between `supabase db push --linked` and `wrangler deploy`, the
live Worker calls a `persist_summary` signature that no longer exists, and every generation fails at
persist — after the LLM has been paid for. S-07 and S-08 both flagged this as their riskiest step and
both ran the two commands back to back. Phase 7 does the same.

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

**Implementation Note**: Pause here for manual confirmation before starting Phase 2. **Done — all four
manual rows verified locally 2026-08-01**, record at `reviews/manual-verification-phase-1.md`.

---

## Phase 2: `http_status` on the transcript ledger

### Overview

Record what the vendor actually answered, for transcript calls only. Today the fact that a 206 costs a
credit is a *derived* claim — inferred from `outcome = 'unavailable'`, which is our own label applied at
the call site — and the reconciliation formula depends on that inference being right. One additive
column turns it into an observation (D13).

One migration, one service touch, no deploy window, no behaviour change.

### Changes Required:

#### 1. Migration — the column

**File**: `supabase/migrations/20260731100000_supadata_call_http_status.sql`

**Intent**: Give the ledger a place to record the vendor's HTTP status so the billable-206 case is
observed rather than reconstructed.

**Contract**: `alter table public.supadata_calls add column http_status integer` — nullable, **no CHECK
constraint** (mirroring `resolved_via`, which is deliberately unconstrained; `operation` and `outcome`
are CHECKed because code branches on them, and nothing branches on a status code). No backfill and no
default: every pre-migration row keeps `null`, which reads correctly as "not recorded" (D13). No RPC or
grant change — `supadata_calls` is written through the existing insert path.

A column comment must state what a reader needs to interpret a null, and there are **three** ways to get
one: a pre-migration row, a call that is not `operation = 'transcript'` (the only operation populated),
and a transcript call whose request never produced a response at all — a timeout or transport rejection,
where no status exists to record. What `null` never means is "the vendor answered without a status".
The third case is the one a reader is most likely to misread as missing data, so name it explicitly.

#### 2. Plumb the status through the meter

**Files**: `src/lib/services/supadata-ledger.ts`, `src/lib/services/transcript.ts`

**Intent**: Carry the response status from the one place that has it to the row that records the call.

**Contract**: `SupadataCallRecord` (and the `record(...)` signature at `supadata-ledger.ts:57`) gains an
optional `httpStatus?: number`, defaulting to `null` exactly as `resolvedVia` and `billableCredits`
already do — so **no existing call site needs to change**, which is what keeps `metadata` and
`transcript_poll` out of scope without a special case. `fetchTranscript` records the status on every arm
that records a call, including the failure arms: a `206` is the case this phase exists for, but a
`4xx`/`5xx` recorded alongside `outcome = 'error'` is what will later resolve the *other* ambiguous null
the plan documents.

**`fetchTranscript` cannot reach `response.status` today, and this is the whole work of the phase.** The
`Response` never leaves `supadataGet`, which returns `{ body, billableCredits }` (`transcript.ts:158-224`)
and throws `BilledSupadataError` carrying `billableCredits` alone (`:234-244`). So "pass `response.status`"
is not an instruction that can be followed as written; the status needs the same two-path treatment
`billableCredits` already has, and the plan specifies both paths rather than leaving the failure arm to
be discovered mid-implementation:

- **Success path**: `supadataGet` returns `{ body, billableCredits, httpStatus }`, reading
  `response.status` beside the existing `readBillableCredits(response)` call at `:171` — the one place
  that already exists for "read it before anything can throw".
- **Failure path**: `BilledSupadataError` takes and retains `httpStatus: number | null`, and a
  `httpStatusFromError(error)` helper mirrors `billedFromError` (`:246-249`) exactly, returning `null`
  for anything that is not a `BilledSupadataError`. The four in-helper throw sites (`:176`, `:188`,
  `:202`, `:213`) pass `response.status`; the transport-rejection case — no response at all — keeps
  `null`, which reads correctly as "the vendor never answered" rather than as a status we failed to
  record.

Both `fetchTranscript`'s recording arms and `pollTranscriptJob`'s then read the status the same way they
already read the billed figure. `httpStatus` stays optional on the record, so the poll arms may pass it
without widening this phase's scope — but the migration's column comment stays true either way, since
`transcript_poll` is a distinct `operation`.

**Do not invent a status for the `Response`-less rejection.** A timeout or a DNS failure produced no
response, so there is no status to record and `null` is the honest answer — the same kind of null as an
unreported `x-billable-requests` header. This is a **third** meaning for `null` and the column comment
must say so; see the migration above.

**Scope boundary, stated because the temptation is obvious**: `fetchVideoMetadata` is **not** touched
(user's call). Metadata's null-billable case is a *failed* call billed 0 — knowing its status would be
informative but is not what this phase is for, and touching `metadata.ts` would pull the retry helper
into a phase that otherwise has no behaviour risk at all.

### Success Criteria:

#### Automated Verification:

- Migration applies cleanly to the local stack: `npx supabase migration up`
- `supadata_calls.http_status` exists, is nullable, and carries no CHECK constraint
- Pre-migration rows still read `null` — the migration backfilled nothing
- Type checking and lint pass: `npm run lint`
- Build succeeds: `npm run build`

#### Manual Verification:

- A caption-less video records `http_status = 206` alongside `outcome = 'unavailable'` and a null
  `billable_credits` — the exact row shape the reconciliation formula's `unavailable → 1` branch assumes,
  now visible rather than inferred.
- A captioned video records `http_status = 200` with `billable_credits = 1`.
- The `metadata` row written by the same generation has `http_status = null` — confirming the scope
  boundary holds rather than leaking through a shared helper.
- A forced vendor error (a bad key, or a stubbed non-2xx) records that status alongside
  `outcome = 'error'` — the failure arm carries the status too, which is the half that needs
  `httpStatusFromError` and is easy to leave unplumbed because the success path looks complete.

**Implementation Note**: Pause here for manual confirmation before starting Phase 3. Nothing is deployed;
this migration reaches production in Phase 7.

---

## Phase 3: Charging for a refusal in the billable class

### Overview

A submit that costs the operator a Supadata credit now costs the user an app credit. Phase 1's
verification measured the asymmetry: a caption-less video spends 1 operator credit and 0 user credits,
and D4's 2 h negative window deliberately multiplies that traffic.

**Four of the five 422 exits charge; the transient one does not** (D14). The rule is drawn around what
the user submitted, not around what we happened to pay:

| 422 exit | Charges? | Why |
| --- | --- | --- |
| Fresh fetch, `unavailable` (`:401`) | **yes** | The 206 we paid for. The canonical case. |
| Cached `unavailable` (`:345`) | **yes** | Same submission, same answer; see the note below. |
| Cached `empty` (`:345`) | **yes** | A video with no words is still an unusable submission. |
| Whitespace-only (`:450`) | **yes** | Same. |
| Fresh transient, `failed`/`timeout` (`:401`) | **no** | Our outage or the vendor's, and `error` + null header means the cost is *unknown*. |

**The cache-hit charge is the one place in this slice where we take a credit having paid nothing**, and it
is deliberate. The alternative — free inside the 2 h window, charged outside it — makes the same action
cost differently depending on invisible state, which reads as a bug and rewards rapid resubmission of
exactly the videos the window exists to re-check. A flat rule is defensible; a window-dependent one is
not. Recorded here so a later review sees a decision rather than an oversight.

### Changes Required:

#### 1. Migration — the charge RPC

**File**: `supabase/migrations/20260731110000_charge_failed_transcript.sql`

**Intent**: Debit one credit and record it as already-settled, in a single atomic statement, keyed for
idempotency by the caller's `request_id`.

**Contract**: One new column and two functions, no new table — `credit_reservations` is the right home
and already has the constraints this needs.

*`credit_reservations.refusal_reason`* — `text`, nullable, `check (refusal_reason is null or
refusal_reason in ('unavailable', 'empty', 'whitespace'))`. Null on every existing row and on every
row a normal generation writes; non-null **only** on a row written by the charge below. This column is
what makes the charge replayable — see the retry contract below, which is the reason it exists.

*`charge_failed_transcript(p_user_id uuid, p_request_id uuid, p_amount integer, p_refusal_reason text)`*
— inside one transaction: lock the user's `user_credits` row, and if the balance covers `p_amount`,
decrement it and insert a `credit_reservations` row with `status = 'settled'`, `resolved_at = now()`
and the classification. Inserted **settled, never `'reserved'`** — there is no work between reserve and
settle, and a `'reserved'` row is what the hourly reconciliation sweep refunds.

Returns a discriminated outcome mirroring `begin_generation`'s vocabulary rather than inventing a second
one: `'charged'` with the new balance, `'replay'` when `(user_id, request_id)` already carries a
non-refunded row, `'insufficient'` when the balance will not cover it. `'replay'` must be reachable
through the **existing** unique index — do not add a second one.

`security definer`, `revoke all … from public, anon, authenticated`, `grant execute … to service_role`
alone, like every other credit RPC.

**`'insufficient'` is not an error here.** The 402 gate upstream blocks a zero balance before any paid
call, so reaching this function with too little credit means the balance changed mid-request. The charge
is simply skipped — the user still gets their 422. Refusing to answer because we could not bill would be
strictly worse for someone we already declined to serve.

*`get_refusal_replay(p_user_id uuid, p_request_id uuid)`* — returns the `refusal_reason` of the
non-refunded `credit_reservations` row for that key, or null when there is none. Read-only, definer,
`service_role` only. Trivial, and it exists for the reason below.

**The retry contract: a repeated `requestId` must replay the 422, not turn into a 409.** This is the
non-obvious half of Phase 3 and the plan previously stopped one step short of it. Idempotency here is
*not* satisfied by "the balance does not move a second time" — the reply must also be the same reply.

The order that makes this necessary is already in the code. `runGeneration` probes
`beginGeneration(… amount: null)` at `generate.ts:282-296`, **before** any transcript work and therefore
before every 422 exit this phase charges at. Our charge writes a settled reservation with no summary, and
`begin_generation` classifies exactly that as `'unavailable'`
(`20260723130000_idempotent_generation.sql:139-152`), which `respondToRepeatedRequest` answers with a
**409 "This request was already processed. Start a new generation."** (`generate.ts:199-202`). So without
this rule, the second attempt of a caption-less submit silently loses the caption-specific copy Phase 1
exists to deliver — and the balance-only success criterion would pass while it happened.

**Contract**: in the `'unavailable'` branch only, the endpoint calls `get_refusal_replay`. A non-null
reason replays the **original 422** with the same body that reason produced the first time; a null reason
keeps today's 409 verbatim.

**The null case is load-bearing, not a fallback.** 409's comment states its cause precisely — "only an
operator-side settle produces this". Those rows carry no `refusal_reason`, so they keep the 409 they
were written for. The new column is what distinguishes "we refused this video and charged for it" from
"an operator closed this key", and collapsing the two would either hide an operator action behind a
transcript message or start telling users to start over after a refusal that will refuse identically.

**No deploy window.** `begin_generation` is deliberately **not** touched: adding an outcome would change
its return type, which `create or replace` cannot do, forcing a drop/recreate and giving Phase 3 exactly
the deploy-ordering risk that currently belongs to Phase 4 alone. One extra read on a rare path is the
right trade for keeping this migration purely additive.

#### 2. Credits service wrapper

**File**: `src/lib/services/credits.ts`

**Intent**: Expose the RPC the way `beginGeneration` is exposed, and keep the charge non-fatal.

**Contract**: `chargeFailedTranscript(admin, { userId, requestId, amount, refusalReason })` returning a
discriminated union over the three outcomes above, narrowed at the boundary like `beginGeneration`'s row
parsing. It **never throws**: a Supabase error is logged and reported as "not charged". The direction is
deliberate and opposite to the debit on the success path — there the throw protects the user from paying
for nothing; here a failure to charge costs the operator one credit, and answering the user's request
matters more.

`lookupRefusalReplay(admin, { userId, requestId })` wraps `get_refusal_replay`, returning the
classification or `null`. It **also never throws** — but note the direction is the opposite one, and
deliberately so: on a Supabase error it returns `null`, which yields today's 409 rather than a replayed
422. Failing toward the existing behaviour is right for a lookup whose only job is to *improve* a reply
that already exists.

#### 3. Endpoint wiring

**File**: `src/pages/api/summaries/generate.ts`

**Intent**: Charge on the four billable-class exits, and nowhere else.

**Contract**: A single local helper — `refuseAndCharge(...)` or equivalent — invoked at the four exits so
the charge cannot drift apart from the refusal it accompanies. It awaits the charge, ignores the outcome
for response purposes, and returns the same 422 body as today. It takes the classification
(`'unavailable'` / `'empty'` / `'whitespace'`) alongside the copy, so the stored reason and the message
are chosen in one place and cannot diverge — the replay below reconstructs the message *from* the reason,
so a mismatch here would surface as a retry answering with different copy than the original.

**The `'unavailable'` probe branch gains the replay.** `respondToRepeatedRequest` (`generate.ts:181-206`)
currently maps that outcome straight to 409. It becomes async, or the branch moves to its caller at
`:294-295`: on `'unavailable'`, call `lookupRefusalReplay`; a non-null reason returns the 422 that reason
produced originally, a null one returns the existing 409 unchanged. The `'replay'` and `'inProgress'`
branches are untouched.

**The response is unchanged** (D14, user's explicit call): same status, same `error` string, **no
`creditsRemaining` field**. The client is not touched in this phase at all. The consequence is recorded
in "What We're NOT Doing" rather than mitigated.

`requestId` is threaded from the already-parsed body. **When it is absent, skip the charge** — see
Critical Implementation Details: a generated key would make the fee non-idempotent across exactly the
retries `requestId` exists to absorb, and a caption-less submit is a plausible thing for a client to
retry.

The transient exit at `:401` must be left alone. It shares a `return` with the `unavailable` case only if
Phase 1's split left them adjacent; the charge branches on the same `reason` value the copy already
branches on, so the two decisions stay visibly aligned in one place.

### Success Criteria:

#### Automated Verification:

- Migration applies cleanly to the local stack: `npx supabase migration up`
- `charge_failed_transcript` is executable by `service_role` only
- A second call with the same `(user_id, request_id)` returns `'replay'` and does **not** decrement again
- A call against a zero balance returns `'insufficient'` and writes no row
- `get_refusal_replay` returns the stored reason for a charged key, and `null` for a settled,
  summary-less row written **without** one (the operator-settle case, which must keep its 409)
- The charge is invoked at exactly four sites, not five:
  `grep -n "refuseAndCharge\|chargeFailedTranscript" src/pages/api/summaries/generate.ts`
- Type checking and lint pass: `npm run lint`
- Build succeeds: `npm run build`

#### Manual Verification:

- Caption-less video, cold: 422 with the Phase 1 copy, balance drops by 1, and one `settled`
  `credit_reservations` row for that `request_id` with **no matching `summaries` row**. Note the
  direction: `credit_reservations` has no `summary_id` column — the FK points the other way, from
  `summaries.reservation_id` (`20260722120000_link_summary_to_reservation.sql:25-35`) — so the assertion
  is a `not exists` (or left join) against `summaries`, not a null check on the reservation.
- Immediate resubmit of the same video (cache hit, **new** `requestId`): balance drops by 1 again, and no
  Supadata call is made — the asymmetry this phase accepts, observed deliberately rather than discovered.
- Resubmit with the **same** `requestId`: balance does **not** move a second time, **and the response is
  the same 422 with the same copy** — not a 409 "start a new generation". Checking only the balance would
  pass while the caption-specific answer was silently lost.
- A settled, summary-less reservation with **no** `refusal_reason` (write one directly, as an operator
  settle would) still answers 409 — the replay is scoped to charges, not to every closed key.
- A seeded `'empty'` cache row charges; a forced transient failure does **not**.
- A successful generation still costs exactly `summaryCost` — the refusal charge never stacks onto the
  happy path.
- Balance 0: the 402 gate still answers first, and no charge row is written.

**Implementation Note**: Pause here for manual confirmation before starting Phase 4.

---

## Phase 4: `metadata_cache` and the hit marker

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
written by Phase 6 and is declared here so the constraint is not altered twice; nothing writes it yet.
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

The **lookup is hoisted early** (D7) — placed alongside the existing transcript-cache lookup at
`:317-322`, which means **after** the 402 balance gate (`:298-316`) and **before** the 413/409 exits.
Note the correction: the 402 gate is upstream of those lookups, not downstream, so "ahead of all three
exit gates" is not a placement that exists. After-402 is also the right place on its own merits — a user
with no credits should not trigger even a free read — and it still lands before the debit, which is all
Phase 6 needs. It is a free DB read, so none of the three reasons documented at `:552-556` for the
*fetch's* placement apply to it.

**`metadata_ms` is measured where the work happens, not where the variable is declared.** Bracket the
early DB read, carry the duration forward in a `metadataMs` variable, and on a **miss** overwrite it with
the late HTTP fetch's duration — the existing bracket at `:565-573` stays exactly as it is and simply
wins when it runs. So a `'stored'` row reports the DB read (near zero) and a `'fetched'` row reports the
HTTP call including its retry sleep, which is precisely what `metadata_via` exists to disambiguate.

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

**Implementation Note**: Pause here for manual confirmation before starting Phase 5. Nothing is deployed
yet — the `persist_summary` swap reaches production in Phase 7.

---

## Phase 5: The reservation ledger

### Overview

Build the atomic mechanism and prove it **before anything depends on it**. This phase is a migration and
nothing else: no service, no endpoint change, no user-visible behaviour. The app does not call these RPCs
when the phase ends.

That is the point of the split. The property this whole lever rests on — two concurrent reserves against
a one-generation budget yield one reservation and one refusal — is a database property, provable in two
psql sessions in minutes. Bundled with the wiring it would be verified last, through the UI, where a
failure is indistinguishable from a dozen other things. Verified here it is a closed question before a
single call site exists.

### Changes Required:

#### 1. Migration — budget reading, reservations, and RPCs

**File**: `supabase/migrations/20260731130000_supadata_budget.sql`

**Intent**: Persist the last `GET /v1/me` reading so it can be refreshed lazily instead of called
in-line on every request, and make "is there budget for this call?" an **atomic reserve**, not a read
followed later by a spend.

**Contract**: Five parts, all additive — **no function is dropped**, so this migration opens no deploy
window of its own.

*`public.supadata_budget`* — a single row. `max_credits`, `used_credits`, `read_at`,
`refresh_claimed_at`, and a `singleton boolean primary key default true check (singleton)` so a second
row is impossible by construction. RLS enabled, no policies, `revoke all` — definer-only like every
other guard table here. **This row is also the fleet's serialization point**: every reserve locks it
`for update`, which is what turns concurrent read/evaluate/spend into a queue. That is the whole reason
a singleton is right here rather than merely tidy.

**The migration seeds the row, and seeds it uninitialized.** `max_credits`, `used_credits` and `read_at`
are all **nullable**, and the migration ends with an `insert … on conflict do nothing` that creates the
one row with all three null. This is not tidiness — a serialization point that does not exist cannot be
locked, and `select … where singleton for update` on an empty table returns no row, silently skipping
the queue the whole lever rests on. Seeding makes the lock unconditional from the first request on a
fresh deployment.

`read_at is null` is the **uninitialized** state and must be read as "no authoritative reading has ever
been taken", never as "a very old reading". The distinction matters because the two take different
paths: a stale reading still supports a decision (the reservations since `read_at` bound the drift), an
absent one supports none at all. The column comment must say so.

*`public.supadata_reservations`* — one row per *in-flight or recently settled* paid provider call:
`reservation_id uuid primary key default gen_random_uuid()`, `credits integer not null` (the maximum
the call could bill), `actual_credits integer` (null until settled, and **null also means "settled but
unknown"** — see below), `settled boolean not null default false`, `settled_at timestamptz` (null until
settled), `created_at timestamptz not null default now()`. Same definer-only treatment. Indexed on
`created_at` for the sweep and the delta, and on `settled_at` for the pruning boundary below.

**`settled_at` is what makes the refresh safe to prune against.** `created_at` cannot answer "is this
call's spend already inside the vendor's snapshot?" — a reservation created long before a `/v1/me` read
may still be *in flight* when that read is taken, in which case the snapshot cannot contain it. Only a
call that finished before the reading was taken is certainly represented in it. Without this column the
save RPC has no way to tell the two apart and must either double-count or delete live work; see
`save_supadata_budget`.

*`reserve_supadata_credits(p_credits integer, p_stop_reserve integer, p_reading_max_age_seconds integer,
p_stale_seconds integer)`* — the breaker itself, and the only place the decision is made. In order,
inside one transaction:

1. **Sweep** reservations older than `p_stale_seconds` that are still unsettled. A Worker killed
   mid-call leaves a row behind, and without a sweep that row wedges the breaker permanently. This is
   the same reasoning and the same shape as `acquire_generation_lease`'s stale sweep
   (`20260720170000_generation_lock_lease.sql:44-46`) — reuse it rather than inventing a variant.
2. **`select … from supadata_budget where singleton for update`** — the serialization point. The row
   is guaranteed to exist because the migration seeds it; the RPC must nonetheless not assume its
   *contents*, only its presence.
3. **Decide whether a reading is usable at all, and return before reserving if it is not.** Under the
   same lock, if `read_at is null` (never initialized) **or** `read_at` is older than
   `p_reading_max_age_seconds` (stale), and no other caller currently holds the refresh claim, stamp
   `refresh_claimed_at` and return **`refresh_required`** — inserting **no** reservation row. If
   another caller already holds the claim, fall through to step 4 and decide on the reading we have
   (or, when there is none at all, return `uninitialized` so the caller can fail open explicitly
   rather than evaluate against nulls).
4. Compute `remaining = max_credits - used_credits - outstanding`, where `outstanding` is
   `sum(coalesce(actual_credits, credits))` over reservations that are unsettled **or** were settled
   after `read_at`. The `coalesce` is the pessimism that makes this correct: an unsettled call and a
   settled-but-unknown one both count at their reserved **maximum**, so an ambiguous failure is
   charged rather than forgiven. Only a call that reported a real `x-billable-requests` value gets
   counted at its actual figure.
5. Decide: refuse if `remaining - p_credits < p_stop_reserve`; otherwise insert the reservation row
   and return its id.

**Why refresh is a state *before* the reservation, not a flag on it.** The obvious shape — reserve,
then tell the caller to refresh — is wrong, and wrong in a way that silently disarms the breaker. The
refresh ends in `save_supadata_budget`, which prunes reservations the new reading already contains; the
claimant's own reservation was necessarily created before that save, has not been spent yet, and cannot
be in the snapshot. Any pruning rule expressed in `created_at` therefore deletes the row protecting the
call that is about to happen: the later settle finds nothing, and concurrent callers re-spend credit
that was supposedly held. Splitting the states removes the problem at the source rather than patching
the pruning rule — a caller that must refresh holds **no reservation while it does so**, and reruns the
whole decision afterwards against the fresh reading. The decision is therefore always made against a
reading the reservation postdates.

The four outcomes are disjoint and the caller must handle all of them: `reserved` (id returned, spend
authorized), `refused` (over the stop reserve), `refresh_required` (no reservation, caller must refresh
and call again), and `uninitialized` (no reading and someone else is already fetching one — fail open,
untracked). The service union in Phase 6 mirrors these one-for-one and adds one case the RPC cannot
report on its own.

**Every decision also returns the statistics behind it**, under the same lock that produced it:
`max_credits`, `used_credits`, the `outstanding` total just computed, and `read_at`. This is not
telemetry padding — Phase 6's threshold report promises a self-sufficient payload (used, max, delta,
which threshold fired, reading age), and the only alternative is a second read after the lock has been
released. That read races every other reserve and would report figures that never coexisted, which is
worse than useless in an incident. The numbers leave the lock with the decision they justify or they
are not trustworthy at all.

*`settle_supadata_reservation(p_reservation_id uuid, p_actual_credits integer)`* — marks the row
settled, stamps `settled_at = now()`, and records the real figure, or leaves `actual_credits` null when
the vendor reported none. **It never deletes the row**: deleting it before the ledger flush would open a
window where the spend is visible nowhere at all. Rows are cleared by the next `/v1/me` refresh, which
supersedes them.

*`save_supadata_budget(p_max_credits integer, p_used_credits integer, p_read_taken_at timestamptz)`* —
update the singleton row (it always exists) with the new figures and `read_at = p_read_taken_at`, clear
`refresh_claimed_at`, and **delete only reservations that were settled at or before `p_read_taken_at`**
— those, and only those, are certainly inside the vendor's snapshot, so keeping them would double-count.
Everything unsettled, and everything settled after the reading was taken, is **retained**: the snapshot
cannot contain work that had not finished when it was taken, and deleting such a row would forgive real
spend and strand a pending settle.

**`p_read_taken_at` is the caller's pre-call timestamp, not `now()`.** The caller records the clock
immediately *before* issuing `GET /v1/me` and passes that value. Using `now()` inside the RPC would
place the boundary after the HTTP round trip, sweeping away calls that settled *during* it — calls the
snapshot provably cannot include, since it was computed by the vendor before they finished. Pessimism
belongs on the retention side: retaining a reservation the reading already covers costs a temporarily
over-conservative breaker, deleting one it does not covers costs real overdraw.

Bounding follows from this rather than from a separate pruning job: every settled reservation is
deleted by the first refresh that postdates its settlement, so the table holds at most the in-flight
calls plus one TTL's worth of completed ones.

Why neither source suffices alone (D5): `/v1/me` is authoritative but is an HTTP call that would land
directly before the transcript fetch and break the 1 req/s spacing `generate.ts:552-556` maintains,
while reservations are free and instant but do not know when the vendor's billing period resets, so a
purely local total drifts out of phase. The reading anchors; the reservations track spend since the
anchor.

### Success Criteria:

#### Automated Verification:

- Migration applies cleanly to the local stack: `npx supabase migration up`
- `supadata_budget` cannot hold a second row (attempting an insert fails)
- `supadata_budget` and `supadata_reservations` are reachable by `service_role` only
- **Concurrent reserves do not overdraw**: with the budget seeded so only one generation fits, two
  `reserve_supadata_credits` calls issued from **separate sessions** return one id and one refusal —
  never two ids. This is the property the whole phase exists for; assert it directly in SQL, with the
  second session's call issued while the first transaction is still open.
- An unsettled reservation older than the stale window is swept, and its credit returns to the pool
- A settled reservation with `actual_credits = null` still counts at its reserved **maximum**, not zero
- A settled reservation with a real `actual_credits` counts at that figure
- **The seeded row exists and reads uninitialized**: immediately after the migration, `supadata_budget`
  holds exactly one row with `read_at is null`, and `select … for update` on it succeeds
- **A clean database initializes on the first request rather than failing open forever**: against the
  seeded-but-null row, the first `reserve_supadata_credits` returns `refresh_required` and inserts **no**
  reservation; after `save_supadata_budget`, a second call is evaluated against the new reading and
  returns `reserved` or `refused`. This is the assertion that proves the breaker ever becomes active —
  without it, an uninitialized deployment is indistinguishable from a permanently disabled one
- **A refresh does not delete the work it is about to authorize**: a reservation that is unsettled, and
  one settled *after* `p_read_taken_at`, both survive `save_supadata_budget`; only a reservation settled
  at or before that timestamp is deleted. This is F1's failure mode asserted directly in SQL
- Exactly one caller gets `refresh_required` when two sessions read a stale (or uninitialized) row
  concurrently; the other gets a decision against the existing reading, or `uninitialized` when there
  is none
- The **reconciliation query** — the `case`-per-outcome form in Critical Implementation Details, which
  Phase 7 uses against the live ledger and which is *not* an RPC — returns 1 for an `unavailable` row
  with a null header and 0 for an `error` row with a null header. Write it here against hand-inserted
  rows and record it in the migration's comments: it is cheap to pin now, while the reasoning is fresh,
  and expensive to debug during a live credit pass.

#### Manual Verification:

- No TypeScript changes in this phase, so `npm run lint` and `npm run build` are expected to be
  **unchanged from Phase 4** — run them to confirm the migration did not break generated types, not as
  evidence the phase works. The SQL assertions above are the real coverage.
- The reserve → settle → refresh cycle leaves `supadata_reservations` empty, walked by hand once so the
  lifecycle is understood before it is wired to anything.

**Implementation Note**: Pause here for manual confirmation before starting Phase 6. Nothing is deployed
and nothing calls these RPCs yet.

---

## Phase 6: Wiring the breaker

### Overview

Put the Phase 5 mechanism behind the two paid calls, and give a refusal a message a user can act on.
Minimal form (D5): the breaker gates **spend, not the request** — a cache hit costs 0 and is never
blocked.

### Changes Required:

#### 1. Budget service

**Files**: `src/lib/services/supadata-budget.ts` (new), `src/lib/services/metadata.ts` (one-line export)

**Intent**: Own the thresholds, the refresh, and the notification seam.

**Contract**: Exports the three constants with their reasoning, plus two functions.

Constants: `BUDGET_READING_MAX_AGE_SECONDS = 900` (15 min); `BUDGET_WARN_FRACTION = 0.8`;
`BUDGET_STOP_RESERVE = 3`. The stop reserve is **derived, not picked** — 3 is the worst-case cost of one
generation under lever A: 1 transcript plus **up to 2** metadata requests, because `fetchVideoMetadata`
retries a retryable failure once and that retry is separately billed (`metadata.ts:169-178`). Refusing
when `max - used - delta < 3` is exactly the condition under which a generation could overdraw the plan.
Its comment must carry the derivation *including why metadata counts twice* — otherwise the next reader
counts one metadata call, "corrects" it to 2, and reopens the overdraw this constant exists to close.

Also `RESERVATION_STALE_SECONDS = 600` — the sweep window for an abandoned reservation. It must exceed
the longest a paid call can legitimately take, because a sweep that fires early un-reserves a call that
is still running and reopens the race. Erring long costs a temporarily over-conservative breaker;
erring short costs correctness, so the number is chosen against the **ceiling**, not the typical case:

| Guarded operation | Ceiling | From |
| --- | --- | --- |
| Transcript fetch | 90 s | `TRANSCRIPT_TIMEOUT_MS` (`transcript.ts:62`) |
| Job poll path | ~240 s | 12 attempts, 1 s doubling to a 30 s cap (`:29-32`) — **unreachable under D1** |
| Metadata (both attempts) | ~21 s | `METADATA_TIMEOUT_MS` 10 s × 2 plus the 1.2 s spacing (`metadata.ts:29`) |

600 s clears the longest *reachable* ceiling by more than 6×, and still clears the unreachable poll path
by 2.5× — so the number survives D1 ever being reverted, which is the scenario that would otherwise
silently invalidate it. It also matches `acquire_generation_lease`'s existing 600 s default, so the two
stale windows in this codebase stay the same number rather than drifting into a pair a reader has to
distinguish.

`BUDGET_READ_TIMEOUT_MS = 2_000` — the `/v1/me` deadline. Deliberately **one fifth** of
`METADATA_TIMEOUT_MS`: metadata's 10 s buys a real user-visible value and is spent after the debit, while
this call is advisory bookkeeping that sits *in front of* paid work. Waiting ten seconds to discover we
cannot learn anything is strictly worse than failing open in two, because the wait is added to every
request that claims the refresh. Two seconds is far above the observed latency of a small JSON endpoint
and far below the point where the user notices.

`reserveBudget(admin, apiKey, credits)` — the whole breaker in one call, and internally a **two-pass**
one. It resolves to a **discriminated union, not an id-or-null**, narrowed at the boundary the way
`beginGeneration`'s outcome union already is (`credits.ts:102-173`):

| Outcome | Carries | The caller must |
| --- | --- | --- |
| `reserved` | `reservationId`, statistics | make the paid call, **settle in `finally`** |
| `refused` | statistics | skip the call; 503 at the transcript point, `'skipped_budget'` at the metadata point |
| `untracked` | the reason it could not be tracked | **make the paid call and settle nothing** |

**`untracked` is the case that must not be collapsed into either neighbour**, and it is the one the
plan otherwise leaves unrepresentable. Fail-open means proceeding *without* a reservation, so it is not
`reserved` — there is no id to settle, and a settle call against a missing row is exactly the silent
corruption the sweep cannot detect. Nor is it `refused` — the call goes ahead. Every fail-open path
lands here: an RPC error, an `uninitialized` reading nobody has refreshed yet, a failed or timed-out
`/v1/me`, a malformed body, and a second pass that did not terminate. Typing it as `id | null` and
branching on truthiness is the predictable shortcut, and it makes "we could not track this call" and
"we tracked it" indistinguishable at the call site.

Because settlement is conditional on an id, both endpoint check points read the same way: settle in the
`finally` **only** when the outcome was `reserved`. `refreshRequired` never escapes the service — it is
consumed internally by the second pass.

Statistics ride along on `reserved` and `refused` so `reportBudgetThreshold` can build its payload from
the same locked read that made the decision, never from a follow-up query. It invokes `reserve_supadata_credits`, which decides atomically and hands back one of the four
outcomes above. `reserved`, `refused` and `uninitialized` return immediately. On `refresh_required` —
and **only** this caller, which is what the claim under the row lock enforces — it performs
`GET /v1/me`, calls `save_supadata_budget` with the timestamp it took *before* the request, evaluates
**warn** (D5a), waits (below), and then **calls `reserve_supadata_credits` a second time**, returning
that decision. The refresh claim is why no `warned_at` column or period-reset logic is needed — a naive
"fire whenever above threshold" would be one incident emitting thousands of events.

**The second pass is not an optimization; it is the only place the refreshed reading is used.** A
refresh that does not re-decide has spent an HTTP call to learn a number it then ignores — and the
first pass deliberately returned no reservation, so there is nothing to spend against yet. It is also
what keeps the reservation strictly *newer* than the reading that authorized it, which is the property
`save_supadata_budget`'s retention rule depends on.

**The second pass must not loop.** It can itself come back `refresh_required` only if the claim was
cleared and re-taken in between; treat any non-terminal outcome on the second pass as `proceed
untracked` and report it through the seam rather than recursing. One refresh per `reserveBudget` call,
bounded by construction.

If the refresh fails at any step — transport, timeout, non-2xx, malformed body — **no save happens**,
the claim is left to expire, and the call returns the explicit untracked fail-open outcome rather than
retrying or reserving against a reading it does not have. An uninitialized deployment whose very first
`/v1/me` fails therefore proceeds untracked and tries again on the next request, which is the correct
direction: a bookkeeping endpoint's outage must not stop a product whose transcript API is fine.

**A refresh must be spaced from the paid call that follows it.** This is the one place the plan would
otherwise contradict itself: `generate.ts:552-556` documents keeping the two Supadata requests seconds
apart because the plan allows 1 req/s, and an in-line `/v1/me` lands directly in front of the transcript
fetch. So the refreshing caller — and only it — waits `RETRY_DELAY_MS` (1200 ms) after `/v1/me` returns,
before its second reserve pass.

**`RETRY_DELAY_MS` is private today and must be exported, not restated.** It is a module-level constant
at `metadata.ts:5-6` with no `export`, so importing it is a one-word change to that file — the only
reason `metadata.ts` appears in this phase's file list. Its comment ("Past the rate-limit window on the
Free plan's 1 req/s, with margin") describes a **vendor-wide** limit, not a metadata-specific retry
policy, so a second consumer is exactly what it should have; extend the comment to name this one. Do not
copy the number: two 1200s that must agree, in two files, with only a comment linking them, is the
drift this phase can least afford — the whole point of the wait is that it matches the spacing the rest
of the pipeline already honours. Because the refresh is claimed by one
caller per TTL, this cost is paid by roughly one request every 15 minutes, not per request. Every other
caller reads the stored row and waits for nothing.

**Unverified**: whether `/v1/me` shares the transcript endpoints' rate bucket at all. The vendor docs in
`context/changes/persist-video-metadata/docs/supadata-account-limits.md` do not say, so this assumes it
does — the conservative reading. If Phase 7 shows `/v1/me` is exempt, the wait can be deleted; it is
deliberately one constant in one place so that deletion is trivial.

`settleBudget(admin, reservationId, actualCredits)` — records what the call actually billed. It must be
invoked on **every** exit from the paid call, including the throwing ones, for the same reason the
meter flush lives in `POST.finally`: a reservation that is never settled is a credit the fleet keeps
believing is spent until the sweep window elapses. Pass `null` when the vendor reported no
`x-billable-requests` header — that is "unknown", and the RPC deliberately keeps counting it at the
reserved maximum rather than treating it as free. **Where `actualCredits` comes from is not obvious and
is specified in the next section** — neither provider function returns a billed figure today.

**Reserve the maximum, not the expectation.** The transcript call reserves 1. The metadata call
reserves **2**, because `fetchVideoMetadata` may retry once and that retry is separately billed
(`metadata.ts:169-178`). This is where the 3-credit ceiling stops being an aspiration and becomes
enforced: the breaker cannot gate a retry that happens inside the helper, but it *can* refuse to start a
metadata call unless both requests fit.

**Total by contract, like every other provider service here.** `reserveBudget` and `settleBudget` are
typed to resolve, never reject — the same guarantee `fetchVideoMetadata` carries and for a sharper
reason: the second breaker call sits **after** the user has been debited and the LLM has been paid for,
where a throw bypasses the refund path and strands both the app-credit reservation and the provider
reservation. Three concrete requirements, none of them inferable from "fails open" alone:

- `GET /v1/me` runs under `AbortSignal.timeout(BUDGET_READ_TIMEOUT_MS)`, the same mechanism
  `METADATA_TIMEOUT_MS` uses (`metadata.ts:29`) and for the same reason — Cloudflare caps CPU time, not
  time spent waiting on a subrequest, so nothing else bounds it. A hung bookkeeping call must not
  outlive the request it is advising; the 2 s figure and its derivation are pinned above.
- The response is **narrowed at the boundary**, not destructured on faith. A vendor that changes the
  shape of `usedCredits`/`limit` must produce a reported failure, not `NaN` arithmetic that silently
  computes a remaining balance nobody can trust.
- Every transport rejection, non-2xx status, non-JSON body and schema mismatch is caught, reported
  through the seam, and answered with "proceed".

The RPC calls are held to the same standard: a Supabase error on reserve fails open, and a failure to
**settle** is reported but never thrown — the sweep is the backstop that makes an unsettled row
self-correcting rather than permanent.

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

#### 2. Scoped billing observation

**File**: `src/lib/services/supadata-ledger.ts`

**Intent**: Give `settleBudget` a real source for `actualCredits`. Without this the phase has a hole
exactly where its correctness lives, and the implementer invents an answer under time pressure.

**The figure exists but is not reachable.** `fetchTranscript` returns `TranscriptResult`
(`transcript.ts:279-339`) and `fetchVideoMetadata` returns `VideoMetadata | null`
(`metadata.ts:164-195`); neither carries what the vendor billed. Every per-attempt figure is already
pushed into `SupadataMeter`, but its public surface is `record`, `attachSummary` and a whole-request
`drain` (`supadata-ledger.ts:41-76`) — request-scoped, not call-scoped, and draining it here would
destroy the rows `POST.finally` still needs to flush.

**Contract**: two additions to `SupadataMeter`, non-destructive.

*`checkpoint(): number`* — returns the current row count. Taken immediately **before** each guarded
operation.

*`billedSince(checkpoint: number, operation): number | null`* — reduces only the rows recorded after
that checkpoint and only for the named operation, returning:

- the **sum** of `billableCredits` when every matching row reported a figure — this is what makes the
  metadata retry settle at 2 rather than 1, since both attempts land as separate rows;
- **`null`** when *any* matching row has a null `billableCredits`. Unknown is contagious and must not
  be coerced to 0: a `206 transcript-unavailable` is billed 1 and reports no header, so summing nulls
  as zero would settle a real charge as free — the exact under-count the per-outcome reconciliation
  formula exists to avoid;
- **`0`** when no rows matched at all, which is the honest answer for a guarded call that never ran.

**Filtering on `operation` is load-bearing, not defensive.** The two check points are nested inside one
request, and the transcript reservation must not be settled by a metadata row that happened to be
recorded after its checkpoint. Mismatched rows are ignored rather than summed.

Both call sites therefore read: `const mark = meter.checkpoint()` → reserve → run the guarded call →
`settleBudget(admin, id, meter.billedSince(mark, 'transcript'))` in the `finally`. The meter keeps its
existing job unchanged; `drain` still flushes the whole request in `POST.finally` and is untouched.

#### 3. Endpoint wiring — two check points

**File**: `src/pages/api/summaries/generate.ts`

**Intent**: Gate each paid call, and nothing else.

**Contract**: Two call sites, both on a **miss** path.

*Before the transcript fetch* — inside the `else` branch that performs a real paid fetch (`:355`
onward), and specifically **before `recordTranscriptAttempt`**, not after it. That RPC records a
*paid-fetch attempt* against a ten-attempt window; ordering the budget check behind it means a run of
budget refusals — which make no Supadata call at all — burns a user's transcript allowance for work
that never happened. Reserve first, record the attempt only once the reservation is in hand and the
real fetch is about to run. Never at the endpoint entrance either: a cache hit costs 0 and blocking it
would break the product for no saving.

Reserve **1**; settle in a `finally` around the fetch so a throw still releases it. On a trip, return
**503** with operator-shaped copy — the user should learn the service is temporarily unable to process
new videos, not see a generic failure. 503 is the right code (the service genuinely cannot do the work
right now) and it is already the endpoint's "generation is unavailable" status, so no new branch is
needed on the client — but see the file below, because today it discards the server's string.

*Before `fetchVideoMetadata`* — only reached when Phase 4's lookup missed. This point exists because on
a warm transcript with cold metadata, the metadata call **is** the first paid call: a breaker sitting only
in front of the transcript fetch is bypassed on exactly the traffic Phase 4's cache is designed to create.
Reserve **2** here (the retry), settle with the real total once the helper returns or throws. On a trip
here the generation is **not** refused — the user has already been debited and the LLM already
paid for, so refusing to protect a decorative thumbnail would be strictly worse. Skip the call, persist
nulls exactly as a metadata failure already does, and record `metadata_via = 'skipped_budget'` so the
degraded row explains itself.

#### 4. The client's 503 handling

**File**: `src/components/summaries/GenerateSummaryForm.tsx`

**Intent**: Without this the breaker's copy never reaches a user — the same trap Phase 1 fixes for 422,
in a second place.

**Contract**: `case 503` currently returns the hardcoded `"Summary generation isn't configured."` and
drops `serverError` entirely (`:78-79`). It becomes `return serverError ?? "Summary generation isn't
configured.";` — joining 429, 500 and 400. The comment follows the 429 precedent and names the two
causes that now answer 503: a missing service-role key (genuinely a configuration problem) and a
tripped budget breaker (a temporary capacity problem), which are different messages and must not be
collapsed into the configuration one. The fallback still covers a non-JSON 503.

**Settlement is a `finally` obligation, not a happy-path step.** Both sites already sit inside
`try`/`catch` blocks that swallow provider failures; the settle call belongs in the `finally` of each,
alongside the same reasoning `POST.finally` carries for the meter flush. A reservation leaked on the
error path is invisible until the sweep, and the error paths are exactly the ones a budget guard exists
to survive.

### Success Criteria:

#### Automated Verification:

- Type checking and lint pass: `npm run lint`
- Build succeeds: `npm run build`
- `RESERVATION_STALE_SECONDS` is passed to the RPC rather than duplicated in SQL — the sweep window is
  one number in one place: `grep -n "stale" src/lib/services/supadata-budget.ts supabase/migrations/20260731130000_supadata_budget.sql`
- Both call sites settle in a `finally`, not on the happy path only:
  `grep -n "settleBudget" src/pages/api/summaries/generate.ts` shows each inside a `finally` block
- `billedSince` sums two metadata rows to 2, returns `null` when either row's `billableCredits` is
  null, returns 0 when no rows matched, and ignores rows of the other operation — asserted directly
  against a hand-built meter, since this is the reducer every settlement depends on
- `reserveBudget`'s return type has three cases, and `untracked` is one of them — not an `id | null`:
  `grep -n "untracked" src/lib/services/supadata-budget.ts src/pages/api/summaries/generate.ts`
- Settlement is reachable only from the `reserved` branch — no call site settles after `untracked`

#### Manual Verification:

- With `BUDGET_STOP_RESERVE` temporarily raised past the remaining balance, a cold video is refused
  **before** any Supadata call — verified by `usedCredits` not moving — and the UI shows the breaker's
  503 message, not the "isn't configured" fallback.
- Repeated budget refusals leave the transcript rate-limit window untouched: after several refusals a
  successful generation still runs, rather than hitting a 429 the user never earned.
- Under the same override, a **warm** video still generates successfully. This is the D5 reshape that
  matters most: the breaker gates spend, not the request.
- Under the same override with a warm transcript and cold metadata: the summary is produced,
  `metadata_via = 'skipped_budget'`, and no `metadata` ledger row is written.
- A completed generation leaves **no unsettled reservation** behind, and a generation forced to throw
  mid-fetch leaves none either — the `finally` obligation, checked rather than assumed. Phase 5 proved
  the sweep works; this proves the sweep is a backstop rather than the primary mechanism.
- With the stored reading deleted and an invalid API key, generation **proceeds** and the unreadable
  state is reported (fail-open, visibly).
- A `/v1/me` that hangs past the timeout, and one that returns a malformed body, both fail open and
  report — neither throws, and neither leaves a reservation stranded.
- The warn event fires at most once per TTL, not once per request — including when two stale readers
  arrive together, where exactly one claims the refresh.
- A generation that triggers the refresh still succeeds: the paid call that follows `/v1/me` does not
  come back `limit-exceeded`.

**Implementation Note**: Pause here for manual confirmation. The overrides must be reverted before Phase 7.

---

## Phase 7: Deploy and live verification

### Overview

One deploy covering all six preceding phases, then a ~4-credit live pass against the real vendor.

### Changes Required:

#### 1. Deploy

**Intent**: Close the `persist_summary` swap window.

**Contract**: `npx supabase db push --linked` immediately followed by `npx wrangler deploy` — back to
back, as S-07 and S-08 both did. Between the two commands the live Worker calls a signature that no
longer exists and **every generation fails at persist, after the LLM has been paid for**. Only Phase 4's
migration opens that window; the other three are additive and carry no ordering risk of their own.
Confirm with `npx supabase migration list --linked` that **all four** migrations are in sync. No new
Worker secrets: the breaker uses the existing `SUPADATA_API_KEY`.

**This deploy is also when the refusal charge goes live for real users.** It is the only change in the
slice that takes something from a user rather than saving the operator money, and it ships silently by
design (D14). Worth a deliberate look at `credit_reservations` in the first day for settled rows with a
non-null `refusal_reason` — that is the charge, and Phase 3's classification makes it a one-column
filter rather than an anti-join against `summaries`. Its rate, broken down by reason, is the first
evidence of whether the friction is proportionate.

#### 2. Live verification pass

**File**: `context/changes/transcript-cost-guardrail/reviews/manual-verification.md` (new)

**Intent**: Prove the cost envelope against the vendor's own billing, the way S-07 proved cross-user
transcript reuse. Budget: **~4 credits**, worst case **6** if a metadata retry fires on both metadata
steps.

**Contract**: Record `GET /v1/me` before and after each step, alongside the per-outcome ledger total for
the same window; the two must agree. Four steps: a cold captioned video (expect +2, or +3 if metadata
retried — two `metadata` ledger rows is the tell); an immediate repeat of it (expect **+0** — both caches
hit, `resolved_via = 'stored'` and `metadata_via = 'stored'`); a caption-less video (expect +1, a 422,
and the **new** D3 copy visible in the UI); one metadata-only case where the transcript is warm but
metadata is cold (expect +1, or +2 on a retry).

Two additions from the 2026-08-01 scope extension, both free of extra Supadata spend:

- The caption-less step now also asserts `http_status = 206` on its ledger row (P2) and a **1-credit drop
  in the submitting user's balance** with a matching settled `credit_reservations` row carrying
  `refusal_reason = 'unavailable'` and no `summaries` row (P3).
- Reconciliation gains a cross-check it could not make before: the `unavailable → 1` branch of the
  per-outcome formula can be validated against the recorded status rather than against our own `outcome`
  label. If those two ever disagree, the formula is wrong and the delta will say so.

A step that comes in one credit *over* its expectation is not a discrepancy if the ledger shows two
`metadata` rows — that is the 3-credit ceiling being exercised, and it is worth recording when it
happens, since nothing else in this slice can tell us how often the retry actually fires.

The document must state what was **not** verified live and why: the stop threshold cannot be reached
without spending ~95 credits, so Phase 6 verified it by overriding the constant; and D1 means the Whisper
job path is now unreachable by construction and will never be verified at all.

### Success Criteria:

#### Automated Verification:

- `npx supabase migration list --linked` shows all four migrations applied
- The deployed Worker version is recorded
- Reconciliation query: the per-outcome ledger total for the verification window equals the observed
  `usedCredits` delta

#### Manual Verification:

- Total spend for the pass is within the ~4-credit budget (≤6 if metadata retries fire).
- The repeat generation moves `usedCredits` by **0** — the headline claim.
- The caption-less video shows the new copy to the user, not the client fallback.
- `roadmap.md` §S-09 status and the Linear issue both reflect completion.

---

## Testing Strategy

This repo has no automated test suite (README, "Project status"), so verification is the two-tier
automated/manual split above: `npm run lint` + `npm run build` + direct SQL assertions as the automated
tier, and structured manual passes as the real coverage.

**SQL assertions worth writing directly** (Phases 3, 4 and 5 — Phase 5 is *entirely* this tier, which is
why it is its own phase):

- One `persist_summary` overload, not two, after the swap.
- `metadata_cache`, `supadata_budget` and `supadata_reservations` reachable by `service_role` only.
- The reconciliation total's per-outcome branch, against hand-inserted `unavailable`/`error` rows with
  null headers. This is the one piece of logic where a plausible-looking simplification under-counts.
- **The concurrent-reserve assertion** (two sessions, one seat). Everything else in this slice can be
  checked by reading the code; this one cannot, and it is the property the reservation table exists for.
  It is the whole reason Phase 5 is a phase.
- **The charge's replay assertion** (P3): the same `(user_id, request_id)` twice decrements once. Like
  the concurrent-reserve case, this cannot be established by reading the code — it depends on an index
  predicate (`status <> 'refunded'`) interacting with the insert, and getting it wrong bills a user
  repeatedly for one action.

**Manual scenarios by phase**: caption-less 422 copy and the 2 h window (P1, done); the 206/200 status
rows and the metadata scope boundary (P2); the four charging exits, the exempt transient one and the
replay case (P3); cache hit / miss and the D12 `videos` write (P4); the reserve/settle/refresh lifecycle
in SQL (P5); the three breaker cases and fail-open (P6); the four-step credit pass (P7).

## Performance Considerations

Each cache lookup adds one Supabase round trip to a request that already makes several, and removes an
HTTP call to an external vendor when it hits — net faster on a hit, negligibly slower on a miss. The
breaker adds two round trips per paid call (reserve, then settle) and one `GET /v1/me` per 15-minute
TTL, never per request. All reserves serialize behind one row lock — acceptable because the lock is
held only for arithmetic, never across an HTTP call, and because this fleet makes at most a few paid
calls per minute. If that stops being true, the lock is the first thing to measure.
`supadata_reservations` stays small by construction: every refresh deletes the rows it supersedes.

`metadata_cache` grows one small row per distinct video, with no body — unlike `transcript_cache`, which
needed a `too_long` outcome to bound its rows. No pruning is needed at MVP scale.

## Migration Notes

Four migrations, applied in phase order. `20260731120000_metadata_cache.sql` (P4) is the only risky one
— it drops and recreates `persist_summary`, so it must be pushed and deployed back to back (Phase 7).
The other three are purely additive: `…100000_supadata_call_http_status` (P2) adds one nullable column,
`…110000_charge_failed_transcript` (P3) adds one nullable column and two functions and no table —
notably it does **not** touch `begin_generation`, which is what keeps it additive, and
`…130000_supadata_budget` (P5) adds tables and functions but drops nothing — which is what lets each of
those phases land locally and be proved in SQL without any deploy coordination at all.

**Rollback**: reverting Phase 1 is a one-word change back to `auto` plus the copy. Phase 2 is reverted by
dropping the column, and leaving it in place costs nothing — nothing reads it. **Phase 3 is the one
revert with a user-visible consequence**: dropping the call site stops future charges, but credits already
taken are not returned by the revert. If it has been live, decide explicitly whether to refund the
settled, summary-less rows — they are trivially identifiable, which is a reason to keep them queryable
rather than to delete them. Reverting Phase 4 requires restoring the 23-argument `persist_summary` and
dropping `metadata_via`; existing rows carrying a non-null `metadata_via` are harmless to the old
function, which simply never writes it. Reverting Phase 5 is code-only — the three tables can be left in
place, unread. A stranded `supadata_reservations` row after a Phase 6 revert affects nothing, because
nothing reads it once the service is gone. Reverting Phase 6 alone leaves Phase 5's tables in place and
unread — the split is a clean revert boundary too.

## References

- Locked design: `context/foundation/roadmap.md` §S-09, Decisions D1–D12 (2026-07-31)
- Vendor API reference: `context/changes/persist-video-metadata/docs/supadata-transcript.md`,
  `supadata-account-limits.md`, `supadata-metadata.md`
- The pattern this plan mirrors throughout: `context/changes/persist-time-and-cost/plan.md` (S-07)
- S-07's live findings, including the four hand-over items: `context/changes/persist-time-and-cost/reviews/manual-verification.md`
- Phase 1's verification record, which motivated the D13/D14 scope extension:
  `context/changes/transcript-cost-guardrail/reviews/manual-verification-phase-1.md`
- The credit ledger this slice's charge reuses: `supabase/migrations/20260720170000_generation_lock_lease.sql`
  and `src/lib/services/credits.ts` (`beginGeneration`'s outcome union, the shape D14's RPC mirrors)
- Cache + ledger precedent: `supabase/migrations/20260728120000_generation_telemetry.sql`,
  `src/lib/services/transcript-cache.ts`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Lever A and the `unavailable` split

#### Automated

- [x] 1.1 Type checking and lint pass — 1e134df
- [x] 1.2 Build succeeds — 1e134df
- [x] 1.3 No `mode=auto` / `mode=generate` literal remains — 1e134df
- [x] 1.4 All three 422 sites reviewed, only one string changed — 1e134df

#### Manual

- [x] 1.5 Captioned video still summarizes end to end — 2026-08-01, local
- [x] 1.6 Caption-less video shows the new 422 copy, not the client fallback — 2026-08-01, local
- [x] 1.7 `'empty'` transcript still shows the generic copy — 2026-08-01, local
- [x] 1.8 `unavailable` cache row expires in 2 h, not 24 h — 2026-08-01, local

Record: `reviews/manual-verification-phase-1.md`. All four passed; Supadata delta 3 reconciled exactly
against the per-outcome ledger total.

### Phase 2: `http_status` on the transcript ledger

#### Automated

- [x] 2.1 Migration applies cleanly to the local stack — a5efa28
- [x] 2.2 `supadata_calls.http_status` exists, nullable, with no CHECK constraint — a5efa28
- [x] 2.3 Pre-migration rows still read `null` — nothing was backfilled — a5efa28
- [x] 2.4 Type checking and lint pass — a5efa28
- [x] 2.5 Build succeeds — a5efa28

#### Manual

- [x] 2.6 Caption-less video records `http_status = 206` with `outcome = 'unavailable'` and null billable — 2026-08-04, local
- [x] 2.7 Captioned video records `http_status = 200` with `billable_credits = 1` — 2026-08-04, local
- [x] 2.8 The same generation's `metadata` row has `http_status = null` — scope boundary holds — 2026-08-04, local
- [x] 2.9 A forced vendor error records its status alongside `outcome = 'error'` — the failure arm is
      plumbed, not just the success arm — 2026-08-04, local

Record: `reviews/manual-verification-phases-2-3.md` (run jointly with Phase 3). All four passed;
Supadata delta 3 reconciled exactly against the per-outcome ledger total, and for the first time the
`unavailable → 1` branch was corroborated by the recorded `206` rather than by our own `outcome` label.

### Phase 3: Charging for a refusal in the billable class

#### Automated

- [x] 3.1 Migration applies cleanly to the local stack — 6a62cf1
- [x] 3.2 `charge_failed_transcript` is executable by `service_role` only — 6a62cf1
- [x] 3.3 The same `(user_id, request_id)` twice returns `'replay'` and decrements once — 6a62cf1
- [x] 3.4 A zero balance returns `'insufficient'` and writes no row — 6a62cf1
- [x] 3.5 `get_refusal_replay` returns the stored reason for a charged key and `null` for a
      summary-less row written without one — 6a62cf1
- [x] 3.6 The charge is invoked at exactly four 422 sites, not five — 6a62cf1
- [x] 3.7 Type checking and lint pass — 6a62cf1
- [x] 3.8 Build succeeds — 6a62cf1

#### Manual

- [x] 3.9 Cold caption-less video: 422, balance −1, one settled reservation for the request id with no
      matching `summaries` row — 2026-08-04, local
- [x] 3.10 Cache-hit resubmit with a new `requestId`: balance −1 again, no Supadata call made — 2026-08-04, local
- [x] 3.11 Resubmit with the same `requestId`: balance does not move, and the reply is the same 422
      with the same copy — not a 409 — 2026-08-04, local
- [x] 3.12 A settled, summary-less reservation with no `refusal_reason` still answers 409 — 2026-08-04, local
- [x] 3.13 A seeded `'empty'` cache row charges; a forced transient failure does not — 2026-08-04, local
- [x] 3.14 A successful generation still costs exactly `summaryCost` — no stacking — 2026-08-04, local
- [x] 3.15 Balance 0: the 402 gate answers first and no charge row is written — 2026-08-04, local

Record: `reviews/manual-verification-phases-2-3.md`. All seven passed. 3.11 and 3.12 are one assertion,
not two: a replayed 422 and a coincidental re-run of the cached-`unavailable` path print the same
response, so only the 409 control — same row shape, `refusal_reason` the sole difference — establishes
that the replay branch fired.

Also asserted beyond 3.1–3.8, in two concurrent psql sessions: the same `(user_id, request_id)`
charged from both sides yields one `'charged'` and one `'replay'`, one row, and a single decrement —
the `select … for update` cannot serialize a key whose row does not exist yet, so the loser reaches
the insert and is caught by `charge_failed_transcript`'s `unique_violation` handler.

### Phase 4: `metadata_cache` and the hit marker

#### Automated

- [x] 4.1 Migration applies cleanly to the local stack — 0142ead
- [x] 4.2 Exactly one `persist_summary` overload exists afterwards — 0142ead
- [x] 4.3 `metadata_cache` and `summaries.metadata_via` have the intended constraints and grants — 0142ead
- [x] 4.4 Type checking and lint pass — 0142ead
- [x] 4.5 Build succeeds — 0142ead

#### Manual

- [x] 4.6 First generation: `metadata_via = 'fetched'`, ledger row written, cache row written — 2026-08-04, local
- [x] 4.7 Second generation: `metadata_via = 'stored'`, no new ledger row, `metadata_ms` near zero — 2026-08-04, local
- [x] 4.8 D12 — a cache hit still populates the per-user `videos` row — 2026-08-04, local
- [x] 4.9 A row aged past 30 days produces a fresh fetch — 2026-08-04, local

Record: `reviews/manual-verification-phase-4.md`. All four passed. The warm generation moved
`usedCredits` by **0** — the slice's headline claim, observed locally for the first time — and the
pass reconciled exactly (delta 4, ledger total 4). 4.8 was run on a **second account** rather than a
second character: a second character upserts onto a `videos` row the first generation already filled,
so `coalesce` would have masked a "hit → skip the write" regression entirely.

### Phase 5: The reservation ledger

#### Automated

- [ ] 5.1 Migration applies cleanly to the local stack
- [ ] 5.2 `supadata_budget` cannot hold a second row
- [ ] 5.3 `supadata_budget` and `supadata_reservations` are reachable by `service_role` only
- [ ] 5.4 Concurrent reserves do not overdraw — one id, one refusal, never two ids
- [ ] 5.5 A stale unsettled reservation is swept and its credit returns to the pool
- [ ] 5.6 A settled reservation with `actual_credits = null` still counts at its reserved maximum
- [ ] 5.7 A settled reservation with a real `actual_credits` counts at that figure
- [ ] 5.8 The seeded row exists and reads uninitialized — one row, `read_at is null`, lockable
- [ ] 5.9 A clean database initializes on the first request: `refresh_required` with no reservation,
      then a real decision against the saved reading
- [ ] 5.10 A refresh does not delete the work it is about to authorize — unsettled and
      settled-after-`p_read_taken_at` rows survive; only settled-at-or-before is deleted
- [ ] 5.11 Exactly one of two concurrent stale (or uninitialized) readers gets `refresh_required`
- [ ] 5.12 Reconciliation query returns 1 for `unavailable`/null-header, 0 for `error`/null-header

#### Manual

- [ ] 5.13 `npm run lint` and `npm run build` unchanged from Phase 4 (no TypeScript in this phase)
- [ ] 5.14 The reserve → settle → refresh cycle leaves `supadata_reservations` empty, walked by hand

### Phase 6: Wiring the breaker

#### Automated

- [ ] 6.1 Type checking and lint pass
- [ ] 6.2 Build succeeds
- [ ] 6.3 The sweep window is passed to the RPC, not duplicated in SQL
- [ ] 6.4 Both call sites settle in a `finally`, not on the happy path only
- [ ] 6.5 `billedSince` sums a retry to 2, returns null on any unknown row, 0 on no rows, and ignores
      the other operation's rows
- [ ] 6.6 `reserveBudget` returns a three-case union including `untracked`, not an `id | null`
- [ ] 6.7 Settlement is reachable only from the `reserved` branch

#### Manual

- [ ] 6.8 Cold video refused before any Supadata call under an overridden reserve, with the breaker's
      own 503 copy visible in the UI — not the "isn't configured" fallback
- [ ] 6.9 A budget refusal consumes no transcript rate-limit attempt
- [ ] 6.10 Warm video still generates under the same override
- [ ] 6.11 Warm transcript + cold metadata: summary produced, `metadata_via = 'skipped_budget'`
- [ ] 6.12 No unsettled reservation survives a completed generation or a mid-fetch throw
- [ ] 6.13 Unreadable budget state: generation proceeds and the state is reported (fail-open)
- [ ] 6.14 A hung and a malformed `/v1/me` both fail open, report, and strand no reservation
- [ ] 6.15 Warn fires at most once per TTL, including for two simultaneous stale readers
- [ ] 6.16 A refresh-triggering generation still succeeds — no `limit-exceeded` on the paid call
- [ ] 6.17 Overrides reverted

### Phase 7: Deploy and live verification

#### Automated

- [ ] 7.1 `migration list --linked` shows all four migrations applied
- [ ] 7.2 Deployed Worker version recorded
- [ ] 7.3 Reconciliation: per-outcome ledger total equals the observed `usedCredits` delta

#### Manual

- [ ] 7.4 Total spend within the ~4-credit budget (≤6 if metadata retries fire)
- [ ] 7.5 Repeat generation moves `usedCredits` by 0
- [ ] 7.6 Caption-less video shows the new copy live, records `http_status = 206`, and costs the
      submitting user 1 credit
- [ ] 7.7 `roadmap.md` §S-09 and the Linear issue reflect completion
