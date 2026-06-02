---
starter_id: 10x-astro-starter
package_manager: npm
project_name: 10x-media
hints:
  language_family: js
  team_size: solo
  deployment_target: cloudflare-workers
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
---

## Why this stack

Solo developer shipping a YouTube video summary web app in 3 weeks of after-hours work with auth and AI/LLM integration. 10x Astro Starter is the recommended default for web-app in JS/TS and clears all four agent-friendly criteria: typed (TypeScript + Zod), convention-based (Astro file routing + island architecture), popular in training data, and well-documented. Auth and database come out of the box via Supabase; deployment lands on Cloudflare Workers (the starter's default; the Astro Cloudflare adapter dropped Pages support in 2025). AI feature is a manual SDK addition — acknowledged during selection with the edge runtime gotcha addressed via Astro server routes. CI runs on GitHub Actions with auto-deploy on merge.
