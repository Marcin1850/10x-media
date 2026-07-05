# Supadata — YouTube transcript API

**Package:** `@supadata/js` · **REST base:** `https://api.supadata.ai/v1` · Context7: `/llmstxt/supadata_ai_llms_txt`, `/supadata-ai/js`

**Role in F-02:** fetch the YouTube transcript from the Worker. Chosen because direct `timedtext` fetches are blocked on Cloudflare datacenter IPs (see `../research.md`). A managed API is a plain `fetch` — no `nodejs_compat` surface, no CPU-heavy parsing on the Worker. `auto` mode adds a Whisper fallback, which resolves PRD Open Q1 ("video without a transcript").

## Install

```bash
npm install @supadata/js
```

## Usage (SDK)

```ts
import { Supadata } from "@supadata/js";

const supadata = new Supadata({ apiKey: process.env.SUPADATA_API_KEY });

const transcript = await supadata.transcript({
  url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  lang: "pl",     // optional preferred language (ISO 639-1)
  text: true,     // true → plain text (ideal LLM input); false → timestamped chunks
  mode: "auto",   // "native" (existing captions only) | "generate" (always Whisper) | "auto" (native → Whisper fallback)
});
// text:true → { content: string, lang: string, availableLangs: string[] }
```

YouTube-namespaced variant: `supadata.youtube.transcript({ url })`. Also `supadata.youtube.translate({ videoId, lang })`, `.batch(...)`.

## Usage (REST — equivalent, if avoiding the SDK on workerd)

```
GET https://api.supadata.ai/v1/youtube/transcript?url=<video-url>&text=true&lang=pl
Header: x-api-key: <SUPADATA_API_KEY>
```

Response (`text=true`): `{ "content": "...", "lang": "en", "availableLangs": ["en","es",...] }`

## Pricing / limits (2026-07-05)

- **Free tier: 100 credits/mo.** Basic $5 → 300, Pro $17 → 3,000.
- Native transcript = **1 credit**; AI-generated (Whisper) = **2 credits/min** of video.
- `206` "transcript unavailable" response = 1 credit; job-status checks are free.
- Cost/vendor risk replaces the (unsolvable in-house) "YouTube blocks our IP" risk.

## Handling the residual "no transcript" case

Even with `mode: "auto"`, some videos return unavailable (`206`). Surface a user-facing message (PRD Open Q1 remainder) rather than failing silently.

## Alternatives (same shape, if Supadata disappoints)

TranscriptAPI.com, Captapi, `youtube-transcript-api14` (RapidAPI) — all REST, JSON, most with Whisper fallback. Supadata has the most mature JS SDK.

**Source:** Supadata docs (`docs.supadata.ai/get-transcript`, `/pricing`, npm `@supadata/js`) via Context7 + Exa, 2026-07-05.
