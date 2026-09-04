# Supadata — per-request credit accounting (`x-billable-requests`)

**REST base:** `https://api.supadata.ai/v1` · **Auth:** `x-api-key` header · Context7: `/llmstxt/supadata_ai_llms_txt`, `/supadata-ai/js` · **Fetched 2026-07-28**

**Role here:** S-07's ledger promises "exactly which Supadata calls were made" and claims to unlock S-09's Whisper-fallback decision. Plan-review finding F1 established that `operation` / `outcome` / `resolved_via` cannot deliver that — `resolved_via` is a documented fetch-mechanism observation, not a native-vs-Whisper claim (`src/types.ts:3`). This file captures the vendor surface that *can*.

## The header

> Credit usage can be monitored through the dashboard's history section or **by inspecting the `x-billable-requests` header included in every API response**.
>
> — `docs.supadata.ai/get-transcript`, via Context7 2026-07-28

Two properties matter for the ledger:

1. **Per-request, not per-account.** Unlike `GET /v1/me`'s `usedCredits` (a billing-period running total), this is the cost of *the request that returned it*. It is the only vendor surface that attributes spend to a single call.
2. **"Included in every API response."** The docs make no exception for error responses. That is what lets a 206 `transcript-unavailable` — billable at 1 credit (`../../persist-video-metadata/docs/supadata-transcript.md:81`) — carry a *measured* cost rather than an assumed one.

> ⚠️ **Property 2 is false as documented.** Measured 2026-07-29: the 206 `transcript-unavailable` response carries **no** `x-billable-requests` header, yet is still billed 1 credit. The one call shape whose cost this header was most needed for is precisely the one that does not report it. See §Measured below before relying on property 2 anywhere.

### What it settles that `resolved_via` cannot

| Question | `resolved_via` | `x-billable-requests` |
| --- | --- | --- |
| Native (1 credit) vs Whisper (2/min)? | ❌ Inference. `auto` falls back silently; `inline`/`job` describes the transport | ✅ The number is the bill |
| Cost of a request that produced no summary? | ❌ No row shape carries it | ✅ Header is on the error response too |
| Cost of a long video that jobbed but *was* native? | ❌ `job` over-counts it | ✅ Exact |

The `job` path is the specific trap: a long native-caption video can return a `202` job and be billed 1 credit, while `resolved_via = 'job'` would price it at `2 × ceil(duration/60)`. Phase 1's retrospective estimate is therefore an upper bound by construction — and the header is what turns Phase 5 from "the estimate looks plausible" into a reconciliation.

## ✅ Resolved 2026-07-29: the value is **credits**

> **Settled by spot probe.** One `mode=generate` request returned `x-billable-requests: 2` and moved `usedCredits` by exactly 2. A single HTTP call can never be "2 requests", so the header tracks **credits**, not a request count. `billable_credits` is correctly named — **no rename**, and the Phase 5 §5.5 rename branch is closed. Six independent measurements agree; see §Measured.

The original question is kept below because the reasoning still explains *why* a native-only reconciliation could not have settled it.

**The name and the documentation disagree.** The header is called `x-billable-requests`, but the only sentence describing it frames it as the way to monitor *credit usage*. Those diverge exactly where it matters most:

| Call | Billable requests | Credits |
| --- | --- | --- |
| Native transcript | 1 | 1 |
| Metadata | 1 | 1 |
| **Whisper job, 3-min video** | **1** | **6** (2/min) |

So if the header reports a request *count*, it does **not** settle the native-vs-Whisper question on its own — and `resolved_via` + `videos.duration_seconds` become more necessary, not less, because they would be the only way to convert counts into cost.

This does not change the ledger's shape: the value is recorded verbatim either way, and `operation` / `outcome` carry the attribution regardless. It changes what Phase 5 proves. **The reconciliation settles it mechanically**: on a native short video the two readings are identical (1 = 1), so run the comparison on a video that takes the `job` path — if `usedCredits` moves by `2 × ceil(duration/60)` while the header reported `1`, it is a count. Record the answer here.

~~Until then, treat the column name `billable_credits` as provisional; if it turns out to be a count, rename to `billable_requests` before the ledger accumulates rows anyone reasons from.~~ — **superseded**: the name stands, see the resolution above.

## ⚠️ Unverified: which responses actually carry it

The doc sentence is the *only* statement Context7 surfaces about this header. Nothing in the docs or the OpenAPI spec confirms its value on:

- ⬜ **still open** — the initial **`202` job-accepted** response (is the credit charged at submission, at completion, or split?); unreached, see §Measured Finding 3;
- ⬜ **still open** — **`GET /transcript/:jobId`** polls, which are documented free (`supadata-transcript.md:80`) and should therefore report `0`; unreached for the same reason;
- ✅ **answered 2026-07-29** — **4xx/5xx** bodies: a `206 transcript-unavailable` is billed 1 credit and carries **no header at all**. "Every API response" is false as written.

**These are implementation-time findings, not blockers.** The column is nullable and the value is recorded verbatim; a missing or absent header stores `null`, which is honestly distinguishable from a measured `0`. Phase 5's `GET /v1/me` delta is the cross-check: if the summed ledger disagrees with `usedCredits`, the disagreement localises to whichever call shape returned `null`.

