# Deploy Plan: First deployment of 10x-media to Cloudflare Workers

> Audit artifact — "what was supposed to happen" for the first production deploy.
> Approved via Plan Mode on 2026-06-04. Consumed by downstream milestone planning as ground truth for what's deployed and which secrets are wired.

## Context

`infrastructure.md` recommends **Cloudflare Workers** (5/5 agent-friendly criteria, the starter's native target — zero migration). Stack (`tech-stack.md`): Astro 6 SSR + React 19, workerd runtime, Supabase auth, AI/LLM. Goal: a first manual production deploy via Plan Mode + wiring CI auto-deploy on merge to `master`.

Repo state confirmed deploy-ready, with four gaps to close:
- ✅ `@astrojs/cloudflare`, `wrangler.jsonc`, `nodejs_compat`, `compatibility_date: 2026-05-08`, `observability.enabled` — all in place. `node_modules` present, `dist` not yet built.
- ⚠️ Wrangler **not authenticated** (`wrangler whoami` → not authenticated).
- ⚠️ **No git remote** (needed for CI auto-deploy).
- ⚠️ Production needs a **cloud Supabase** — the local `supabase/` (127.0.0.1:54321) is unreachable from the Worker.
- ⚠️ `name` in `wrangler.jsonc` is still the default `10x-astro-starter` → rename to `10x-media`.

User decisions: create a new cloud Supabase project; rename the Worker to `10x-media`; also wire CI auto-deploy. User also has **no Cloudflare account yet**.

`tech-stack.md` already has the correct `deployment_target: cloudflare-workers` — the contract correction noted in `infrastructure.md` is already applied, no action.

> **Critical:** always deploy with `npx wrangler deploy` (Workers). **Never** `wrangler pages deploy` — the Astro adapter dropped Pages in 2025; the Pages path is dead.

---

## Manual gates (human-only — the agent does NOT run these)

These steps create external resources / grant irreversible access. Do them by hand before the agent starts deploying.

1. **Cloud Supabase project.** At [supabase.com](https://supabase.com) → New project. Once created: Settings → API → copy the **Project URL** and the **anon public key**. (The app uses only the built-in `auth.users` — no migrations to run. Optional: Authentication → Email → turn off "Confirm email" if you want sign-in without email verification.)
2. **Cloudflare account.** You don't have one yet — create it at [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up) (email + password, confirm the email). The **Free Workers plan is enough** for the MVP; risk-register note: long transcripts may exceed the free 10ms CPU budget → then Workers Paid $5/mo. After signup the dashboard shows your **Account ID** (Workers & Pages → right panel) and your `*.workers.dev` subdomain — both needed later.
3. **Wrangler login.** `npx wrangler login` — opens the browser (OAuth to the freshly created Cloudflare account). This selects the account the Worker lands on.
4. **Scoped API token for CI** (after the first manual deploy). Cloudflare dashboard → My Profile → API Tokens → Create Token → **"Edit Cloudflare Workers"** template, restricted to this one project, **no** DNS/billing/other secrets. Copy the token + Account ID.
5. **GitHub repo + secrets.** Create the repo and remote (`gh repo create 10x-media --private --source=. --remote=origin` or via the web UI). In the repo → Settings → Secrets and variables → Actions add: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `SUPABASE_URL`, `SUPABASE_KEY` (cloud values).
6. **Supabase Auth URL configuration** (post-deploy, once the worker URL is known). Supabase Dashboard → Authentication → **URL Configuration**. Without this, confirmation emails link back to the default `http://localhost:3000` and break on a deployed domain.
   - **Site URL** → the deployed origin, e.g. `https://10x-media.nightshiftlab.workers.dev`.
   - **Redirect URLs** (allow-list) → add `https://<deployed-origin>/auth/callback` **and** `http://localhost:4321/auth/callback` (local dev). The app's `signUp` sends `emailRedirectTo: <origin>/auth/callback`; Supabase ignores it unless the exact URL is allow-listed here.
   - Requires the in-app `/auth/callback` route (`src/pages/auth/callback.ts`) that runs `exchangeCodeForSession` — added during this deploy phase; the starter shipped without it.

**Human-only also after deploy** (per `infrastructure.md`): rotating the Supabase/AI key, deleting the Worker/project, destructive Supabase DB operations.

---

## Agent steps (after gates 1–3 pass)

### Phase A — first manual deploy

**Step A1 — rename the Worker** (the only file edit in the deploy)
In `wrangler.jsonc` change `"name": "10x-astro-starter"` → `"name": "10x-media"`. Production URL: `10x-media.<subdomain>.workers.dev`.

**Step A2 — build**
```powershell
npx astro sync
npm run build
```
Produces `dist/`. The Supabase secrets are `optional` in `astro.config.mjs`, so the build passes without them.

**Step A3 — deploy (creates the Worker)**
```powershell
npx wrangler deploy
```
The first deploy creates the Worker. Auth won't work yet (no secrets) — that's fine, fixed in A4.

**Step A4 — production secrets** (Workers Secrets, NOT `.env`)
```powershell
npx wrangler secret put SUPABASE_URL    # paste the cloud Project URL
npx wrangler secret put SUPABASE_KEY    # paste the anon public key
```
Secrets hot-apply to the running Worker and persist across subsequent deploys. Verify: `npx wrangler secret list` shows both.

### Phase B — CI auto-deploy on merge to master

**Step B1 — deploy job in `.github/workflows/ci.yml`**
After the existing `ci` job (lint+build), add a `deploy` job that depends on `ci`, runs only on `push` to `master` (not on PRs):
```yaml
  deploy:
    needs: ci
    if: github.ref == 'refs/heads/master' && github.event_name == 'push'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npx astro sync
      - run: npm run build
        env:
          SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
          SUPABASE_KEY: ${{ secrets.SUPABASE_KEY }}
      - run: npx wrangler deploy
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```
CI does not set Workers Secrets — those already live on the Worker from A4 and survive redeploys. CI only needs `CLOUDFLARE_API_TOKEN` (+ `ACCOUNT_ID`).

**Step B2 — push**
`git push -u origin master` → triggers CI → after a green build, auto-deploy.

---

## Verification (end-to-end)

1. **Live request:** open `https://10x-media.<subdomain>.workers.dev` — the landing page comes up (200).
2. **Runtime logs:** `npx wrangler tail` in a second window, refresh the page — check for no `nodejs_compat` / `node:` errors in the stream.
3. **Auth slice (week-1 must-do):** walk `/auth/signup` → `/auth/signin` → `/dashboard`. Confirms the cloud Supabase + Workers Secrets work end-to-end. This also front-loads the workerd / YouTube-IP risks from `infrastructure.md` while there's still schedule slack.
4. **Rollback works:** `npx wrangler deployments list` (shows versions), and if needed `npx wrangler rollback`.
5. **CI:** after `git push` the Actions tab shows green `ci` → `deploy`.

---

## Out of scope (per infrastructure.md)
Dockerfile, multi-region/HA/DR architecture. workerd runtime risks (YouTube blocking datacenter IPs, `nodejs_compat` gaps, CPU budget) are in the `infrastructure.md` risk register — the escape hatch is Railway (`@astrojs/node`, adapter-level swap only).

---

## Execution log
- 2026-06-04 — Plan approved via Plan Mode. Step A1 (Worker rename) and A2 (build) executed by agent. Steps A3+ blocked on manual gates 1–3 (Supabase project, Cloudflare account, `wrangler login`).
- 2026-06-05 — Manual gates 1–5 completed by user (subdomain: `nightshiftlab`). Step A3 deploy succeeded → live at **https://10x-media.nightshiftlab.workers.dev** (HTTP 200 on `/` and `/auth/signin`; Cloudflare auto-provisioned a `SESSION` KV namespace). Step B1 (CI `deploy` job in `ci.yml`) added by agent. Step A4 (Workers Secrets) is user-run — agent does not handle secret values.
- 2026-06-05 — Step B2 push → CI run #27040914594 green (`ci` ✓ → `deploy` ✓), confirming auto-deploy on merge to master works. Step A4 completed by user: `wrangler secret list` shows `SUPABASE_URL` + `SUPABASE_KEY`. End-to-end auth verified: POST `/api/auth/signin` (with matching Origin to pass Astro CSRF) returns `302 → /auth/signin?error=Invalid login credentials` — a Supabase response, proving the Worker reaches the cloud Supabase with the runtime secrets. **Deployment complete.** Known follow-up (non-blocking): bump `actions/checkout` + `actions/setup-node` to `@v5` (Node 20 deprecation, forced 2026-06-16).
- 2026-06-06 — Post-deploy auth bugfixes. Email confirmation linked to `localhost:3000` and the starter had no token-exchange route. Fix: added `/auth/callback` (`exchangeCodeForSession` + friendly error handling) and `emailRedirectTo` on `signUp`; fixed the hero CTA to reflect `Astro.locals.user`. Added **manual gate 6** (Supabase Auth URL Configuration) to this plan — it was missing originally and is the reason a fresh deploy on a new domain would hit the same bug. User completed gate 6 (Site URL + Redirect URLs incl. `/auth/callback`) and **manually confirmed the full signup → email → callback → session flow works**. Also bumped CI actions to `@v5`. Note for downstream: YouTube-summary feature (FR-005) not yet implemented, so the week-1 workerd/YouTube-IP risk probe from `infrastructure.md` is still pending and must run once that feature lands.
- 2026-07-14 — Residual starter-identity cleanup, outside this plan's scope but recorded here because Step A1 is the reason readers grep for the old name. Step A1's Worker rename landed in `204582d`; `package.json` followed in `dbf4262`. Two leftovers remained and are now fixed: `supabase/config.toml` `project_id` and the `name` fields in `package-lock.json`, both still `10x-astro-starter`. The `project_id` rename re-namespaces the local Supabase Docker containers (`supabase_*_10x-media`); the pre-rename stack's data was left in an orphaned volume labelled `com.supabase.cli.project=10x-astro-starter`, since removed by the user. Local dev data is reproducible via `npm run db:sync-from-prod`. Mentions of `10x-astro-starter` remaining in the plan body above (lines 15, 48) are **historical record of the 2026-06-04 state, not stale claims** — do not "fix" them.
