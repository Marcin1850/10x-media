---
project: 10x-media
researched_at: 2026-06-02
recommended_platform: Cloudflare Workers
runner_up: Railway
context_type: mvp
tech_stack:
  language: TypeScript
  framework: Astro 6 (SSR) + React 19
  runtime: Cloudflare Workers (workerd)
---

## Recommendation

**Deploy on Cloudflare Workers.**

The 10x Astro Starter is already wired for Cloudflare Workers (`@astrojs/cloudflare` adapter, `wrangler.jsonc`, `npm run dev` on the workerd runtime), so this is the zero-friction target inside a 3-week after-hours deadline — no adapter swap, no deploy-config rewrite. It clears all five agent-friendly criteria (the only platform in the pool to do so), has the strongest agent tooling on the market (16 official MCP servers plus Claude Code skills for `wrangler`), and the core AI flow is I/O-bound — LLM and transcript calls are network time, which does **not** count against Workers CPU limits. The interview confirmed no co-located DB need (Supabase is external), single-region traffic, and no platform familiarity — all of which favor the platform with the best docs and agent integration.

> **Contract correction:** `tech-stack.md` records `deployment_target: cloudflare-pages`, but the Astro Cloudflare adapter **dropped Pages support in 2025**. Workers is now the only supported path, and the starter is already configured for it. The `cloudflare-pages` label in `tech-stack.md` is stale and should be updated to `cloudflare-workers`.

## Platform Comparison

Scored Pass / Partial / Fail against the five agent-friendly criteria, after applying hard filters (none disqualified on runtime — every platform can run Astro SSR via some adapter; the persistent-connection answer was "don't know", so no serverless-only platform was dropped, but the long-running AI request is weighted as a soft risk against tight free-tier timeouts).

| Platform | CLI-first | Managed/Serverless | Agent docs | Stable deploy API | MCP / Integration | Verdict |
|---|---|---|---|---|---|---|
| **Cloudflare Workers** | Pass | Pass | Pass | Pass | Pass | **5/5 — recommended** |
| **Railway** | Pass | Pass | Partial | Pass | Partial | Runner-up |
| **Vercel** | Pass | Pass | Pass | Pass | Partial | Third |
| Netlify | Pass | Pass | Pass | Pass | Pass | Not shortlisted (10s free timeout) |
| Fly.io | Pass | Partial | Pass | Pass | Fail | Not shortlisted (no free tier, Docker ops) |
| Render | Partial | Pass | Partial | Partial | Fail | Not shortlisted (free tier spins down) |

Per-platform notes:

- **Cloudflare Workers** — `wrangler` covers the full operational loop (deploy/rollback/tail/secrets). Docs publish `llms.txt` + markdown on GitHub. `wrangler deploy` is deterministic. 16 MCP servers (Workers, bindings, observability, docs) plus Claude Code's `wrangler` skill. Caveat: workerd is V8 isolates with partial Node compat (`nodejs_compat`) — a real runtime risk for transcript/LLM libraries (see cross-check).
- **Railway** — runs Astro SSR as a real Node.js process via `@astrojs/node`, so **no serverless timeout and no cold starts** — the safest home for a long LLM-generation request. `railway` CLI is solid. Docs are decent but not `llms.txt`-grade; no first-class MCP. No free tier (one-time ~$5 credit), and usage billing has no hard spending cap. Would require swapping the adapter away from Cloudflare.
- **Vercel** — top-tier CLI (`vercel --prod`), MDX docs on GitHub, Vercel MCP (beta). But the Hobby (free) plan **prohibits commercial use** and caps function duration at **10s** (risky for LLM calls); Pro is $20/mo. Requires an adapter swap.
- **Netlify** (not shortlisted) — strong on all five criteria incl. an official MCP server, but the free tier's **10s function timeout** is a poor fit for LLM generation, and SSR runs as Lambda-style functions with 800ms–1.5s cold starts.
- **Fly.io** (not shortlisted) — capable (`flyctl`, real VMs, multi-region) but **removed its free tier in 2024**, requires Docker/`fly.toml` ops surface (Partial on "managed"), no first-class MCP, and reports of bills running 2–4× expectations.
- **Render** (not shortlisted) — the free web-service tier **spins down after 15 min** (30–50s cold start); persistent SSR is $7/mo. CLI/deploy story is hook-based and less scriptable; no MCP.

### Shortlisted Platforms

#### 1. Cloudflare Workers (Recommended)

Won on three fronts at once: it's the **only 5/5** platform, it's the **starter's native target** (zero migration cost), and its **agent tooling is unmatched** (MCP fleet + Claude Code skills), which matters most precisely because the developer has no prior platform familiarity. The AI workload's I/O-bound shape means CPU limits are not the binding constraint they would be for a compute-heavy app.

#### 2. Railway