## ✅ Measured — local verification pass, 2026-07-29

Phase 2–4 manual verification (`../plan.md` rows 2.4–4.9) ran five generations against the local stack and reconciled them against `GET /v1/me`. `usedCredits` moved **48 → 55**, and all 7 credits attribute:

| Response observed | `x-billable-requests` | Actually billed |
| --- | --- | --- |
| `200` native transcript (`inline`) | `1` | 1 |
| `200` metadata | `1` | 1 |
| **`206` `transcript-unavailable`** | **absent** | **1** — by reconciliation |
| `200` `GET /v1/me` | absent | 0 (free endpoint) |
| `524` gateway timeout, no vendor body | absent | **unmeasured** — see below |

```
ledger sum(billable_credits) = 4   (transcript+metadata run A, metadata run B, transcript run E1)
+ 2  direct curl probes, outside the app
+ 1  the 206 unavailable, recorded null
= 7 = the usedCredits delta ✓
```

**The headline finding: an error response can be billed and report nothing.** The 206 is billable at 1 credit exactly as `supadata-transcript.md:81` says, but sends no header — so it lands in the ledger as `null`, not `1`. This is the first real payoff of keeping `null` distinct from `0`: the reconciliation gap was localisable to a single known call shape instead of being an unexplained discrepancy. Resolves the third bullet above (4xx/5xx) in the *opposite* direction to what "every API response" implied.

**One caveat on the table:** the `524`'s cost is unknown, **not zero**. The vendor's §Latency paragraph (re-fetched 2026-07-29, see `../../persist-video-metadata/docs/supadata-transcript.md#latency`) states plainly that **timed-out requests still consume credits** — so "unknown" here leans billable rather than free, and a client-side deadline can only ever cancel our *wait*, never the charge. That is why S-07's `TRANSCRIPT_TIMEOUT_MS` was set to 90s rather than to the documented 60s ceiling: on this endpoint an over-tight deadline manufactures exactly this row — a paid call with no result and no header. That failure preceded the baseline `/v1/me` read, so it sits inside the 48 rather than inside the measured delta. It is excluded from the reconciliation above rather than counted as free. (The app handled it correctly regardless: 502 to the user, no debit, and an `outcome='error'` ledger row with `null` credits.)

### Spot probes — direct against the vendor, same day

The generation pass could only exercise native/inline calls, where a credit figure and a request count are both `1` and therefore agree. Seven further probes were run with `curl`, bypassing the app, to break that tie and to reach the `job` path.

**Finding 1 — the header reports credits.** Decisive measurement:

| Probe | `x-billable-requests` | `usedCredits` delta |
| --- | --- | --- |
| `mode=generate` on a captioned 2:55 video | **`2`** | **2** |
| metadata | `1` | 1 |
| native transcript | `1` | 1 |

One request, header `2`, billed 2. A request *count* cannot exceed 1 for a single call, so the value is credits. Across the whole day six measurements agreed and none contradicted.

**Finding 2 — `206 transcript-unavailable` never carries the header.** Observed three times on two different videos, always absent, always billed 1. This is a stable property of that response shape, not a glitch, so `null` for a *known-billable* call is the permanent steady state rather than a transient gap.

**Finding 3 — `mode=generate` does not reliably generate.** Documented as "always generate transcript using AI". Observed:

| Video | `mode=generate` returned | Cost |
| --- | --- | --- |
| has native captions (2:55) | `200` **inline**, `availableLangs: ["en"]`, no `jobId` | 2 |
| **no** native captions (2:39 instrumental) | **`206 transcript-unavailable`** | 1 |

Neither produced a job. The caption-less case is the striking one: the documented purpose of `generate` is exactly that video, and it declined. Cause **not established** — plausibly the Free plan excludes AI generation, plausibly the audio was unobtainable (copyright-restricted music). Recorded as an observation, not a diagnosis.

Two consequences follow:

- **S-09's lever is in doubt.** Switching `mode` is S-09's headline instrument for bounding spend. On this account `generate` did not behave as documented in either direction, so S-09 must re-establish what the modes actually do before planning around them.
- **The `job` path stayed unreachable.** Five submit attempts across three videos, zero `202` responses. The `202` and `GET /transcript/:jobId` polls therefore remain **unobserved** — the one gap this file still carries. If the path is genuinely unreachable on this plan, `resolved_via = 'job'` and `operation = 'transcript_poll'` rows will simply never appear in production either, and the ledger will record the answer for free if they ever do.

The `202` job-accepted response and the `GET /transcript/:jobId` polls remain unobserved — no local video took the job path.

**✅ Why, answered 2026-07-29 (docs re-fetch).** Not an account restriction and not chance: the vendor gates the async job on **video length > 20 minutes** (`../../persist-video-metadata/docs/supadata-transcript.md#latency`). Every probe above ran on a 2–3 minute video, so none of them could have reached the job path in any `mode` — which also explains Finding 3's caption-less `generate` returning `206` inline rather than a job. The path is therefore **reachable, just untested**: a >20-minute video would produce the `202` and the polls on this same plan. `operation = 'transcript_poll'` rows will appear in production the first time a user submits a long video, and the ledger will record the open credit question for free when they do.

