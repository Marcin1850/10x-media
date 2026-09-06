import { z } from "zod";
import type { APIRoute } from "astro";
import { createClient } from "@/lib/supabase";
import { deleteSummary } from "@/lib/services/summary-delete";

export const prerender = false;

const idSchema = z.uuid();

/**
 * Permanently delete one of the caller's own summaries (S-03).
 *
 * RLS-scoped: the anon SSR client is used deliberately, **never** `createAdminClient`. The
 * owner-scoped `summaries_delete_authenticated` policy (`20260613145120_videos_and_summaries.sql:61-63`)
 * is the enforcement point, so an admin client would bypass the very thing that makes this safe.
 * The service passes no `user_id` filter for the same reason.
 *
 * **No confirmation field, deliberately.** `account/delete.ts` re-checks the session email because
 * that action erases every row the user owns and the echoed value is independent proof of intent.
 * Here the only value a client could echo back is the summary id it just sent, so a `confirm: true`
 * flag would be ceremony a mistaken request satisfies as easily as a deliberate one. Intent is
 * captured by the card's inline two-step control; the trust boundary is the policy, which no client
 * input can widen. Blast radius is one row the user can regenerate.
 *
 * **CSRF** is covered by Astro's default `security.checkOrigin` — this route is authenticated purely
 * by session cookies and reads no body, the same shape `delete-account` relies on. Do not disable it.
 *
 * **Zero rows deleted answers `404`, not `500` — and that is a decision, not a convention.** There is
 * no prior art in this repo for 404-vs-500 on a zero-row mutation, so the reasoning lives here: under
 * RLS "not yours" and "already gone" are the same observation, so `404` leaks nothing that a
 * `200` would not. The client must treat it as *the row is gone* and keep its optimistic removal —
 * only a 5xx, a 401 or a network failure means the summary still exists.
 *
 * Exits, in order: `401` unauthenticated · `400` missing/malformed id · `503` Supabase unconfigured ·
 * `404` zero rows · `500` the delete failed (masked) · `200 { ok: true }` one row deleted.
 */
export const DELETE: APIRoute = async (context) => {
  if (!context.locals.user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  // First dynamic route in `src/pages/api/` — `context.params.id` arrives as `string | undefined`,
  // so it is validated before it ever reaches PostgREST.
  const parsed = idSchema.safeParse(context.params.id);
  if (!parsed.success) {
    return Response.json({ error: z.prettifyError(parsed.error) }, { status: 400 });
  }

  const supabase = createClient(context.request.headers, context.cookies);
  if (!supabase) {
    return Response.json({ error: "Supabase is not configured" }, { status: 503 });
  }

  try {
    // createClient returns supabase-js's default untyped client (no generated Database types yet), so
    // passing it where the service expects its explicit shapes is an unavoidable `any` gap — same as
    // the GET route's listSummaries call.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    const deleted = await deleteSummary(supabase, parsed.data);
    if (!deleted) {
      return Response.json({ error: "Summary not found" }, { status: 404 });
    }
    return Response.json({ ok: true }, { status: 200 });
  } catch (error) {
    // Mask the provider's message behind a stable generic 500, matching generate.ts and
    // account/delete.ts — the browser never sees raw Supabase details. This exit is by design the
    // only one with no diagnostic surface, so without the log a production failure is invisible.
    // eslint-disable-next-line no-console
    console.error("DELETE /api/summaries/[id] failed:", error);
    return Response.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
};
