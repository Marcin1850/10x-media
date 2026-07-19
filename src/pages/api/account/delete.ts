import { z } from "zod";
import type { APIRoute } from "astro";
import { createClient } from "@/lib/supabase";
import { createAdminClient } from "@/lib/supabase-admin";

export const prerender = false;

const deleteSchema = z.object({
  confirmation: z.string(),
});

/**
 * Permanently delete the caller's own account and cascade all their data.
 *
 * Fail-safe ordering: delete the auth user FIRST; only on success do we tear
 * down the session. If the delete fails, the session is left intact so the
 * user can retry. The id comes from `context.locals.user.id` (server-resolved
 * from the session cookie), never from the request body, so a user can only
 * ever delete themselves even though the admin client bypasses RLS.
 *
 * The `confirmation` field must equal the session email: this enforces the
 * accidental-deletion guard at the only boundary capable of irreversible
 * deletion, rather than trusting the client-side dialog alone.
 */
export const POST: APIRoute = async (context) => {
  if (!context.locals.user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body: unknown = await context.request.json().catch(() => null);
  const parsed = deleteSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: z.prettifyError(parsed.error) }, { status: 400 });
  }
  if (parsed.data.confirmation !== context.locals.user.email) {
    return Response.json({ error: "Confirmation does not match your account email" }, { status: 400 });
  }

  const admin = createAdminClient();
  if (!admin) {
    return Response.json({ error: "Account deletion is not configured" }, { status: 503 });
  }

  // Mask any pre-delete failure behind a stable generic 500: a resolved
  // Supabase error and a rejected promise both funnel here, so the browser
  // never sees raw provider details (matches src/pages/api/summaries/generate.ts).
  try {
    const { error } = await admin.auth.admin.deleteUser(context.locals.user.id);
    if (error) throw error;
  } catch {
    return Response.json({ error: "Something went wrong. Your account was not deleted." }, { status: 500 });
  }

  // Best-effort session teardown. `deleteUser` already revoked the deleted
  // user's sessions, so `signOut()` may legitimately error — swallow it and
  // still report success. Stale cookies self-heal: middleware's `getUser()`
  // fails for a deleted user, so `locals.user` resolves to null next request.
  const supabase = createClient(context.request.headers, context.cookies);
  if (supabase) {
    await supabase.auth.signOut().catch(() => undefined);
  }

  return Response.json({ ok: true }, { status: 200 });
};
