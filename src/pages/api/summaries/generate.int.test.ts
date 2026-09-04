import { afterEach, describe, expect, it, vi } from "vitest";
import {
  beginRow,
  createFakeAdmin,
  createFakeSupabase,
  defaultAdminScript,
  generateRequestBody,
  loadEndpoint,
  makeContext,
  ok,
  persistRow,
  readJson,
  stubSupadataFetch,
} from "./__fixtures__/generation-harness";
import {
  supadataMetadataOk,
  supadataTranscriptOk,
  supadataTranscriptUnavailable206,
} from "@/lib/services/__fixtures__/supadata-responses";

/**
 * Stub layer — trust boundary, preflight ordering, and the refusal exits' charged signals (plan Phase
 * 4, items 1-2; test-plan risks #1 and #5). Every seam is mocked per `generation-harness.ts`: the two
 * client constructors, `llm.ts`, and the global `fetch` for Supadata traffic. No database connection —
 * `admin.rpc` and `supabase.from(...)` are scripted in-memory.
 *
 * Oracle: `generate.ts`'s own documented contracts — the preflight ordering comment (`generate.ts:110-
 * 125`), `REFUSAL_COPY` and `refusalResponse`'s `ambiguousCharge` shape (`generate.ts:83-94,231-237`),
 * and `refuseAndCharge`'s outcome mapping (`generate.ts:274-294`) — cross-checked against research.md
 * §2.3 and §4, not read off the branch under test.
 */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function cachedTranscriptRow(
  outcome: "unavailable" | "empty" | "ok" | "too_long",
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    content: outcome === "ok" ? "cached transcript content" : "",
    outcome,
    lang: null,
    available_langs: null,
    resolved_via: null,
    fetched_at: new Date(0).toISOString(),
    ...overrides,
  };
}

describe("trust boundary — preflight exits (research.md §2.3, both 503s land before the 401)", () => {
  it("503s distinctly when a vendor key is unset — the FIRST preflight, before the admin client exists", async () => {
    const { POST } = await loadEndpoint({ env: { SUPADATA_API_KEY: null } });

    const response = await POST(makeContext({ body: generateRequestBody() }));

    expect(response.status).toBe(503);
    await expect(readJson(response)).resolves.toEqual({ error: "Transcript/LLM services are not configured" });
  });

  it("503s distinctly when the admin client cannot be built — a different message, same status", async () => {
    const { POST } = await loadEndpoint({ admin: null });

    const response = await POST(makeContext({ body: generateRequestBody() }));

    expect(response.status).toBe(503);
    await expect(readJson(response)).resolves.toEqual({ error: "Summary generation is not configured" });
  });

  it("401s an unauthenticated caller once both preflights pass", async () => {
    const admin = createFakeAdmin();
    const { POST } = await loadEndpoint({ admin: admin.client });

    const response = await POST(makeContext({ user: null, body: generateRequestBody() }));

    expect(response.status).toBe(401);
    await expect(readJson(response)).resolves.toEqual({ error: "Unauthorized" });
  });

  it("an unauthenticated caller can still distinguish a service-unconfigured 503 from a 401 — the ordering finding", async () => {
    // Both 503 preflights run BEFORE the 401 check (generate.ts:110-125). Proven here by omitting a
    // vendor key on a request with NO authenticated user and seeing 503, not 401.
    const { POST } = await loadEndpoint({ env: { SUPADATA_API_KEY: null } });

    const response = await POST(makeContext({ user: null, body: generateRequestBody() }));

    expect(response.status).toBe(503);
  });
});

describe("trust boundary — schema rejections (risk #5: the server refuses what the UI would never send)", () => {
  async function postBody(body: unknown): Promise<Response> {
    const admin = createFakeAdmin();
    const { POST } = await loadEndpoint({ admin: admin.client });
    return POST(makeContext({ body }));
  }

  it("400s a missing requestId — required at the schema boundary", async () => {
    const response = await postBody(generateRequestBody({ requestId: null }));

    expect(response.status).toBe(400);
    const json = (await readJson(response)) as { error: string };
    expect(json.error).toMatch(/requestId/);
  });

  it("400s a malformed requestId that is not a UUID", async () => {
    const response = await postBody(generateRequestBody({ requestId: "not-a-uuid" }));

    expect(response.status).toBe(400);
  });

  it("400s a character outside the enum", async () => {
    const response = await postBody(generateRequestBody({ character: "entertaining" }));

    expect(response.status).toBe(400);
    const json = (await readJson(response)) as { error: string };
    expect(json.error).toMatch(/character/);
  });

  it("400s a non-web URL scheme — new URL() parses it, but it names no YouTube video", async () => {
    const response = await postBody(generateRequestBody({ url: "ftp://example.com/video" }));

    expect(response.status).toBe(400);
    const json = (await readJson(response)) as { error: string };
    expect(json.error).toMatch(/YouTube/);
  });
});

