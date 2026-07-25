# Supadata — account, plans, rate limits (`GET /v1/me`)

**REST base:** `https://api.supadata.ai/v1` · **Auth:** `x-api-key` header · Context7: `/llmstxt/supadata_ai_llms_txt` · **Fetched 2026-07-25**

**Role here:** the budget and throughput envelope both S-08 (adds a call) and S-09 (bounds a call) have to fit inside. Also the API S-09's lever C would use.

## `GET /v1/me`

Retrieves organization details, plan information and credit usage. **Free** to call.

```ts
{
  organizationId: string,
  plan: string,          // subscription plan name
  maxCredits: number,    // maximum credits for the current billing period
  usedCredits: number,   // credits used in the current billing period
}
```

Responses: `200`, `401` unauthorized, `500` internal error.

### Live state of this project's account (2026-07-25)

```json
{
  "organizationId": "da31c6d0-3e4b-4b3a-9a6c-1c57275e9d6c",
  "plan": "Free (100/mo)",
  "maxCredits": 100,
  "usedCredits": 29
}
```

This is the measured basis for both slices' arithmetic. **71 credits remained** at capture time.

## What the plan buys, per credit cost

| Operation | Cost | Ceiling on a 100-credit month |
| --- | --- | --- |
| Metadata request | 1 credit (flat) | — |
| Native transcript | 1 credit | ~100 generations |
| Native transcript **+ metadata** (post-S-08) | 2 credits | **~50 generations** |
| Generated (Whisper) transcript | **2 credits/minute** | a single **~50-minute** video exhausts the month |
| Job-status poll | free | — |
| `206` transcript-unavailable | 1 credit | — |

The last row of the Whisper line is S-09's whole reason for existing: nothing in the code bounds it, because `HARD_MAX_TRANSCRIPT_CHARS` is evaluated *after* the fetch that spends the money.

## Rate limits

The free/Basic tier allows **1 request per second**. Breaching it returns the shared error enum's `limit-exceeded`.

Direct consequence for S-08: firing `/metadata` concurrently with the transcript fetch puts two requests in the same second. Because metadata is non-fatal by design, the failure surfaces as *silently null metadata* rather than an error — so the two Supadata calls must be ordered, not parallelised. (S-09's duration pre-gate lever orders them naturally.)

## Plan tiers — ⚠️ unreliable, re-check live

Two captures disagree and one contradicts itself:

| Source | Claim |
| --- | --- |
| F-02 docs, 2026-07-05 (`../../transcript-llm-probe/docs/supadata.md:42`) | Free 100/mo · Basic **$5 → 300** · Pro **$17 → 3,000** |
| Context7 extraction, 2026-07-25 | Basic free 100/mo @ 1 req/s · Pro **$9 → 1,000** @ 50 req/s · … · Supa **$897 → 1,000,000**; intermediate Ultra / Mega / Giga tiers |
| Same extraction, second snippet | Supa @ **100 req/s** — while the first says up to **500 req/s** on Giga |

Either pricing changed in the intervening three weeks or the extraction is lossy; the self-contradiction on throughput says at least one snippet is unreliable. **Do not plan against these numbers.** `GET /v1/me` and supadata.ai/pricing are the authorities. The per-credit operation costs above were consistent across every source and are safe to reason with — it is only the plan/price/throughput table that is in doubt.

**Source:** Supadata docs (`docs.supadata.ai/api-reference/endpoint/account/me`, `supadata.ai/playground`) via Context7 + one live `GET /v1/me` call, 2026-07-25.
