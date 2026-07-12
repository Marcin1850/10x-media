# Delete Account + All Data (GDPR) Implementation Plan

## Overview

Give an authenticated user a way to **permanently delete their account and all associated data**, satisfying the GDPR right to erasure (roadmap **S-04**, Linear **MAR-10**). A new protected `/account` page exposes a "Danger zone" delete control that opens a type-to-confirm modal. Confirming POSTs to a server endpoint that uses a **Supabase service-role admin client** to call `auth.admin.deleteUser(userId)` — which cascade-deletes every `videos`/`summaries` row via existing foreign keys — then tears down the user's session and redirects home with a confirmation notice.

## Current State Analysis

- **The data cascade already exists.** `public.videos.user_id` and `public.summaries.user_id` both declare `references auth.users (id) on delete cascade`, and `summaries` additionally cascades from `videos` via the composite FK (`supabase/migrations/20260613145120_videos_and_summaries.sql:5,36,41`). Deleting the `auth.users` row therefore purges all domain data automatically — the "no orphaned rows" care point is solved at the schema level.
- **The app has no way to delete the `auth.users` record.** Every Supabase client in the app is the **anon-key SSR client** (`src/lib/supabase.ts`), which is RLS/JWT-scoped and cannot delete an auth user. Deleting a user requires the **service-role key**, which is not configured anywhere: the env schema (`astro.config.mjs:17-24`) declares only `SUPABASE_URL`, `SUPABASE_KEY`, `SUPADATA_API_KEY`, `OPENROUTER_API_KEY`.
- **`@supabase/supabase-js` (^2.99.1) is a direct dependency** (`package.json`), so an admin client can be created directly — no new package needed.
- **API-route conventions** are established in `src/pages/api/summaries/probe.ts`: `export const prerender = false`, uppercase handler, `context.locals.user` auth guard returning 401, zod validation, `Response.json({...}, { status })`, and a `503` guard when a required secret is unconfigured.
- **Session teardown** pattern is in `src/pages/api/auth/signout.ts`: `supabase.auth.signOut()` then `context.redirect("/")`.
- **Route protection** is a simple prefix match against `PROTECTED_ROUTES` in `src/middleware.ts:4` (currently `["/dashboard"]`); `context.locals.user` is resolved there for every request.
- **The only authenticated page today** is `src/pages/dashboard.astro`, which hosts the sign-out form; there is no `/account` or settings page.
- **UI conventions:** interactive UI is built as hand-styled React islands matching the cosmic/glass theme (`src/components/auth/SignInForm.tsx`, `FormField.tsx`) — custom Tailwind, not raw shadcn dialogs. Only `button.tsx` from shadcn is installed (`src/components/ui/`). Hooks go in `src/components/hooks/` (currently empty). Classes merge via `cn()` (`@/lib/utils`).
- **S-05 (summary-credits) is not built yet** and runs parallel. No `credits` table exists; the plan must not depend on one. If credits later land on a table referencing `auth.users`, the same cascade covers it (noted, not built here).

## Desired End State

A signed-in user visits `/account`, sees a clearly-separated "Danger zone", clicks "Delete my account", types their email to unlock the confirm button, and confirms. Their `auth.users` row and all `videos`/`summaries` rows are gone, their session cookies are cleared, and they land on `/?deleted=1` with a brief "Your account and all data were deleted" notice. Attempting to sign in with the old credentials fails. Querying `videos`/`summaries` in Supabase Studio for that `user_id` returns zero rows.

### Key Discoveries:

- On-delete-cascade FKs make data purge automatic — `supabase/migrations/20260613145120_videos_and_summaries.sql:5,36,41`.
- Deleting an auth user needs the service-role key + `auth.admin.deleteUser` — the anon SSR client (`src/lib/supabase.ts`) cannot do it.
- Config-guard + auth-guard + zod pattern to copy — `src/pages/api/summaries/probe.ts:18-32`.
- Session teardown + redirect pattern — `src/pages/api/auth/signout.ts:4-10`.
- Protected-route registration — `src/middleware.ts:4`.

## What We're NOT Doing

