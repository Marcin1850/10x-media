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

### What it settles that `resolved_via` cannot

| Question | `resolved_via` | `x-billable-requests` |
| --- | --- | --- |
| Native (1 credit) vs Whisper (2/min)? | ❌ Inference. `auto` falls back silently; `inline`/`job` describes the transport | ✅ The number is the bill |
| Cost of a request that produced no summary? | ❌ No row shape carries it | ✅ Header is on the error response too |
| Cost of a long video that jobbed but *was* native? | ❌ `job` over-counts it | ✅ Exact |

The `job` path is the specific trap: a long native-caption video can return a `202` job and be billed 1 credit, while `resolved_via = 'job'` would price it at `2 × ceil(duration/60)`. Phase 1's retrospective estimate is therefore an upper bound by construction — and the header is what turns Phase 5 from "the estimate looks plausible" into a reconciliation.

## ⚠️ Unverified: is the value credits or a request count?

**The name and the documentation disagree.** The header is called `x-billable-requests`, but the only sentence describing it frames it as the way to monitor *credit usage*. Those diverge exactly where it matters most:

| Call | Billable requests | Credits |
| --- | --- | --- |
| Native transcript | 1 | 1 |
| Metadata | 1 | 1 |
| **Whisper job, 3-min video** | **1** | **6** (2/min) |

So if the header reports a request *count*, it does **not** settle the native-vs-Whisper question on its own — and `resolved_via` + `videos.duration_seconds` become more necessary, not less, because they would be the only way to convert counts into cost.

This does not change the ledger's shape: the value is recorded verbatim either way, and `operation` / `outcome` carry the attribution regardless. It changes what Phase 5 proves. **The reconciliation settles it mechanically**: on a native short video the two readings are identical (1 = 1), so run the comparison on a video that takes the `job` path — if `usedCredits` moves by `2 × ceil(duration/60)` while the header reported `1`, it is a count. Record the answer here.

Until then, treat the column name `billable_credits` as provisional; if it turns out to be a count, rename to `billable_requests` before the ledger accumulates rows anyone reasons from.

## ⚠️ Unverified: which responses actually carry it

The doc sentence is the *only* statement Context7 surfaces about this header. Nothing in the docs or the OpenAPI spec confirms its value on:

- the initial **`202` job-accepted** response (is the credit charged at submission, at completion, or split?);
- **`GET /transcript/:jobId`** polls, which are documented free (`supadata-transcript.md:80`) and should therefore report `0`;
- **4xx/5xx** bodies — "every API response" implies yes, but a `401`/`429` plausibly bills nothing.

**These are implementation-time findings, not blockers.** The column is nullable and the value is recorded verbatim; a missing or absent header stores `null`, which is honestly distinguishable from a measured `0`. Phase 5's `GET /v1/me` delta is the cross-check: if the summed ledger disagrees with `usedCredits`, the disagreement localises to whichever call shape returned `null`.

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

The header value is a request count/credit figure as a string. Parse defensively — this is telemetry attached to work already paid for, and a malformed header must never fail a generation:

```ts
const raw = response.headers.get("x-billable-requests");
const parsed = raw === null ? null : Number.parseInt(raw, 10);
const billableCredits = parsed !== null && Number.isFinite(parsed) ? parsed : null;
```

`null` means "not reported"; `0` means "reported free". Keeping them distinct is what makes the Phase 5 reconciliation diagnosable.

## Related

- `GET /v1/me` → `{ organizationId, plan, maxCredits, usedCredits }` — billing-period totals; the reconciliation counterpart, not a substitute. See `../../persist-video-metadata/docs/supadata-account-limits.md`.
- Per-credit prices (1 native / 2-per-minute generated / 1 metadata / free polls / 1 for a billable `transcript-unavailable`): `../../persist-video-metadata/docs/supadata-transcript.md` §Pricing.

**Source:** Supadata docs (`docs.supadata.ai/get-transcript`, `/api-reference/endpoint/account/me`) via Context7 `/llmstxt/supadata_ai_llms_txt` and `/supadata-ai/js`, 2026-07-28; plus direct inspection of the installed `@supadata/js@1.4.0` bundle.