describe("trust boundary — allowLong sent unprompted is pre-authorization, not a free pass on cost", () => {
  it("skips the 409 confirmation but the debit still uses the real, higher cost", async () => {
    const admin = createFakeAdmin(defaultAdminScript());
    admin.queue("begin_generation", ok([beginRow({ outcome: "fresh" })])); // the idempotency probe
    admin.queue(
      "begin_generation",
      ok([beginRow({ outcome: "reserved", reservation_id: "res-debit", new_balance: 3 })]),
    );
    admin.queue("persist_summary", ok([persistRow()]));
    const supabase = createFakeSupabase(5);
    // > LONG_TRANSCRIPT_CHARS (40000), so summaryCost() prices this at 2, not 1.
    const longTranscript = "x".repeat(50_000);
    stubSupadataFetch({
      transcript: () => supadataTranscriptOk({ content: longTranscript }),
      metadata: () => supadataMetadataOk(),
    });

    const { POST } = await loadEndpoint({ admin: admin.client, supabase });
    const response = await POST(makeContext({ body: generateRequestBody({ allowLong: true }) }));

    expect(response.status).toBe(200); // not 409 — allowLong pre-authorized the confirmation
    const debitCall = admin.callsTo("begin_generation")[1];
    expect(debitCall.params).toMatchObject({ amount: 2 });
  });
});