- **No soft-delete / purge window / scheduler.** Deletion is immediate and irreversible (decision: hard delete). No Cloudflare Cron worker.
- **No password re-authentication step.** Type-to-confirm is the accidental-deletion guard; we do not re-verify the password server-side.
- **No dedicated settings hub beyond the single delete control.** `/account` hosts only the danger zone for now.
- **No credits handling.** S-05's table doesn't exist yet; cascade will cover it if/when it does.
- **No audit log / retention record** of deletions.
- **No admin-initiated deletion** — only the account owner deleting themselves.
- **No email confirmation of the deletion.**

## Implementation Approach

Two phases, backend-first so the destructive path is verifiable via API before any UI exists.

1. **Backend:** add the service-role secret to the env schema, add a small server-only admin-client factory, and build `POST /api/account/delete`. The endpoint guards on config (503) and auth (401), calls `auth.admin.deleteUser` with the caller's own id, and on success clears the session cookies. On any failure it leaves the account and session untouched (fail-safe) and returns an error status.
2. **Frontend:** register `/account` as protected, build the page shell + a type-to-confirm React island that POSTs to the endpoint and redirects to `/?deleted=1` on success, and render a one-off deleted notice on the home page. Link to `/account` from the dashboard.

## Critical Implementation Details

- **The admin client must be a standalone `@supabase/supabase-js` client, NOT the cookie-bound SSR client.** Create it with the service-role key and `auth: { autoRefreshToken: false, persistSession: false }` so it never reads or writes the user's session cookies. The service-role key bypasses RLS — it must only ever be referenced from `astro:env/server` inside server endpoints, never imported into any island or `.astro` frontmatter that reaches the client.
- **Delete the caller's own id only.** The id comes from `context.locals.user.id` (server-resolved from the session), never from request body — so a user can only ever delete themselves even though the admin client is omnipotent.
- **CSRF**: the endpoint is cookie-authenticated and reads no body — cross-site form POSTs are blocked by Astro's default `security.checkOrigin` (on by default in Astro 5+; `astro.config.mjs` must not disable it). No extra CSRF token needed.
- **Order: delete, then tear down the session.** Call `auth.admin.deleteUser` first; only if it succeeds, sign out / clear the auth cookies on the SSR client. If delete fails, do not sign out (fail-safe — the user keeps a valid session and can retry). **The fail-safe contract only applies before the delete**: once `deleteUser` succeeds, session teardown is best-effort — `signOut()` may legitimately error because the deleted user's sessions are already revoked; ignore/log that error and still report success. Stale cookies are harmless: middleware's `getUser()` fails for a deleted user, so `locals.user` resolves to `null` on the next request either way.

## Phase 1: Backend — service-role admin client + delete endpoint

### Overview

Add the service-role secret, a server-only admin-client factory, and the `POST /api/account/delete` endpoint that performs the irreversible deletion and session teardown. Verifiable end-to-end via an authenticated API call before any UI exists.

### Changes Required:

#### 1. Env schema — declare the service-role secret

**File**: `astro.config.mjs`

**Intent**: Make the service-role key available to server code via `astro:env/server`, consistent with the other secrets.

**Contract**: Add `SUPABASE_SERVICE_ROLE_KEY: envField.string({ context: "server", access: "secret", optional: true })` to the `env.schema` object (optional, mirroring the existing secrets so local/CI without it still builds).

#### 2. Env examples — document the new secret

**File**: `.env.example` (and note in README / `.dev.vars` guidance)

**Intent**: Signal that the key must be set locally and as a Workers Secret in deploy.

**Contract**: Add `SUPABASE_SERVICE_ROLE_KEY=###` line. (The real key is the `service_role` key from `npx supabase status` locally / Supabase dashboard → Settings → API in cloud; set via `npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY` for prod.)

#### 3. Admin-client factory

**File**: `src/lib/supabase-admin.ts` (new)

**Intent**: Provide a server-only Supabase client authenticated with the service-role key, isolated from the cookie-based SSR client so it can never leak into request/response session state.

**Contract**: Export `createAdminClient(): SupabaseClient | null` that reads `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` from `astro:env/server`, returns `null` if either is missing, and otherwise builds a client via `createClient` from `@supabase/supabase-js` with `auth: { autoRefreshToken: false, persistSession: false }`. No cookie wiring.

#### 4. Delete-account endpoint

**File**: `src/pages/api/account/delete.ts` (new)

**Intent**: Authenticated, fail-safe endpoint that permanently deletes the caller's account and cascades all their data, then clears their session.