The strongest *alternative* because it fails differently from Cloudflare in the one place Cloudflare is weakest: it runs a **real Node.js process with no execution-time limit**, so any transcript/LLM dependency that breaks on workerd "just works." The gap vs. the recommendation: no free tier, usage-based billing with no hard cap, weaker agent-docs/MCP story, and an adapter swap (`@astrojs/cloudflare` → `@astrojs/node`). This is the platform to swap to if a workerd runtime incompatibility blocks the core feature.

#### 3. Vercel

Excellent developer experience, first-class CLI, and agent-readable MDX docs. It scores third because of two MVP-relevant blockers: the **Hobby plan forbids commercial use** (so any real launch needs $20/mo Pro) and the **10s free-tier function timeout** is a genuine risk for LLM summary generation. Also requires an adapter swap. Best when DX-on-serverless is the priority and the LLM call is reliably fast.

## Anti-Bias Cross-Check: Cloudflare Workers

### Devil's Advocate — Weaknesses

1. **workerd ≠ Node.** V8 isolates with `nodejs_compat` covering only a subset. A YouTube-transcript library or LLM SDK touching `node:fs`, native addons, or an unsupported `node:` builtin fails *at runtime*, not build time — a late surprise that eats a part-time budget.
2. **CPU-ms vs. the transcript.** The LLM call is I/O (fine), but synchronously parsing/tokenizing a long transcript and assembling the prompt burns CPU-ms; the free plan's 10ms cap is easily blown, forcing the $5 paid plan plus explicit extended-CPU config.
3. **Subrequest & fetch-concurrency limits.** Workers cap simultaneous subrequests and per-host fetch connections; the chained YouTube-fetch → LLM-call path can bump these under retry/error conditions.
4. **"Edge = fast" is false here.** Supabase lives in one region; a Worker at a far edge adds a round-trip per query. Fine for one EU user, but the mental model misleads if scale changes.
5. **Dev/prod fidelity gaps.** `npm run dev` on workerd catches most issues, but `compatibility_date`/flag drift means "works locally" ≠ "works deployed" for edge-specific behaviors.

### Pre-Mortem — How This Could Fail

The team picked Cloudflare because the starter defaulted to it. Week one, deploys are smooth. Week two, the core feature breaks: the chosen YouTube-transcript library works locally but returns empty on Workers — YouTube is rate-limiting Cloudflare's datacenter egress IPs, something that never reproduces on the dev machine's residential IP. The developer burns three after-hours evenings suspecting their own code before finding a community thread. They swap to a fetch-based scraping approach, which then trips `nodejs_compat` gaps and a subrequest limit under retries. Meanwhile a long transcript blows the free CPU budget, so they upgrade to paid and hand-configure extended CPU. Each fix is small, but the debugging loop on an unfamiliar runtime — with no prior Cloudflare experience — quietly consumes the slack in a 3-week part-time schedule. The deadline (2026-07-05) slips, not because Cloudflare is bad, but because the runtime's edge cases all landed on the single load-bearing feature, and every one had to be learned from scratch.

### Unknown Unknowns

- **YouTube blocks/rate-limits datacenter IPs.** Transcript fetching from Cloudflare's egress may fail in ways that never reproduce locally — a sleeper risk sitting directly on the core feature (FR-005).
- **The Pages→Workers shift is already in your docs.** `tech-stack.md` still says `cloudflare-pages`, a now-dead deploy path for the Astro adapter. The starter is correct; the contract is stale.
- **`npm run dev` already gives Workers fidelity** via the adapter's platformProxy — a separate `wrangler dev` step is legacy/redundant, contrary to many older tutorials.
- **Secrets are Workers Secrets, not `.env`.** Production reads `SUPABASE_URL`/`SUPABASE_KEY` via `astro:env/server`, set with `wrangler secret put`; `.env`/`.dev.vars` are local-only. Easy to misconfigure on first deploy.
- **`compatibility_date` + `nodejs_compat` interact.** Bumping the date can silently change runtime behavior; pin it deliberately.

## Operational Story

- **Preview deploys**: `wrangler versions upload` creates a preview deployment with its own URL without promoting to production; or wire the GitHub Actions Cloudflare Workers integration to build per-PR. Preview URLs are public by default — gate sensitive previews behind Cloudflare Access if needed. (Status: GA, checked 2026-06-02.)
- **Secrets**: production secrets are **Workers Secrets**, set with `npx wrangler secret put SUPABASE_URL` / `SUPABASE_KEY` (read in code via `astro:env/server`, declared in `astro.config.mjs`). Local dev reads `.dev.vars` (gitignored). CI build reads GitHub repo secrets `SUPABASE_URL`/`SUPABASE_KEY`. Rotation: `wrangler secret put` overwrites; the AI provider key (when added) follows the same path. Never commit secrets to `wrangler.jsonc`.
- **Rollback**: `npx wrangler rollback [<version-id>]` reverts to a prior deployed version, typically in seconds. List versions with `wrangler deployments list`. Caveat: rollback reverts the Worker only — Supabase schema migrations do **not** roll back automatically; reverse them with a down-migration.
- **Approval**: an agent may run `wrangler deploy` to ship and `wrangler rollback` to revert unattended. Human-only (panel-by-hand) actions: rotating the Supabase or AI provider primary key, deleting the Worker/project, and any Supabase destructive DB operation. Use a Cloudflare API token scoped to Workers for this one project — no DNS, no billing, no unrelated Workers Secrets.
- **Logs**: `npx wrangler tail` streams live runtime logs read-only; `observability.enabled: true` in `wrangler.jsonc` retains logs queryable via the Cloudflare observability MCP server (`observability.mcp.cloudflare.com/mcp`) for structured agent queries.

