import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { APIContext, AstroCookies } from "astro";
import { readJson } from "./__fixtures__/generation-harness";

/**
 * Stub layer for `PATCH /api/summaries/[id]` — the route's status table, every row of it, with no
 * database (S-14, plan Phase 2 §4). The pattern, and every reason behind it, is `delete.int.test.ts`'s:
 * a local loader that `vi.doUnmock`s before `vi.doMock`ing the two seams (`@/lib/supabase` and the
 * service), no env writes, no `fetch` stub. The `400` body variants, `503` and `500` cannot be provoked
 * against a healthy local stack, so this is the only place they are covered.
 *
 * Oracle: the plan's documented exit list — `401` · `400` (bad id or body) · `503` · `404` · `500`
 * (masked) · `200 { ok: true, worthWatching }` — and the body contract
 * `z.object({ worth_watching: z.boolean().nullable() }).strict()`, under which a missing key is a 400,
 * never a clear.
 *
 * **Mutation check** (2026-09-14, `--mutate "src/pages/api/summaries/[[]id].ts:101-144"`). Stryker's
 * configured entry point (`vitest.unit.config.ts`) cannot load this integration-project file, so the run
 * used a throwaway config including only this file plus `fetch-firewall.ts` (no `globalSetup` — nothing
 * here touches a database); the config was deleted afterwards, not committed. 48 mutants, 41 killed,
 * 7 survived, 0 not covered. Each survivor was put to the standing question — would it hurt a user or the
 * business? — and all seven are **ignored**:
 *
 * - The `error` text of the three 400 exits emptied or blanked (`:108`, `:115` ×2, `:120`). The island's
 *   `handleSetVerdict` reads only the status of a PATCH, never its body, and the English `error` never
 *   reaches the interface (README → Summary credits). Asserting prettified zod copy would pin log text.
 * - The JSON-parse `catch` emptied (`:114`). `rawBody` stays `undefined`, which the strict schema then
 *   refuses — still a 400 without reaching the service, so the observable contract holds; only the body
 *   text differs, as above.
 * - `{ status: 200 }` emptied (`:137`). `Response.json` defaults to 200: an equivalent mutant.
 * - The `console.error` marker blanked (`:141`). Log copy, not a contract (test-plan.md §6.1); that the
 *   500 exit logs at all is asserted.
 */

const SYNTHETIC_USER_ID = "00000000-0000-4000-8000-000000000001";
const SYNTHETIC_SUMMARY_ID = "00000000-0000-4000-8000-0000000000a1";

const MASKED_500_BODY = { error: "Something went wrong. Please try again." };

const NOOP_COOKIES = {
  get: () => undefined,
  set: () => undefined,
  delete: () => undefined,
  has: () => false,
} as unknown as AstroCookies;

interface LoadedEndpoint {
  PATCH: typeof import("./[id]").PATCH;
  setWorthWatching: ReturnType<typeof vi.fn>;
}

interface LoadOptions {
  supabase?: SupabaseClient | null;
  setWorthWatching?: ReturnType<typeof vi.fn>;
}

async function loadPatchEndpoint(options: LoadOptions = {}): Promise<LoadedEndpoint> {
  vi.resetModules();

  const supabase = options.supabase === undefined ? ({} as SupabaseClient) : options.supabase;
  const setWorthWatching = options.setWorthWatching ?? vi.fn().mockResolvedValue(true);

  vi.doUnmock("@/lib/supabase");
  vi.doUnmock("@/lib/services/summary-update");
  vi.doMock("@/lib/supabase", () => ({ createClient: () => supabase }));
  vi.doMock("@/lib/services/summary-update", () => ({ setWorthWatching }));

  const endpoint = await import("./[id]");
  return { PATCH: endpoint.PATCH, setWorthWatching };
}

