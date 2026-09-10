# 10xMedia

![10xMedia](./public/banner.png)

Turn a list of YouTube videos into summaries that tell you what's actually worth watching — and give you the key content of the ones you skip, so you don't have to watch them at all. Summaries are generated in Polish and adapted to the character of the channel (informational vs. educational).

> **Status: MVP / learning project.** 10xMedia is built as the course project for [10xDevs](https://www.10xdevs.pl/) 3.0. It is intentionally scoped to a single end-to-end flow, not fully hardened for production, and some operations are manual by design (credit refills, deploys of secrets). Expect rough edges and breaking changes. See [Project status](#project-status) for details.

## Tech Stack

- [Astro](https://astro.build/) v6 - Modern web framework with server-first rendering
- [React](https://react.dev/) v19 - UI library for interactive components
- [TypeScript](https://www.typescriptlang.org/) v5 - Type-safe JavaScript
- [Tailwind CSS](https://tailwindcss.com/) v4 - Utility-first CSS framework
- [Supabase](https://supabase.com/) - Authentication and backend-as-a-service
- [Supadata](https://supadata.ai/) - YouTube transcript fetching
- [OpenRouter](https://openrouter.ai/) - LLM gateway used for summarization
- [Cloudflare Workers](https://workers.cloudflare.com/) - Edge deployment runtime

## Prerequisites

- Node.js v22.14.0 (as specified in `.nvmrc`)
- npm (comes with Node.js)

### Accounts and API keys

| Service                               | Required for               | Account needed?                                                     |
| ------------------------------------- | -------------------------- | ------------------------------------------------------------------- |
| [Supabase](https://supabase.com/)     | Auth, database             | Only for a hosted project — the local Docker stack needs no account |
| [Supadata](https://supadata.ai/)      | Fetching video transcripts | **Yes** — free tier available                                       |
| [OpenRouter](https://openrouter.ai/)  | Generating summaries       | **Yes** — pay-as-you-go, requires credit                            |
| [Cloudflare](https://cloudflare.com/) | Deployment only            | Only to deploy; not needed for local dev                            |

Auth works without the Supadata, OpenRouter, and Supabase service-role keys, but summary generation stays disabled — the app detects missing keys at runtime (`src/lib/config-status.ts`) and surfaces a notice instead of failing on a paid call.

## Getting Started

1. Clone the repository:

```bash
git clone https://github.com/Marcin1850/10x-media.git
cd 10x-media
```

2. Install dependencies:

```bash
npm install
```

3. Set up Supabase and configure environment variables — see [Supabase Configuration](#supabase-configuration) below.

4. Add your Supadata and OpenRouter keys — see [Supadata Configuration](#supadata-configuration) and [OpenRouter Configuration](#openrouter-configuration).

5. Create a `.dev.vars` file for local Cloudflare dev secrets:

```bash
cp .env.example .dev.vars
```

6. Run the development server:

```bash
npm run dev
```

The app is served at **http://localhost:4321**.

> Secrets live in **two** files: `.env` (Node scripts) and `.dev.vars` (Cloudflare local dev). Keep them in sync — the dev server reads `.dev.vars`, so a key added only to `.env` will look "missing" in the app.

## Available Scripts

- `npm run dev` - Start development server (Cloudflare workerd runtime)
- `npm run build` - Build for production
- `npm run preview` - Preview production build
- `npm run lint` - Run ESLint with type-checked rules
- `npm run lint:fix` - Auto-fix ESLint issues
- `npm run format` - Run Prettier
- `npm run typecheck` - Type-check `.ts`/`.tsx` (`tsc --noEmit`); the build does **not** do this
- `npm run typecheck:astro` - Type-check `.astro` files (`astro check`); nothing else covers them
- `npm test` - Run the unit suite once (Vitest)
- `npm run test:watch` - Run the unit suite in watch mode while writing tests
- `npm run test:integration` - Run the integration suite once (Vitest); needs a local Supabase stack (`npx supabase start`) and all five env keys set — see [CI](#ci)
- `npm run test:e2e` - Run the browser suite once (Playwright, `tests/e2e/*.spec.ts`); needs a local Supabase stack, the three `SUPABASE_*` keys, and `npx playwright install --with-deps chromium`. It builds the app and starts its own server on port 4321, so **stop your own dev server first** — see [End-to-end tests](#end-to-end-tests)
- `npm run test:coverage` - v8 coverage report for the unit suite into `coverage/`; no thresholds, by design
- `npm run grant-credits` - Grant summary credits to a user (operator-only, see [Summary credits](#summary-credits))
- `npm run db:sync-from-prod` - Copy production data into the local Supabase stack

## Project Structure

```md
.
├── src/
│ ├── layouts/ # Astro layouts
│ ├── pages/ # Astro pages
│ │ └── api/ # API endpoints
│ ├── components/ # UI components (Astro & React)
│ ├── lib/ # Services and business logic
│ │ └── services/ # Transcript (Supadata) and LLM (OpenRouter) clients
│ ├── styles/ # Global styles
│ └── middleware.ts # Auth resolution and route protection
├── tests/e2e/ # Playwright specs (\*.spec.ts) and their fixtures — the only tests
│ # not colocated, because they drive a server, not a module
├── supabase/migrations/ # Database migrations
├── scripts/ # Offline operator scripts
├── public/ # Public assets
├── worker.ts # Worker entry: the adapter's handler wrapped with Sentry's `withSentry`
├── sentry.client.config.ts # Browser Sentry init, injected into every page by `@sentry/astro`
├── wrangler.jsonc # Cloudflare Workers config (`main` points at worker.ts)
├── playwright.config.ts # E2E runner (see "End-to-end tests")
├── .dev.vars.e2e # Committed, non-secret env for e2e runs — do not gitignore
```

## Environment variables

All variables are declared via Astro's `astro:env` schema (`astro.config.mjs`), and all of them are **optional** — a build with none of them set still succeeds, and the app degrades with a notice rather than failing on a paid call.

Two contexts are in play, and the distinction is load-bearing. Everything except `PUBLIC_SENTRY_DSN` is a **server secret**: read at runtime through `astro:env/server`, never exposed to the client. `PUBLIC_SENTRY_DSN` is the one **client** value — it is inlined into the browser bundle at build time, on purpose, because a browser cannot report an error to Sentry without knowing where to send it. A DSN is a write-only ingest endpoint, not a credential, which is why it is the one value this project is willing to ship to the browser.

| Variable                    | Context | Purpose                                                                               |
| --------------------------- | ------- | ------------------------------------------------------------------------------------- |
| `SUPABASE_URL`              | server  | Supabase project URL                                                                  |
| `SUPABASE_KEY`              | server  | Supabase `anon` public key                                                            |
| `SUPADATA_API_KEY`          | server  | Supadata API key (transcripts)                                                        |
| `OPENROUTER_API_KEY`        | server  | OpenRouter API key (summarization)                                                    |
| `SUPABASE_SERVICE_ROLE_KEY` | server  | Service-role key — account deletion, summary generation, and offline operator scripts |
| `SENTRY_DSN`                | server  | Sentry DSN for the **Worker** runtime — a Worker secret, read at runtime              |
| `PUBLIC_SENTRY_DSN`         | client  | Sentry DSN for the **browser** — a build input, inlined into the client bundle        |

Copy `.env.example` to both `.env` and `.dev.vars` and fill in the values.

Both Sentry entries are commented out in `.env.example` and should stay unset locally: an unset DSN leaves the SDK uninitialised, and that absence — not a runtime flag — is what keeps local development, both Vitest suites, the e2e run and CI from filing real issues against the operator's Sentry project. They may carry the same DSN string; there are two entries because they are delivered by two different mechanisms (a Worker secret versus a build-time input). See [CI](#ci) and [Deployment](#deployment).

`SUPABASE_SERVICE_ROLE_KEY` bypasses RLS, so it is only ever read from `astro:env/server` inside server code (`src/lib/supabase-admin.ts`) and never reaches an island or the browser. It has three consumers:

- **`POST /api/account/delete`** (Worker runtime) — deleting an `auth.users` record requires the service-role key; the anon SSR client cannot do it. Without this secret the endpoint returns `503` and account deletion is unavailable.
- **`npm run grant-credits`** (offline, your machine) — reads it from `.env`.
- **`POST /api/summaries/generate`** (Worker runtime) — generation _reserves_ credits in a durable ledger _before_ the paid LLM call, and only the admin client can settle or refund that reservation once the work succeeds or fails. The endpoint refuses with `503` when the key is unset rather than risk charging a user for failed work.

All three need it, so it must be set locally **and** as a Worker secret in production.

## Supabase Configuration

This project uses [Supabase](https://supabase.com/) for authentication and data storage.

### First-time setup (local, no cloud project needed)

Requires [Docker](https://www.docker.com/) and ~7 GB RAM.

1. Create your `.env` file:

```bash
cp .env.example .env
```

2. Initialize the local Supabase project (creates a `supabase/` config folder):

```bash
npx supabase init
```

3. Start the local stack (downloads Docker images on first run):

```bash
npx supabase start
```

4. Copy the credentials printed by the CLI into your `.env` and `.dev.vars`:

```
SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_KEY=<anon key from CLI output>
```

5. Apply the database migrations:

```bash
npx supabase migration up
```

This creates all application tables. Supabase Auth's built-in `auth.users` table is managed separately and needs no migration.

6. To stop the stack when done:

```bash
npx supabase stop
```

The local Studio UI is available at `http://localhost:54323`.

### Using a cloud Supabase project instead

If you prefer to use a hosted Supabase project, add these variables to your `.env` and `.dev.vars` files:

| Variable       | Description                                                |
| -------------- | ---------------------------------------------------------- |
| `SUPABASE_URL` | Project URL from Supabase dashboard → Settings → API       |
| `SUPABASE_KEY` | `anon` public key from Supabase dashboard → Settings → API |

```
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_KEY=<anon-key>
```

### Email confirmation in local development

By default Supabase requires email confirmation before a user can sign in. You have two equally valid paths locally — pick one:

**Option A — keep confirmation on (mirrors production).** Sign-up sends a real confirmation email whose link returns to the in-app `/auth/callback` route (which exchanges the code for a session). For this to work locally, the local callback URL must be allow-listed:

1. Supabase dashboard → **Authentication → URL Configuration**
2. Under **Redirect URLs**, add:
   ```
   http://localhost:4321/auth/callback
   ```

Without this entry Supabase ignores the app's `emailRedirectTo` and falls back to the Site URL, so the link won't return to your local app. If you run a local Supabase stack (see below), confirmation emails land in Inbucket at **http://localhost:54324**, not a real inbox.

**Option B — skip confirmation (fastest for iterating).** Disable it entirely:

1. Open the Supabase dashboard for your project
2. Go to **Authentication → Email → Confirm email**
3. Toggle it **off**

Users can then sign in immediately after sign-up without clicking a confirmation link.

### Auth routes

| Route                 | Description                                                             |
| --------------------- | ----------------------------------------------------------------------- |
| `/auth/signin`        | Email/password sign-in form                                             |
| `/auth/signup`        | Email/password sign-up form                                             |
| `/auth/confirm-email` | Post-signup "check your inbox" page                                     |
| `/auth/callback`      | Exchanges the email-confirmation code for a session (Option A above)    |
| `/dashboard`          | Example protected page (redirects to `/auth/signin` if unauthenticated) |

Route protection is handled in `src/middleware.ts`. Add paths to the `PROTECTED_ROUTES` array there to require authentication.

## Supadata Configuration

[Supadata](https://supadata.ai/) fetches YouTube transcripts, which are the input to summarization. There is no local substitute — you need an account and a key even for local development.

1. Sign up at [supadata.ai](https://supadata.ai/).
2. Create an API key in the dashboard.
3. Add it to both `.env` and `.dev.vars`:

```
SUPADATA_API_KEY=<your-key>
```

Supadata offers a free tier that is sufficient for development. Transcripts are requested in Polish (`lang: "pl"`) with `mode: "auto"`; when a video needs Whisper transcription the API returns a job, which `src/lib/services/transcript.ts` polls with exponential backoff. Videos with no obtainable transcript are reported as unavailable rather than failing the request.

## OpenRouter Configuration

[OpenRouter](https://openrouter.ai/) is the LLM gateway used to generate summaries. It is a **paid** service — calls consume real credit.

1. Sign up at [openrouter.ai](https://openrouter.ai/).
2. Add credit to your account (summarization will not run on a zero balance).
3. Create a key under **Keys**.
4. Add it to both `.env` and `.dev.vars`:

```
OPENROUTER_API_KEY=<your-key>
```

The model is pinned in `src/lib/services/llm.ts` (`anthropic/claude-sonnet-5`). Because each summary costs money, the app guards generation behind the credit system described below — the server refuses to call OpenRouter when a user is out of credits.

> Consider setting a spend limit on your OpenRouter key while developing.

## Summary credits

Each user has a small credit budget that guards the paid transcript/LLM pipeline. Every account starts with **5 credits**; a successful summary spends **1 credit**, or **2 credits** for a long video generated after the confirmation prompt. Generation is blocked server-side whenever the balance is below the cost of the request — so a 1-credit balance still covers a short video, but is refused against a long one. Refills are **manual-only** — there is no self-serve top-up.

A submission that produces no summary can still cost a credit. Most refusals (a missing field, an unsupported URL, being out of credits) are free, but four specific 422 exits reached only after a transcript lookup — a cached or freshly-fetched video with no usable transcript, or an empty transcript — charge 1 credit, because the transcript API has already billed the app by the time the app can tell the submission won't produce a summary. The one exception is a transient fetch failure (an outage, ours or the vendor's): that exit does not charge, because the cost in that case is unknown rather than zero. The response body reports the outcome (`charged: true`/`false`, or `ambiguousCharge: true` when a retry cannot tell), and it carries the resulting balance as `creditsRemaining` whenever the server knows it, so the app never keeps showing a number the last request has already changed — the credit figure in the header updates in place, without a reload. The UI shows the `charged: true`/`false` cases — a charge you can be told about is never silent. The ambiguous case is deliberately not rendered: when the app cannot prove which way a credit went, it says nothing about it rather than guessing, and the retry it invites settles the question.

Every error the endpoint returns whose status covers more than one cause carries a machine-readable `code` beside the English `error` string, and the interface renders the Polish copy for that code (`src/lib/copy/pl.ts`). The code exists because one status can mean several things — a 422 covers "this video has no caption track", "a transcript came back with no words in it" and "we could not reach the transcript service", which a user must act on differently — so translating one string per status would have merged them. The two 502s and the 401 deliberately carry no code: each status has exactly one cause, so its per-status Polish message is already the right one and a code would only add a second place to keep that copy correct. The English `error` stays on the body for logs and non-browser consumers and never reaches the interface — the client's mapper does not take it as an argument, so an unknown or missing code falls back to the per-status Polish message rather than to English. `src/lib/copy/error-codes.test.ts` fails the build if the endpoint sends a code the copy table has no entry for.

To grant credits to a user by email (operator-only, offline):

```bash
npm run grant-credits -- <email> <amount>
# e.g. npm run grant-credits -- user@example.com 5
```

This script runs offline on your machine and reads the Supabase **service-role** key (which bypasses RLS) from `.env`. Set `SUPABASE_SERVICE_ROLE_KEY` there — the `service_role` key from `npx supabase status` (local) or the dashboard → **Settings → API**. See [Environment variables](#environment-variables) for the key's other consumers.

## End-to-end tests

`npm run test:e2e` drives the real app in Chromium — paste a URL, get a summary — and checks not only what the card says but what the database actually recorded. That pairing is the point: a card that agrees with itself while disagreeing with the ledger is the exact failure this suite exists to catch.

```bash
npx supabase start                                # Docker; the same stack the integration suite uses
npx playwright install --with-deps chromium       # once per machine
npm run test:e2e
```

Three things are worth knowing before the first run:

- **It builds the app and starts its own server on port 4321.** Stop your own `npm run dev` first — the runner deliberately refuses to reuse a server it did not start, so an occupied port is a loud startup error rather than a silently misconfigured run. The build costs about 30 seconds, once per run.
- **No run ever contacts a paid vendor.** Specs pre-seed the transcript and metadata caches, so Supadata is never called; OpenRouter is replaced at build time by a fake summarizer that only exists when `E2E_FAKE_LLM` is set — which the production build never sets, so the shipped Worker cannot contain it.
- **`.dev.vars.e2e` is committed, and that is deliberate.** It holds the Supabase CLI's public local demo keys plus deliberate non-credentials for the two vendors, and it is what stops an e2e run from picking up the real keys in your `.dev.vars`. Do not add it to `.gitignore`; the suite refuses to start without it.

The full cookbook — locators, waits, the two-sided oracle, and what is deliberately not covered — is `context/foundation/test-plan.md` §6.4.

## Error monitoring

The events that matter operationally — a budget threshold crossed, a generation whose credit outcome the app could not determine, a refund that failed, a cache that stopped working — reach [Sentry](https://sentry.io/), so the operator is notified instead of having to go and read logs. **Production is the only environment that reports.**

**One seam.** Every event goes through `src/lib/services/reporting.ts`. `reportEvent(key, severity, payload)` writes a console line and forwards it; `captureEvent` only forwards, for sites that already log their own line. Forwarding is fire-and-forget and never throws, because the seam runs inside the paid generation path. Each event is fingerprinted by its key and severity, so one ongoing condition is one Sentry issue however often it fires, and the payload travels as structured context rather than as message text. Events carry no user identifiers, with one documented exception: the reconciliation family (`[charge-ambiguous:*]`, `[credit-leak:*]`, `[replay-read:*]`) carries the opaque ids of the ledger row an operator has to go and fix. The module's header comment is the authority on that rule.

**Two runtimes, two DSNs, two delivery mechanisms.**

| Runtime | Initialised by                                                         | DSN                 | How the DSN gets there                                                                    |
| ------- | ---------------------------------------------------------------------- | ------------------- | ----------------------------------------------------------------------------------------- |
| Worker  | `worker.ts` — the adapter's handler wrapped with `withSentry`          | `SENTRY_DSN`        | Cloudflare Worker secret, read at runtime from the request's `env`                        |
| Browser | `sentry.client.config.ts`, injected into every page by `@sentry/astro` | `PUBLIC_SENTRY_DSN` | GitHub repository secret, inlined into the client bundle by the `deploy` job's build step |

The two initialise independently: a Worker that reports proves nothing about the browser, and vice versa. Both lock data collection down the same way — no cookies (they are Supabase session tokens), no request or response bodies, no database query data, no LLM inputs or outputs — and neither enables performance tracing or session replay.

**Why neither DSN is set anywhere else.** An unset DSN leaves the SDK uninitialised, and that absence is the whole guarantee: local development, both Vitest suites, the e2e run and the `ci`/`integration`/`e2e` CI jobs send nothing because they have no DSN, not because a flag is switched off. Keep both keys commented out in `.env` and `.dev.vars` — a local DSN files real issues against the operator's project, mixed in with production incidents. Three guards back this up: the e2e runner **refuses to start** if either DSN — or the source-map upload token — is set (`playwright.config.ts`), its browser fixture fails any test whose page attempts a Sentry request (`tests/e2e/fixtures/no-sentry.ts`), and the integration suite's `fetch` firewall throws on any non-loopback request.

**Source maps.** Production stack traces are de-minified by uploading source maps at build time. The upload runs only when `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT` **and** `PUBLIC_SENTRY_DSN` are all present in the build environment (`astro.config.mjs`) — in this workflow, the `deploy` job's build alone. Every other build emits no maps and never runs Sentry's upload plugin. Keep these three out of `.env` just like the DSNs. The maps are deleted from `dist/` right after the upload (`@sentry/astro`'s default), so they never ship to Cloudflare. A failed upload does **not** fail the build: the plugin logs `An error occurred. Couldn't finish all operations` and the deploy still goes green, with minified stack traces. So after setting or rotating the token, confirm the upload in the `deploy` job log (`Successfully uploaded source maps to Sentry`) or under **Project Settings → Source Maps → Artifact Bundles** in Sentry. Setting the three secrets is described under [CI](#ci).

**What notifies.** Every event reaches the Sentry dashboard — except that Sentry's default `Dedupe` drops an exact repeat of the previous event from the same client, so identical browser events within one page session count once — but the alert rule notifies only when an issue is **first seen or regresses** — never once per event. That is what makes alerting on `warn` survivable: the budget near-miss re-fires roughly once per budget reading for as long as the budget stays high, and it produces one notification, then accumulates quietly on its issue. The rule is configured in the Sentry UI, not in this repository, so recreating the project means recreating it by hand. The families that report:

- **Money integrity** — `[charge-ambiguous:*]`, `[credit-leak:*]`, `[replay-read:*]`, `[paid-path:*]`
- **Silent degradation** — `[transcript-cache:*]`, `[metadata-cache:*]`, `[transcript-guard:*]`, `[supadata-ledger:*]`, `[supadata-budget:settle-*]`, `[generation-lock:*]`
- **The original two** — `[supadata-budget]` thresholds (Worker) and `[unsupported-feature]` (browser)

On top of those, the SDKs report any exception that escapes unhandled. Expect few: this codebase resolves failures into outcomes rather than throwing.

**What is deliberately not monitored.** Failures the user already sees and retries, or that cost nothing and hide nothing, stay on the console only — read-path errors, a transcript-vendor outage the user is told about and not charged for, metadata trouble that only degrades presentation, and refusals that provably did not charge. The `error-monitoring` change plan's Promotion Roster names every such site with its reason. Uptime checks, performance tracing, session replay and product metrics are out of scope.

**Rolling back.** Neither half needs a code change, but they switch off differently:

- **Worker** — `npx wrangler secret delete SENTRY_DSN`. Wrangler deploys a new version without the binding, and the SDK disables itself from the next request.
- **Browser** — the DSN is baked into the deployed bundle, so deleting the `PUBLIC_SENTRY_DSN` repository secret stops reporting only after the **next deploy** (re-run the `deploy` job, or push to `master`).

## Deployment

This project deploys to [Cloudflare Workers](https://workers.cloudflare.com/). Pushes to `master` deploy automatically via GitHub Actions (see [CI](#ci)); the steps below are for deploying manually.

1. Build the project:

```bash
npm run build
```

2. Deploy with Wrangler:

```bash
npx wrangler deploy
```

Set all six runtime secrets in your Cloudflare dashboard or via `npx wrangler secret put`:

```bash
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_KEY
npx wrangler secret put SUPADATA_API_KEY
npx wrangler secret put OPENROUTER_API_KEY
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler secret put SENTRY_DSN
```

`PUBLIC_SENTRY_DSN` is deliberately **not** in that list. It is a client variable, so it is consumed by the _build_ and inlined into the browser bundle — setting it as a Worker secret would have no effect on what the browser ships. It belongs in the deploy job's build step instead, as a GitHub repository secret (see [CI](#ci)).

`SUPABASE_SERVICE_ROLE_KEY` is required in production: `POST /api/account/delete` needs it to remove the `auth.users` record, and `POST /api/summaries/generate` needs it to reserve/refund credits around the paid call. Skip it and both endpoints return `503` (account deletion and summary generation are unavailable) — auth and browsing keep working, so the gap is easy to miss.

Worker secrets are configured on Cloudflare, not injected by the deploy pipeline — adding a key to GitHub alone will not make it available at runtime.

## CI

GitHub Actions (`.github/workflows/ci.yml`) runs three jobs in parallel on every push and PR to `master`:

- **`ci`** — lint, token check, both type-checks, the unit suite (`npm test`), and the build.
- **`integration`** — starts a throwaway local Supabase stack (`npx supabase start`, non-essential services excluded) and runs the integration suite (`npm run test:integration`) against it. This job never touches `secrets.SUPABASE_URL` (that's production); it uses the Supabase CLI's fixed, publicly documented local-dev demo keys instead, plus literal placeholder values for the Supadata/OpenRouter keys — safe because every paid vendor call in that suite is faked at the `fetch`/module boundary. The suite covers two things: the paid path's charge-versus-delivery contract and its budget breaker, and the data-access boundary — that one account cannot read or delete another's rows, and that the schema's grants, policies and RLS flags still match a committed roster (so a migration that forgets to tighten a new table fails CI). See [Summary credits](#summary-credits) and `context/foundation/test-plan.md` §6.2–§6.3 for what the suite covers.
- **`e2e`** — the same throwaway Supabase stack plus Chromium, running the browser suite (`npm run test:e2e`) against a real build of the app. It holds **no vendor keys and no build step of its own**: Playwright's `webServer` does the build itself, and the app takes its five values from the committed `.dev.vars.e2e` (selected by `CLOUDFLARE_ENV=e2e`), which is the only channel that actually reaches it — so vendor keys in the job env would be ignored. Three specs cover the flows where a mistake costs a user money: generate-and-see-it, both charged refusals, and the long-video confirmation. Each asserts the card **and** the ledger. A failing run uploads its Playwright HTML report, trace included, as an artifact. See [End-to-end tests](#end-to-end-tests) and `context/foundation/test-plan.md` §6.4.

`deploy` (Cloudflare Workers, on pushes to `master`) needs **all three** jobs to pass. Its build step sets neither `E2E_FAKE_LLM` nor `CLOUDFLARE_ENV`, and both omissions are load-bearing: the first keeps the e2e fake summarizer out of the bundle entirely, the second keeps `.dev.vars.e2e`'s non-credentials from displacing the real Worker secrets.

The two Vitest suites are separate **projects** (`vitest.config.ts`), and every script names the one it means: `test`, `test:watch` and `test:coverage` all pass `--project unit`, `test:integration` passes `--project integration`. Keep that flag when editing these scripts — a bare `vitest` selects **both** projects, which would quietly make the unit watch and the coverage report require Docker and create real synthetic `auth.users` rows on every run. The e2e suite is not a Vitest project at all — it runs under Playwright (`playwright.config.ts`) from `tests/e2e/`, and its specs are named `*.spec.ts` precisely so the `unit` project's `src/**/*.test.ts` glob can never collect them.

Locally, git hooks catch most of the `ci` job's checks earlier: **pre-commit** runs lint-staged plus `npm run typecheck`, and **pre-push** runs `npm run typecheck:astro`. They are wired by husky via the `prepare` script, so a fresh `npm install` installs them — no manual step. Neither the integration nor the e2e suite is wired into any local git hook (both need Docker and take minutes) — pre-commit/pre-push only lint and typecheck `*.int.test.ts` and `tests/e2e/*.spec.ts` as plain TypeScript; run `npm run test:integration` and `npm run test:e2e` yourself before pushing changes that touch the paid path or the summary UI, or rely on the CI jobs to catch it.

Required repository secrets:

| Secret                  | Used by                            |
| ----------------------- | ---------------------------------- |
| `SUPABASE_URL`          | Build step                         |
| `SUPABASE_KEY`          | Build step                         |
| `PUBLIC_SENTRY_DSN`     | Build step (`deploy` job **only**) |
| `SENTRY_AUTH_TOKEN`     | Build step (`deploy` job **only**) |
| `SENTRY_ORG`            | Build step (`deploy` job **only**) |
| `SENTRY_PROJECT`        | Build step (`deploy` job **only**) |
| `CLOUDFLARE_API_TOKEN`  | Deploy step                        |
| `CLOUDFLARE_ACCOUNT_ID` | Deploy step                        |

The build does not need the Supadata or OpenRouter keys — every variable in the `astro:env` schema is declared `optional`, so the build succeeds without them. Neither the `integration` nor the `e2e` job needs any of these repository secrets.

`PUBLIC_SENTRY_DSN` reaches the **`deploy` job's build step and nothing else**, and that narrowness is the point: the `ci` and `e2e` jobs build without it, so the browser bundles they produce physically cannot carry a DSN and cannot report. The Worker's own `SENTRY_DSN` never appears here at all — it is a Cloudflare secret, set once with `wrangler secret put` (see [Deployment](#deployment)), not something the pipeline injects. The three source-map upload secrets follow the same deploy-only rule; until they exist the upload simply stays off, and the deploy still succeeds with minified production stack traces.

**Setting the source-map upload secrets.** A one-time step for the operator:

1. In Sentry, create an **organization token** under **Settings → Developer Settings → Organization Tokens**. It carries the `org:ci` scope, which covers uploading source maps and creating releases. Sentry shows the token only once, and emails the organization's owners that it was created.
2. Store it and the two slugs as repository secrets. Run this in your own terminal, so the token is typed into a prompt rather than into shell history or a chat transcript:

   ```bash
   gh secret set SENTRY_AUTH_TOKEN               # paste the token at the prompt
   gh secret set SENTRY_ORG --body <org-slug>
   gh secret set SENTRY_PROJECT --body <project-slug>
   gh secret list                                # shows names, never values
   ```

   The slugs are the ones in the organization's and the project's Sentry URLs. They live in secrets rather than in this public repository on purpose.

3. Secrets are read when a job runs, so re-run the latest `master` workflow (`gh run rerun <run-id>`) or push. Then check the `deploy` job log for `Successfully uploaded source maps to Sentry` — a green deploy alone does not prove the upload worked (see [Error monitoring](#error-monitoring)).

To rotate the token, create a new one, overwrite `SENTRY_AUTH_TOKEN` with `gh secret set`, and revoke the old token in Sentry (only organization owners and managers can revoke). To switch the upload off, delete `SENTRY_AUTH_TOKEN`; the four-value gate in `astro.config.mjs` then closes on the next deploy.

## Project status

This is an MVP developed during the **10xDevs 3.0** course, where it doubles as the sandbox for practising AI-assisted development workflows (`context/` holds the change plans driving that work).

What that means in practice:

- **Scope is deliberately narrow** — one flow: paste YouTube links → get Polish summaries.
- **No self-serve billing** — summary credits are granted manually by an operator.
- **Not fully production-hardened** — the unit suite covers risk-critical modules rather than the whole app, and error recovery is limited.
- **Breaking changes are expected** — migrations may be rewritten rather than layered.

## License

MIT
