import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { APIContext, AstroCookies } from "astro";
import { readJson } from "./__fixtures__/generation-harness";

/**
 * Stub layer for `DELETE /api/summaries/[id]` — the route's status table, every row of it, with no
 * database (plan Phase 2 item 1; S-03).
 *
 * Phase 1's unit test covers `deleteSummary` itself; nothing covered the handler's translation of that
 * service into a response. Three of its six exits — `400`, `503`, `500` — are unreachable from the
 * real-stack suite by construction: a malformed id, an unconfigured Supabase, and a thrown service
 * call cannot be provoked against a healthy local stack. Until this file they were manual-only.
 *
 * **Follows `generation-harness.ts`'s discipline but cannot reuse the harness itself** (research.md
 * §4): its `makeContext` has no `params` support and hard-codes `method: "POST"` and the generate URL,
 * and its `loadEndpoint` returns `typeof import("@/pages/api/summaries/generate")` and unconditionally
 * mocks `llm.ts`. The loader and context helper below are therefore local, copying the ordering the
 * harness documents at `:343-344`: `vi.resetModules()` → **`vi.doUnmock` first, every time** (mock
 * factories outlive `resetModules()`; only the module cache is cleared) → `vi.doMock` the two seams →
 * dynamic `import()`.
 *
 * **The harness's "set env" step is deliberately absent, and its absence is the point.** Both of this
 * route's module-scope imports that could read configuration — `@/lib/supabase` and
 * `@/lib/services/summary-delete` — are replaced here, so the endpoint under test reads no
 * `astro:env/server` key at all and a `process.env` write would be inert ceremony. The `503` is
 * provoked at the seam that actually produces it in production: `createClient` returning `null`.
 * The file still belongs to the integration project, because the route reaches `astro:env/server`
 * transitively through `@/lib/supabase`, which only that project aliases (`CLAUDE.md` → Testing).
 * It needs no Docker.
 *
 * **No `fetch` stub.** Nothing paid is on this path — no transcript, no LLM, no ledger. The
 * `fetch-firewall.ts` default installed by the integration project's `setupFiles` stands unmodified.
 *
 * Oracle: the endpoint's own documented exit list (`[id].ts`) as settled by plan Phase 1, and
 * `account/delete.ts`'s established masking pattern — not read off the handler under test.
 */

/** Synthetic throughout — no real account identifier ever reaches a committed file (`lessons.md`). */
const SYNTHETIC_USER_ID = "00000000-0000-4000-8000-000000000001";
const SYNTHETIC_SUMMARY_ID = "00000000-0000-4000-8000-0000000000a1";

/** The stable copy the 500 exit ships. Asserted by its own shape, never as "not the provider message". */
const MASKED_500_BODY = { error: "Something went wrong. Please try again." };

/** `createClient` writes refreshed session cookies through this; nothing here reads them back. */
const NOOP_COOKIES = {
  get: () => undefined,
  set: () => undefined,
  delete: () => undefined,
  has: () => false,
} as unknown as AstroCookies;

interface LoadedEndpoint {
  DELETE: typeof import("./[id]").DELETE;
  /** The `vi.fn()` standing in for `deleteSummary` — asserted as "never called" on the pre-service exits. */
  deleteSummary: ReturnType<typeof vi.fn>;
}

interface LoadOptions {
  /** `null` is the unconfigured-Supabase case; omitted yields an inert stand-in the service never uses. */
  supabase?: SupabaseClient | null;
  deleteSummary?: ReturnType<typeof vi.fn>;
}

async function loadDeleteEndpoint(options: LoadOptions = {}): Promise<LoadedEndpoint> {
  vi.resetModules();

  const supabase = options.supabase === undefined ? ({} as SupabaseClient) : options.supabase;
  const deleteSummary = options.deleteSummary ?? vi.fn().mockResolvedValue(true);

  // Unmock first, every time: `doMock` registrations survive `resetModules()`, so a previous test's
  // factory would otherwise keep standing in for a call that meant to register a different one.
  vi.doUnmock("@/lib/supabase");
  vi.doUnmock("@/lib/services/summary-delete");
  vi.doMock("@/lib/supabase", () => ({ createClient: () => supabase }));
  vi.doMock("@/lib/services/summary-delete", () => ({ deleteSummary }));

  const endpoint = await import("./[id]");
  return { DELETE: endpoint.DELETE, deleteSummary };
}

/**
 * An `APIContext` for the first dynamic route in `src/pages/api/`. Supplies `locals.user` **and**
 * `params.id` — the pair the harness's own `makeContext` cannot express. `id: undefined` is the
 * genuine shape Astro hands a handler when the segment resolves to nothing, not a stand-in for it.
 */