## Risk Register

| Risk | Source | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| YouTube rate-limits/blocks transcript fetches from Cloudflare datacenter IPs | Unknown unknowns | M | H | Spike the transcript-fetch path on a deployed Worker (not just locally). If blocked, route via a third-party transcript API or proxy. Build the FR-005 "no transcription" fallback the PRD already flags. **⏳ Probe deferred (status 2026-06-06): blocked on FR-005 — the transcript-fetch path is not implemented yet. The trigger is "when FR-005 lands", not a calendar week; run it on the deployed Worker the moment that feature exists.** |
| A transcript/LLM dependency uses unsupported `node:` APIs and fails on workerd at runtime | Devil's advocate / Pre-mortem | M | H | Validate the exact libraries on a deployed Worker early. Keep Railway (`@astrojs/node`) as the documented escape hatch — the swap is adapter-level only. |
| Long-transcript processing blows the free 10ms CPU budget | Devil's advocate | M | M | Move to the $5/mo Workers Paid plan and raise CPU limit (up to 5 min); keep heavy parsing minimal — push token-heavy work to the LLM, not the Worker. |
| Subrequest / per-host fetch concurrency limits hit under retries | Devil's advocate | L | M | Bound retries; sequence YouTube-fetch → LLM-call rather than fanning out; monitor via `wrangler tail`. |
| Unfamiliar-runtime debugging loop erodes the 3-week part-time slack | Pre-mortem | M | H | Front-load a thin end-to-end deploy (auth + one summary) in week 1 to surface runtime issues while slack exists; lean on Cloudflare MCP servers + Claude Code wrangler skill. |
| Stale `cloudflare-pages` target in `tech-stack.md` misleads a future deploy attempt | Unknown unknowns | M | L | Update `tech-stack.md` `deployment_target` to `cloudflare-workers`. Never deploy via the Pages flow. |
| Secrets misconfigured on first deploy (`.env` instead of Workers Secrets) | Unknown unknowns | M | M | Use `wrangler secret put` for production; verify with `wrangler secret list` before first prod hit. |
| `compatibility_date` bump silently changes runtime behavior | Unknown unknowns | L | M | Pin `compatibility_date` in `wrangler.jsonc`; change it deliberately and re-test after. |
| Edge-to-Supabase latency if user base grows beyond single EU user | Devil's advocate / Research finding | L | L | MVP-acceptable (one EU user). Revisit Smart Placement or a regional pin if multi-region users appear (out of MVP scope). |

## Getting Started

Validated against the starter's pinned versions (Astro 6, `@astrojs/cloudflare`, Wrangler) and the project's `astro:env`-based secret handling — not generic platform docs.

1. **Confirm the adapter is already present** (it is, in the starter): `@astrojs/cloudflare` in `package.json` and `wrangler.jsonc` at the repo root with `nodejs_compat` and a pinned `compatibility_date`. No `astro add` step needed.
2. **Develop with full Workers fidelity using the existing script**: `npm run dev` (already runs on the workerd runtime via the adapter's platformProxy). Do **not** add a separate `wrangler dev` step — it's redundant for this setup.
3. **Authenticate Wrangler once**: `npx wrangler login` (or set a scoped `CLOUDFLARE_API_TOKEN` env var in CI — Workers scope, this project only).
4. **Set production secrets** (not `.env`): `npx wrangler secret put SUPABASE_URL` then `npx wrangler secret put SUPABASE_KEY`. Add the AI provider key the same way when the AI SDK lands.
5. **Build and deploy**: `npm run build` then `npx wrangler deploy`. Verify with `npx wrangler tail` and a live request, then confirm rollback works with `npx wrangler deployments list`.
6. **End-to-end probe (gated on feature work, not a calendar week)**: the auth slice (sign-in/sign-up) is already deployed and verified. The transcript/summary half — which is what actually flushes the YouTube-IP and `nodejs_compat` risks — depends on FR-005, which is not implemented yet. Run that probe on the deployed Worker **as soon as FR-005 lands**, while schedule slack still exists. (Originally framed as "week 1"; corrected 2026-06-06 — the trigger is the feature existing, not the date.)

## Out of Scope

The following were not evaluated in this research:
- Docker image configuration
- CI/CD pipeline setup (the starter ships a GitHub Actions lint+build workflow; deploy automation is a separate step)
- Production-scale architecture (multi-region, HA, DR)
