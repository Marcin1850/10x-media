---
bootstrapped_at: 2026-05-30T12:00:00Z
starter_id: 10x-astro-starter
starter_name: "10x Astro Starter (Astro + Supabase + Cloudflare)"
project_name: 10x-media
language_family: js
package_manager: npm
cwd_strategy: git-clone
bootstrapper_confidence: first-class
phase_3_status: ok
audit_command: "npm audit --json"
---

## Hand-off

```yaml
starter_id: 10x-astro-starter
package_manager: npm
project_name: 10x-media
hints:
  language_family: js
  team_size: solo
  deployment_target: cloudflare-pages
  ci_provider: github-actions
  ci_default_flow: auto-deploy-on-merge
  bootstrapper_confidence: first-class
  path_taken: standard
  quality_override: false
  self_check_answers: null
  has_auth: true
  has_payments: false
  has_realtime: false
  has_ai: true
  has_background_jobs: false
```

Solo developer shipping a YouTube video summary web app in 3 weeks of after-hours work with auth and AI/LLM integration. 10x Astro Starter is the recommended default for web-app in JS/TS and clears all four agent-friendly criteria: typed (TypeScript + Zod), convention-based (Astro file routing + island architecture), popular in training data, and well-documented. Auth and database come out of the box via Supabase; deployment lands on Cloudflare Pages (the starter's default). AI feature is a manual SDK addition — acknowledged during selection with the edge runtime gotcha addressed via Astro server routes. CI runs on GitHub Actions with auto-deploy on merge.

## Pre-scaffold verification

| Signal | Value | Severity | Notes |
| --- | --- | --- | --- |
| npm package | not run | — | cmd_template uses git clone, not an npm create CLI |
| GitHub repo | not run | — | gh CLI not installed; recency check unavailable |

## Scaffold log

**Resolved invocation**: `git clone https://github.com/przeprogramowani/10x-astro-starter .bootstrap-scaffold && cd .bootstrap-scaffold && npm install`
**Strategy**: git-clone
**Exit code**: 0
**Files moved**: 18 (7 directories: .github, .husky, .vscode, node_modules, public, src, supabase; 11 files: .env.example, .nvmrc, .prettierrc.json, astro.config.mjs, components.json, eslint.config.js, package-lock.json, package.json, README.md, tsconfig.json, wrangler.jsonc)
**Conflicts (.scaffold siblings)**: CLAUDE.md (existing preserved, scaffold copy at CLAUDE.md.scaffold)
**.gitignore handling**: append-merged (5 new entries: yarn-debug.log*, yarn-error.log*, pnpm-debug.log*, .env.production, .dev.vars)
**.bootstrap-scaffold cleanup**: deleted

## Post-scaffold audit

**Tool**: npm audit --json
**Summary**: 0 CRITICAL, 1 HIGH, 9 MODERATE, 0 LOW
**Direct vs transitive**: 0/0/2/0 direct of total 0/1/9/0

#### HIGH findings

- **devalue** 5.6.3–5.8.0: DoS via sparse array deserialization (GHSA-77vg-94rm-hx3p, CVSS 7.5). Transitive. Fix available.

#### MODERATE findings

- **@astrojs/check** (direct): transitive via @astrojs/language-server → volar-service-yaml. Fix: downgrade to 0.9.2 (semver major).
- **@astrojs/language-server**: via volar-service-yaml. Fix: downgrade @astrojs/check to 0.9.2.
- **@cloudflare/vite-plugin**: via miniflare, wrangler, ws. Fix available.
- **miniflare**: via ws. Fix available.
- **volar-service-yaml**: via yaml-language-server. Fix: downgrade @astrojs/check to 0.9.2.
- **wrangler** (direct): via miniflare. Fix available.
- **ws** 8.0.0–8.20.0: Uninitialized memory disclosure (GHSA-58qx-3vcg-4xpx, CVSS 4.4). Transitive. Fix available.
- **yaml** 2.0.0–2.8.2: Stack overflow via deeply nested YAML collections (GHSA-48c2-rrv3-qjmp, CVSS 4.3). Transitive. Fix via @astrojs/check 0.9.2.
- **yaml-language-server**: via yaml. Fix via @astrojs/check 0.9.2.

#### LOW / INFO findings

None.

## Hints recorded but not acted on

| Hint | Value |
| --- | --- |
| bootstrapper_confidence | first-class |
| quality_override | false |
| path_taken | standard |
| self_check_answers | null |
| team_size | solo |
| deployment_target | cloudflare-pages |
| ci_provider | github-actions |
| ci_default_flow | auto-deploy-on-merge |
| has_auth | true |
| has_payments | false |
| has_realtime | false |
| has_ai | true |
| has_background_jobs | false |

## Next steps

Next: a future skill will set up agent context (CLAUDE.md, AGENTS.md). For now, your project is scaffolded and verified — happy hacking.

Useful manual steps in the meantime:
- `git init` (if you have not already) to start your own repo history.
- Review any `.scaffold` siblings the conflict policy created and decide which version of each file to keep.
- Address audit findings per your project's risk tolerance — the full breakdown is in this log.
