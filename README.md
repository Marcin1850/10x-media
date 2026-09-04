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
├── supabase/migrations/ # Database migrations
├── scripts/ # Offline operator scripts
├── public/ # Public assets
├── wrangler.jsonc # Cloudflare Workers config
```

## Environment variables

All variables are declared via Astro's `astro:env` schema (`astro.config.mjs`) and are treated as **server-only secrets** — they are never exposed to the client.

| Variable                    | Purpose                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------- |
| `SUPABASE_URL`              | Supabase project URL                                                                  |
| `SUPABASE_KEY`              | Supabase `anon` public key                                                            |
| `SUPADATA_API_KEY`          | Supadata API key (transcripts)                                                        |
| `OPENROUTER_API_KEY`        | OpenRouter API key (summarization)                                                    |
| `SUPABASE_SERVICE_ROLE_KEY` | Service-role key — account deletion, summary generation, and offline operator scripts |

Copy `.env.example` to both `.env` and `.dev.vars` and fill in the values.

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

A submission that produces no summary can still cost a credit. Most refusals (a missing field, an unsupported URL, being out of credits) are free, but four specific 422 exits reached only after a transcript lookup — a cached or freshly-fetched video with no usable transcript, or an empty transcript — charge 1 credit, because the transcript API has already billed the app by the time the app can tell the submission won't produce a summary. The one exception is a transient fetch failure (an outage, ours or the vendor's): that exit does not charge, because the cost in that case is unknown rather than zero. The response body reports the outcome (`charged: true`/`false`, or `ambiguousCharge: true` when a retry cannot tell) and the UI shows it — the charge is never silent.

To grant credits to a user by email (operator-only, offline):

```bash
npm run grant-credits -- <email> <amount>
# e.g. npm run grant-credits -- user@example.com 5
```

This script runs offline on your machine and reads the Supabase **service-role** key (which bypasses RLS) from `.env`. Set `SUPABASE_SERVICE_ROLE_KEY` there — the `service_role` key from `npx supabase status` (local) or the dashboard → **Settings → API**. See [Environment variables](#environment-variables) for the key's other consumers.

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

Set all five runtime secrets in your Cloudflare dashboard or via `npx wrangler secret put`:

```bash
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_KEY
npx wrangler secret put SUPADATA_API_KEY
npx wrangler secret put OPENROUTER_API_KEY
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
```

`SUPABASE_SERVICE_ROLE_KEY` is required in production: `POST /api/account/delete` needs it to remove the `auth.users` record, and `POST /api/summaries/generate` needs it to reserve/refund credits around the paid call. Skip it and both endpoints return `503` (account deletion and summary generation are unavailable) — auth and browsing keep working, so the gap is easy to miss.

Worker secrets are configured on Cloudflare, not injected by the deploy pipeline — adding a key to GitHub alone will not make it available at runtime.

## CI

GitHub Actions (`.github/workflows/ci.yml`) runs lint, token check, both type-checks, the unit suite and the build on every push and PR to `master`, then deploys to Cloudflare Workers on pushes to `master`.

Locally, git hooks catch most of this earlier: **pre-commit** runs lint-staged plus `npm run typecheck`, and **pre-push** runs `npm run typecheck:astro`. They are wired by husky via the `prepare` script, so a fresh `npm install` installs them — no manual step.

Required repository secrets:

| Secret                  | Used by     |
| ----------------------- | ----------- |
| `SUPABASE_URL`          | Build step  |
| `SUPABASE_KEY`          | Build step  |
| `CLOUDFLARE_API_TOKEN`  | Deploy step |
| `CLOUDFLARE_ACCOUNT_ID` | Deploy step |

The build does not need the Supadata or OpenRouter keys — every variable in the `astro:env` schema is declared `optional`, so the build succeeds without them.

## Project status

This is an MVP developed during the **10xDevs 3.0** course, where it doubles as the sandbox for practising AI-assisted development workflows (`context/` holds the change plans driving that work).

What that means in practice:

- **Scope is deliberately narrow** — one flow: paste YouTube links → get Polish summaries.
- **No self-serve billing** — summary credits are granted manually by an operator.
- **Not fully production-hardened** — the unit suite covers risk-critical modules rather than the whole app, and error recovery is limited.
- **Breaking changes are expected** — migrations may be rewritten rather than layered.

## License

MIT