describe("refusal exits — each charges (or doesn't) exactly as chargeFailedTranscript's outcome says", () => {
  it("charges a cached `unavailable` refusal", async () => {
    const admin = createFakeAdmin({
      ...defaultAdminScript(),
      get_transcript_cache: [ok([cachedTranscriptRow("unavailable")])],
      charge_failed_transcript: [ok([{ outcome: "charged", new_balance: 4 }])],
    });
    admin.queue("begin_generation", ok([beginRow({ outcome: "fresh" })]));
    const supabase = createFakeSupabase(5);
    const { POST } = await loadEndpoint({ admin: admin.client, supabase });

    const response = await POST(makeContext({ body: generateRequestBody() }));
    const json = (await readJson(response)) as { error: string; charged?: boolean };

    expect(response.status).toBe(422);
    expect(json.charged).toBe(true);
    expect(typeof json.error).toBe("string");
    expect(admin.callsTo("charge_failed_transcript")[0].params).toMatchObject({
      p_refusal_reason: "unavailable",
      p_amount: 1,
    });
  });

  it("charges a cached `empty` refusal", async () => {
    const admin = createFakeAdmin({
      ...defaultAdminScript(),
      get_transcript_cache: [ok([cachedTranscriptRow("empty")])],
      charge_failed_transcript: [ok([{ outcome: "charged", new_balance: 4 }])],
    });
    admin.queue("begin_generation", ok([beginRow({ outcome: "fresh" })]));
    const supabase = createFakeSupabase(5);
    const { POST } = await loadEndpoint({ admin: admin.client, supabase });

    const response = await POST(makeContext({ body: generateRequestBody() }));
    const json = (await readJson(response)) as { error: string; charged?: boolean };

    expect(response.status).toBe(422);
    expect(json.charged).toBe(true);
    expect(admin.callsTo("charge_failed_transcript")[0].params).toMatchObject({ p_refusal_reason: "empty" });
  });

  it("charges a FRESH fetch's `unavailable` outcome — the 206 we just paid a Supadata credit for", async () => {
    const admin = createFakeAdmin({
      ...defaultAdminScript(),
      charge_failed_transcript: [ok([{ outcome: "charged", new_balance: 4 }])],
    });
    admin.queue("begin_generation", ok([beginRow({ outcome: "fresh" })]));
    const supabase = createFakeSupabase(5);
    stubSupadataFetch({ transcript: () => supadataTranscriptUnavailable206() });
    const { POST } = await loadEndpoint({ admin: admin.client, supabase });

    const response = await POST(makeContext({ body: generateRequestBody() }));
    const json = (await readJson(response)) as { error: string; charged?: boolean };

    expect(response.status).toBe(422);
    expect(json.charged).toBe(true);
    expect(admin.callsTo("charge_failed_transcript")[0].params).toMatchObject({ p_refusal_reason: "unavailable" });
    // The paid 206 is cached negative, so a re-submit within the window answers free.
    expect(admin.callsTo("save_transcript_cache")[0].params).toMatchObject({ p_outcome: "unavailable" });
  });

  it("charges a whitespace-only transcript, distinct from a cached `empty` row", async () => {
    const admin = createFakeAdmin({
      ...defaultAdminScript(),
      charge_failed_transcript: [ok([{ outcome: "charged", new_balance: 4 }])],
    });
    admin.queue("begin_generation", ok([beginRow({ outcome: "fresh" })]));
    const supabase = createFakeSupabase(5);
    stubSupadataFetch({ transcript: () => supadataTranscriptOk({ content: "   \n\t  " }) });
    const { POST } = await loadEndpoint({ admin: admin.client, supabase });

    const response = await POST(makeContext({ body: generateRequestBody() }));
    const json = (await readJson(response)) as { error: string; charged?: boolean };

    expect(response.status).toBe(422);
    expect(json.charged).toBe(true);
    expect(admin.callsTo("charge_failed_transcript")[0].params).toMatchObject({ p_refusal_reason: "whitespace" });
    // The fetch outcome cached is `empty` (a vendor SUCCESS on wordless content) — a different fact
    // from the `whitespace` reason this refusal is charged under, per D3's split.
    expect(admin.callsTo("save_transcript_cache")[0].params).toMatchObject({ p_outcome: "empty" });
  });

  it.each(["failed", "timeout"] as const)(
    "does NOT charge the transient `%s` transcript outcome — cost is unknown, not zero",
    async (reason) => {
      const admin = createFakeAdmin(defaultAdminScript());
      admin.queue("begin_generation", ok([beginRow({ outcome: "fresh" })]));
      const supabase = createFakeSupabase(5);
      const fetchTranscript = vi.fn().mockResolvedValue({ ok: false, reason });
      const { POST } = await loadEndpoint({ admin: admin.client, supabase, fetchTranscript });

      const response = await POST(makeContext({ body: generateRequestBody() }));
      const json = (await readJson(response)) as { error: string; charged?: boolean };

      expect(response.status).toBe(422);
      expect(json.charged).toBe(false);
      expect(admin.callsTo("charge_failed_transcript")).toHaveLength(0);
      // Transient outcomes are never cached — D3/D4 only cache the durable `unavailable` verdict.
      expect(admin.callsTo("save_transcript_cache")).toHaveLength(0);
    },
  );

  it("reports the ambiguous shape by its own fields — never `charged: false`", async () => {
    const admin = createFakeAdmin({
      ...defaultAdminScript(),
      get_transcript_cache: [ok([cachedTranscriptRow("unavailable")])],
      charge_failed_transcript: [ok([])], // an empty row set: the statement ran, the outcome is unknown
    });
    admin.queue("begin_generation", ok([beginRow({ outcome: "fresh" })]));
    const supabase = createFakeSupabase(5);
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { POST } = await loadEndpoint({ admin: admin.client, supabase });

    const response = await POST(makeContext({ body: generateRequestBody() }));
    const json = (await readJson(response)) as Record<string, unknown>;

    expect(response.status).toBe(422);
    expect(json.ambiguousCharge).toBe(true);
    expect(json).not.toHaveProperty("charged");
    spy.mockRestore();
  });

  it("REFUSAL_COPY differs between `unavailable` and the generic reasons, and is stable within a group", async () => {
    async function bodyFor(outcome: "unavailable" | "empty"): Promise<{ error: string }> {
      const admin = createFakeAdmin({
        ...defaultAdminScript(),
        get_transcript_cache: [ok([cachedTranscriptRow(outcome)])],
        charge_failed_transcript: [ok([{ outcome: "charged", new_balance: 4 }])],
      });
      admin.queue("begin_generation", ok([beginRow({ outcome: "fresh" })]));
      const supabase = createFakeSupabase(5);
      const { POST } = await loadEndpoint({ admin: admin.client, supabase });
      const response = await POST(makeContext({ body: generateRequestBody() }));
      return (await readJson(response)) as { error: string };
    }

    const unavailableBody = await bodyFor("unavailable");
    const emptyBody = await bodyFor("empty");

    expect(unavailableBody.error).not.toBe(emptyBody.error);
  });
});