## Why the SDK cannot supply it

`@supadata/js@1.4.0` discards response headers at its single transport chokepoint (`node_modules/@supadata/js/dist/index.mjs`, class `a`):

```js
async fetchUrl(e, t = "GET", s) {
  let n = await f(e, i);                 // Response
  let l = n.headers.get("content-type"); // headers read ONLY for content-type
  if (!n.ok) { /* throws SupadataError from the JSON body */ }
  return await n.json();                 // Response object never escapes
}
```

Every method — `supadata.transcript()`, `.transcript.getJobStatus()`, `.metadata()` — funnels through it, so there is no per-call opt-out and no response-interceptor hook in the config (`{ apiKey, baseUrl? }` only).

**Monkey-patching the global `fetch` does not work either.** The module binds it once at load time:

```js
import T from 'cross-fetch';
var f = fetch || T;   // captured at module init, before any app code runs
```

A later `globalThis.fetch = wrapper` is never observed by `f`. Interception would have to happen before the module is evaluated — fragile in a Workers bundle, and invisible at the call site.

### The in-repo precedent: call the endpoint directly

`src/lib/services/metadata.ts:43` **already** bypasses the SDK for `/v1/metadata`, calling `fetch` directly and re-throwing the vendor body as a `SupadataError` so downstream error handling (`isRetryable`) sees the same codes it would have seen through the SDK. The transcript path can follow the identical pattern; the endpoints are thin GETs:

| SDK call | Actual request |
| --- | --- |
| `supadata.transcript({ url, text, mode, lang })` | `GET /v1/transcript?url=…&text=true&mode=auto&lang=en` |
| `supadata.transcript.getJobStatus(jobId)` | `GET /v1/transcript/{jobId}` |
| `supadata.metadata({ url })` | `GET /v1/metadata?url=…` (already direct) |

Headers on all three: `x-api-key`, `Content-Type: application/json`. The SDK adds a `User-Agent: supadata-js/1.4.0`; preserving it is optional and free.

Error semantics to preserve when replacing the SDK call in `transcript.ts`:

- non-`2xx` **with** a JSON body → `new SupadataError(body)` (keeps `error === "transcript-unavailable"` working at `transcript.ts:76`);
- non-`2xx` **without** JSON → `SupadataError({ error: "internal-error", … })`;
- `2xx` with a non-JSON content-type → `SupadataError({ error: "internal-error", message: "Invalid response format" })`.

`metadata.ts:31-77` is a working implementation of exactly this to copy from.

## Parsing contract

The header value is a credit figure as a decimal string (§Resolved settles the unit). Parse defensively — this is telemetry attached to work already paid for, and a malformed header must never fail a generation. `src/lib/services/supadata-ledger.ts` (`readBillableCredits`) is the implementation; it is stricter than a plain `parseInt`, deliberately:

```ts
const raw = response.headers.get("x-billable-requests");
if (raw === null) return null;
if (!/^\d+$/.test(raw.trim())) return null;
const parsed = Number(raw);
return Number.isSafeInteger(parsed) && parsed <= 2_147_483_647 ? parsed : null;
```

Two rules the shorter `Number.parseInt(raw, 10)` form gets wrong, and why each is load-bearing:

- **Whole-string match, not a prefix.** `parseInt` reads a valid prefix and discards the rest, turning `"1oops"` and `"1.5"` into `1` — inventing a precise-looking measurement out of a value the vendor did not send. This ledger's whole claim is that the figure is *measured* rather than inferred, so a header we cannot read in full has to become `null` — honestly unreported — not a plausible guess.
- **Range-check against PostgreSQL `integer`.** The column is an `int4`. An out-of-range value fails the cast inside `record_supadata_calls`, and because the flush is ONE batch insert, that failure would discard every other row for the request — losing good measurements to one bad header.

`null` means "not reported"; `0` means "reported free". Keeping them distinct is what makes the reconciliation diagnosable — §Measured Finding 2 is the payoff: the billable `206` reports nothing, and its `null` localised the gap to one known call shape instead of leaving an unexplained discrepancy.

## Related

- `GET /v1/me` → `{ organizationId, plan, maxCredits, usedCredits }` — billing-period totals; the reconciliation counterpart, not a substitute. See `../../persist-video-metadata/docs/supadata-account-limits.md`.
- Per-credit prices (1 native / 2-per-minute generated / 1 metadata / free polls / 1 for a billable `transcript-unavailable`): `../../persist-video-metadata/docs/supadata-transcript.md` §Pricing.

**Source:** Supadata docs (`docs.supadata.ai/get-transcript`, `/api-reference/endpoint/account/me`) via Context7 `/llmstxt/supadata_ai_llms_txt` and `/supadata-ai/js`, 2026-07-28; plus direct inspection of the installed `@supadata/js@1.4.0` bundle. §Measured adds live observations from the 2026-07-29 local verification pass (5 generations + 2 direct probes, reconciled against `GET /v1/me`).