**Contract**: `export const prerender = false;` + `export const POST: APIRoute`. Flow, in order:
1. Auth guard: if `!context.locals.user` → `401 { error: "Unauthorized" }`.
2. Config guard: `const admin = createAdminClient();` if `null` → `503 { error: "Account deletion is not configured" }` (session untouched).
3. `const { error } = await admin.auth.admin.deleteUser(context.locals.user.id);` — on error → `500 { error: ... }` (session untouched, fail-safe).
4. On success: clear the session via the SSR client (`createClient(...).auth.signOut()` — same as `signout.ts`) so the auth cookies are removed, then return `200 { ok: true }`. **Teardown is best-effort**: if `signOut()` errors (expected — `deleteUser` already revoked the sessions, so the JWT's user no longer exists), swallow the error and **always return `200 { ok: true }`** — the account is gone, and returning 5xx would make the UI claim a failed delete for a deleted account. Stale cookies self-heal via middleware (`getUser()` fails → `locals.user` = null).

No request body is read; the id is taken from `context.locals.user.id` only.

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npm run lint` (ESLint type-checked rules)
- Build passes: `npm run build`
- Prettier clean: `npm run format`

#### Manual Verification:

- With the service-role key set, an authenticated `POST /api/account/delete` returns `200 { ok: true }`, and the user can no longer sign in with the old credentials.
- Querying `public.videos` and `public.summaries` in Supabase Studio for that `user_id` returns zero rows.
- With the service-role key **unset**, the endpoint returns `503` and the account still exists (fail-safe).
- Hitting the endpoint while signed out returns `401`.

**Implementation Note**: After this phase and all automated verification passes, pause for manual confirmation (API-level delete + orphan check) before starting Phase 2. Phase blocks use plain bullets — checkbox state lives in `## Progress`.

---

## Phase 2: Frontend — `/account` page + confirm island + post-delete UX

### Overview

Expose the deletion behind a protected `/account` page with a type-to-confirm React island, wire the post-delete redirect, and show a one-off deleted notice on the home page. Link to `/account` from the dashboard.

### Changes Required:

#### 1. Protect the new route

**File**: `src/middleware.ts`

**Intent**: Require authentication for `/account`.

**Contract**: Add `"/account"` to the `PROTECTED_ROUTES` array (`src/middleware.ts:4`).

#### 2. Account page shell

**File**: `src/pages/account.astro` (new)

**Intent**: Authenticated page hosting a visually-separated "Danger zone" that mounts the delete island.

**Contract**: Uses `Layout`, matches the cosmic/glass styling of `dashboard.astro`. Reads `Astro.locals.user`. Renders a "Danger zone" section and mounts the delete island with `client:load`, passing the user's email as a prop (for the type-to-confirm target). Includes a link back to `/dashboard`.

#### 3. Delete-account confirmation island

**File**: `src/components/account/DeleteAccountDialog.tsx` (new)

**Intent**: A type-to-confirm modal that gates the irreversible action and calls the endpoint.

**Contract**: Props `{ email: string }`. A trigger button opens a modal (hand-styled to match the auth islands' glass theme, using `cn()` and the shadcn `button.tsx`; add shadcn `dialog` via `npx shadcn@latest add dialog` only if a custom modal isn't preferred). The confirm button stays disabled until the typed input exactly equals `email`. On confirm: `fetch("/api/account/delete", { method: "POST" })`; on `200` → `window.location.assign("/?deleted=1")`; on non-2xx → show the returned `error` message inline and keep the modal open (session intact, retryable). Disable controls while the request is in flight.

#### 4. Home-page deleted notice

**File**: `src/pages/index.astro`

**Intent**: Give the just-deleted user clear confirmation on landing.

**Contract**: When `Astro.url.searchParams.get("deleted") === "1"`, render a brief, dismissible-by-navigation banner ("Your account and all data were deleted"). Reuse the existing `Banner.astro` component if it fits; otherwise inline a small styled notice. Shown only for that one-off query param.

#### 5. Dashboard link to account

**File**: `src/pages/dashboard.astro`

**Intent**: Make `/account` discoverable from the only existing authenticated page.

**Contract**: Add a link/button to `/account` near the existing Sign-out form.

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npm run lint`
- Build passes: `npm run build`
- Prettier clean: `npm run format`

#### Manual Verification:

- Visiting `/account` while signed out redirects to `/auth/signin`.
- The confirm button is disabled until the typed value matches the account email; typing the wrong value keeps it disabled.
- End-to-end: seed data (generate a summary via the probe flow), then delete the account from `/account` → lands on `/?deleted=1` with the notice, old credentials fail to sign in, and `videos`/`summaries` for that `user_id` show zero rows in Supabase Studio.
- A failed delete (e.g. service-role key unset → 503) shows the inline error and leaves the user signed in and the account intact.
- No visual regressions on `/dashboard` or the home page; layout matches the cosmic theme.

**Implementation Note**: After this phase and all automated verification passes, pause for manual confirmation of the full end-to-end + orphan check before considering the slice done.

---

## Testing Strategy

### Unit Tests:

- No unit-test harness exists in the repo today; verification is via type-check/build/lint plus manual E2E. Do not introduce a test framework as part of this slice.

### Integration Tests:

- Covered by the manual E2E steps below (auth-guarded destructive endpoint + cascade behavior).

### Manual Testing Steps:

1. Set `SUPABASE_SERVICE_ROLE_KEY` locally (`.env` + `.dev.vars`) from `npx supabase status`.
2. Sign up / sign in a throwaway user; generate at least one summary via the probe flow so `videos`/`summaries` rows exist.
3. Go to `/account`, open the delete modal, confirm the button is disabled until the email is typed exactly.
4. Confirm deletion → verify redirect to `/?deleted=1` and the notice.
5. Try to sign in with the deleted user's credentials → must fail.
6. In Supabase Studio, query `public.videos` and `public.summaries` for the old `user_id` → expect zero rows.
7. Unset the service-role key, retry the delete on a fresh user → expect 503 + inline error + account still present.
8. Hit `/account` and `POST /api/account/delete` while signed out → redirect / 401 respectively.

## Performance Considerations

Negligible — a single admin API call plus a cookie clear per invocation; deletion is a rare, user-initiated action.

## Migration Notes

No schema migration required — the cascade FKs already exist. The only new infra is the `SUPABASE_SERVICE_ROLE_KEY` secret, which must be set as a **Cloudflare Workers Secret** (`npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY`) and as a GitHub repo secret if CI needs it for build (the field is optional, so build tolerates its absence). Guard the key as server-only; it bypasses RLS.

## References

- Cascade FKs: `supabase/migrations/20260613145120_videos_and_summaries.sql:5,36,41`
- API-route pattern (config/auth guard, zod, Response.json): `src/pages/api/summaries/probe.ts`
- Session teardown + redirect: `src/pages/api/auth/signout.ts`
- SSR anon client: `src/lib/supabase.ts`
- Protected-route registration: `src/middleware.ts:4`
- React island / glass-theme pattern: `src/components/auth/SignInForm.tsx`, `src/components/auth/FormField.tsx`
- Roadmap slice S-04: `context/foundation/roadmap.md:132-144`
- Change identity: `context/changes/delete-account/change.md`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Backend — service-role admin client + delete endpoint

#### Automated

- [x] 1.1 Type checking passes: `npm run lint` — 2ebeaaf
- [x] 1.2 Build passes: `npm run build` — 2ebeaaf
- [x] 1.3 Prettier clean: `npm run format` — 2ebeaaf

#### Manual

- [ ] 1.4 Authenticated `POST /api/account/delete` returns 200 and old credentials no longer sign in
- [ ] 1.5 `videos`/`summaries` rows for the deleted `user_id` are zero in Supabase Studio
- [ ] 1.6 Service-role key unset → endpoint returns 503, account still exists (fail-safe)
- [ ] 1.7 Signed-out request returns 401

### Phase 2: Frontend — `/account` page + confirm island + post-delete UX

#### Automated

- [x] 2.1 Type checking passes: `npm run lint`
- [x] 2.2 Build passes: `npm run build`
- [x] 2.3 Prettier clean: `npm run format`

#### Manual

- [ ] 2.4 `/account` while signed out redirects to `/auth/signin`
- [ ] 2.5 Confirm button disabled until typed value exactly matches the account email
- [ ] 2.6 End-to-end delete: redirect to `/?deleted=1` + notice, old login fails, zero orphaned rows
- [ ] 2.7 Failed delete (503) shows inline error, user stays signed in and account intact
- [ ] 2.8 No visual regressions on `/dashboard` and home; cosmic theme preserved