function makeDeleteContext(options: { user?: { id: string } | null; id?: string | undefined } = {}): APIContext {
  const user = "user" in options ? options.user : { id: SYNTHETIC_USER_ID };
  const id = "id" in options ? options.id : SYNTHETIC_SUMMARY_ID;
  return {
    locals: { user },
    params: { id },
    request: new Request(`http://localhost/api/summaries/${id ?? ""}`, { method: "DELETE" }),
    cookies: NOOP_COOKIES,
  } as unknown as APIContext;
}

/** Held rather than reached for through `console.error`, which the repo's `no-console` rule flags. */
let errorSpy: MockInstance;

beforeEach(() => {
  // Keeps a green run readable — the 500 exit logs by design. Only *that it was called* is ever
  // asserted, never its text: test-plan.md §6.1, "do not assert the marker strings — they are log
  // copy, not a contract any consumer reads."
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("DELETE /api/summaries/[id] — every exit of the status table (S-03)", () => {
  it("401s with no session, before the id is even looked at", async () => {
    const { DELETE, deleteSummary } = await loadDeleteEndpoint();

    const response = await DELETE(makeDeleteContext({ user: null }));

    expect(response.status).toBe(401);
    await expect(readJson(response)).resolves.toEqual({ error: "Unauthorized" });
    expect(
      deleteSummary,
      "An unauthenticated request reached the delete service. The session check is the first exit for " +
        "a reason: nothing about the request may touch the database before the caller is known.",
    ).not.toHaveBeenCalled();
  });

  it.each([
    ["absent from the route params", undefined, "✖ Invalid input: expected string, received undefined"],
    ["present but not a uuid", "not-a-uuid", "✖ Invalid UUID"],
  ])("400s when the id is %s, without reaching the service", async (_case, id, message) => {
    const { DELETE, deleteSummary } = await loadDeleteEndpoint();

    const response = await DELETE(makeDeleteContext({ id }));

    expect(response.status).toBe(400);
    await expect(readJson(response)).resolves.toEqual({ error: message });
    expect(
      deleteSummary,
      "An unvalidated id reached the delete service — and therefore PostgREST. `context.params.id` " +
        "arrives as `string | undefined` on this, the repo's first dynamic API route, so the zod parse " +
        "is what stands between a malformed segment and the query builder.",
    ).not.toHaveBeenCalled();
  });

  it("503s when Supabase is unconfigured, without reaching the service", async () => {
    const { DELETE, deleteSummary } = await loadDeleteEndpoint({ supabase: null });

    const response = await DELETE(makeDeleteContext());

    expect(response.status).toBe(503);
    await expect(readJson(response)).resolves.toEqual({ error: "Supabase is not configured" });
    expect(
      deleteSummary,
      "The service was called with a null client. `createClient` returns null when SUPABASE_URL or " +
        "SUPABASE_KEY is unset — a deploy missing a Worker secret — and the endpoint must answer 503 " +
        "rather than hand `null` to the service and surface the crash as a 500.",
    ).not.toHaveBeenCalled();
  });

  it("404s when the service reports that no row was deleted", async () => {
    const deleteSummary = vi.fn().mockResolvedValue(false);
    const { DELETE } = await loadDeleteEndpoint({ deleteSummary });

    const response = await DELETE(makeDeleteContext());

    expect(response.status).toBe(404);
    await expect(readJson(response)).resolves.toEqual({ error: "Summary not found" });
    expect(
      deleteSummary,
      "The validated id is what must reach the service — a 404 produced without asking the database " +
        "about the right row would be indistinguishable here from the contract.",
    ).toHaveBeenCalledWith(expect.anything(), SYNTHETIC_SUMMARY_ID);
  });

  it("500s with the masked body when the service throws, and logs", async () => {
    const deleteSummary = vi
      .fn()
      .mockRejectedValue(new Error('Failed to delete summary: permission denied for table "summaries"'));
    const { DELETE } = await loadDeleteEndpoint({ deleteSummary });

    const response = await DELETE(makeDeleteContext());

    expect(response.status).toBe(500);
    await expect(
      readJson(response),
      "The 500 body is not the stable masked copy. It is asserted by its own shape rather than as " +
        "'does not contain the provider message', so a future body leaking a *different* Supabase " +
        "detail still fails here — matching account/delete.ts and generate.ts's masking pattern.",
    ).resolves.toEqual(MASKED_500_BODY);
    expect(
      errorSpy,
      "Nothing was logged. This exit is by design the only one with no diagnostic surface in the " +
        "response, so without the log a production failure is invisible.",
    ).toHaveBeenCalled();
  });

  it("200s with { ok: true } when exactly one row was deleted", async () => {
    const deleteSummary = vi.fn().mockResolvedValue(true);
    const { DELETE } = await loadDeleteEndpoint({ deleteSummary });

    const response = await DELETE(makeDeleteContext());

    expect(response.status).toBe(200);
    await expect(readJson(response)).resolves.toEqual({ ok: true });
    expect(deleteSummary).toHaveBeenCalledWith(expect.anything(), SYNTHETIC_SUMMARY_ID);
  });
});
