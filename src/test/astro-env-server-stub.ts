/**
 * Stand-in for the `astro:env/server` virtual module, which only exists inside an Astro build.
 * `vitest.config.ts` aliases the virtual specifier to this file so endpoint modules that import it
 * (`generate.ts`, `supabase.ts`, `supabase-admin.ts`, `config-status.ts`) resolve outside Astro.
 *
 * Values are read at module scope — not lazily inside a getter — because that is how the real
 * `astro:env/server` behaves: it inlines the values once at import time. A test that wants a
 * different value must set `process.env` before importing the module under test, matching how the
 * real module cannot be reconfigured after Astro has built it either.
 */
export const SUPABASE_URL = process.env.SUPABASE_URL;
export const SUPABASE_KEY = process.env.SUPABASE_KEY;
export const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
export const SUPADATA_API_KEY = process.env.SUPADATA_API_KEY;
export const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