/** `body` is sent verbatim, so an unparseable string is expressible alongside JSON. */
function makePatchContext(
  options: { user?: { id: string } | null; id?: string | undefined; body?: string } = {},
): APIContext {
  const user = "user" in options ? options.user : { id: SYNTHETIC_USER_ID };
  const id = "id" in options ? options.id : SYNTHETIC_SUMMARY_ID;
  const body = options.body ?? JSON.stringify({ worth_watching: true });
  return {
    locals: { user },
    params: { id },
    request: new Request(`http://localhost/api/summaries/${id ?? ""}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body,
    }),
    cookies: NOOP_COOKIES,
  } as unknown as APIContext;
}

let errorSpy: MockInstance;

beforeEach(() => {
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PATCH /api/summaries/[id] — every exit of the status table (S-14)", () => {
  it("401s with no session, before the id or body is looked at", async () => {
    const { PATCH, setWorthWatching } = await loadPatchEndpoint();

    const response = await PATCH(makePatchContext({ user: null, body: "not json" }));

    expect(response.status).toBe(401);
    await expect(readJson(response)).resolves.toEqual({ error: "Unauthorized" });
    expect(setWorthWatching).not.toHaveBeenCalled();
  });

  it("400s when the id is not a uuid, without reaching the service", async () => {
    const { PATCH, setWorthWatching } = await loadPatchEndpoint();

    const response = await PATCH(makePatchContext({ id: "not-a-uuid" }));

    expect(response.status).toBe(400);
    expect(setWorthWatching).not.toHaveBeenCalled();
  });

  it.each([
    // A missing key must not read as a clear: only an explicit `null` clears the mark.
    ["the worth_watching key is missing", "{}"],
    // A truthy string is not a verdict — coercion would turn a client bug into a stored mark.
    ["worth_watching is a string", JSON.stringify({ worth_watching: "yes" })],
    // `.strict()`: an extra key is how a client would try to smuggle `content` past the route.
    ["the body carries an extra key", JSON.stringify({ worth_watching: true, content: "forged" })],
    // Unparseable JSON is the client's fault, not a 500.
    ["the body is not valid JSON", "{ worth_watching: true"],
  ])("400s when %s, without reaching the service", async (_case, body) => {
    const { PATCH, setWorthWatching } = await loadPatchEndpoint();

    const response = await PATCH(makePatchContext({ body }));

    expect(response.status).toBe(400);
    expect(setWorthWatching).not.toHaveBeenCalled();
  });

  it("503s when Supabase is unconfigured, without reaching the service", async () => {
    const { PATCH, setWorthWatching } = await loadPatchEndpoint({ supabase: null });

    const response = await PATCH(makePatchContext());

    expect(response.status).toBe(503);
    await expect(readJson(response)).resolves.toEqual({ error: "Supabase is not configured" });
    expect(setWorthWatching).not.toHaveBeenCalled();
  });

  it("404s when the service reports that no row was updated", async () => {
    const setWorthWatching = vi.fn().mockResolvedValue(false);
    const { PATCH } = await loadPatchEndpoint({ setWorthWatching });

    const response = await PATCH(makePatchContext({ body: JSON.stringify({ worth_watching: false }) }));

    expect(response.status).toBe(404);
    await expect(readJson(response)).resolves.toEqual({ error: "Summary not found" });
    expect(setWorthWatching).toHaveBeenCalledWith(expect.anything(), SYNTHETIC_SUMMARY_ID, false);
  });

  it("500s with the masked body when the service throws, and logs", async () => {
    const setWorthWatching = vi
      .fn()
      .mockRejectedValue(new Error('Failed to update summary: permission denied for table "summaries"'));
    const { PATCH } = await loadPatchEndpoint({ setWorthWatching });

    const response = await PATCH(makePatchContext());

    expect(response.status).toBe(500);
    await expect(readJson(response)).resolves.toEqual(MASKED_500_BODY);
    expect(errorSpy).toHaveBeenCalled();
  });

  it.each([true, false, null])(
    "200s with { ok: true, worthWatching: %s } and passes it to the service",
    async (value) => {
      const setWorthWatching = vi.fn().mockResolvedValue(true);
      const { PATCH } = await loadPatchEndpoint({ setWorthWatching });

      const response = await PATCH(makePatchContext({ body: JSON.stringify({ worth_watching: value }) }));

      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toEqual({ ok: true, worthWatching: value });
      expect(setWorthWatching).toHaveBeenCalledWith(expect.anything(), SYNTHETIC_SUMMARY_ID, value);
    },
  );
});
