import { vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { APIContext, AstroCookies } from "astro";

/**
 * Shared stub-layer harness for the generation endpoint's integration tests (plan Phase 4).
 *
 * Every test in this rollout mocks the SAME three seams research.md §2.4 identified — the two client
 * constructors and `llm.ts` — plus the global `fetch` for Supadata traffic. Three test files
 * (`generate.int.test.ts`, `supadata-budget.int.test.ts`, `supadata-ledger.int.test.ts`) all drive the
 * endpoint through that seam, so the mocking boilerplate lives here once rather than three times.
 *
 * **No database.** `admin.rpc` and `supabase.from(...)` are scripted in-memory; nothing here opens a
 * connection, matching Phase 4's "no test in this layer opens a database connection" criterion.
 */

// ---------------------------------------------------------------------------------------------------
// astro:env/server — the endpoint reads its five keys at MODULE SCOPE (astro-env-server-stub.ts), so a
// test that wants different keys present must set `process.env` and reload the module via
// `vi.resetModules()`. `loadEndpoint` below does both together.
// ---------------------------------------------------------------------------------------------------

const ENV_KEYS = [
  "SUPABASE_URL",
  "SUPABASE_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPADATA_API_KEY",
  "OPENROUTER_API_KEY",
] as const;

type EnvKey = (typeof ENV_KEYS)[number];

/** Present by default so a test only has to name the ONE key it wants missing or different. */
const DEFAULT_ENV: Record<EnvKey, string> = {
  SUPABASE_URL: "http://127.0.0.1:54321",
  SUPABASE_KEY: "synthetic-anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "synthetic-service-role-key",
  SUPADATA_API_KEY: "synthetic-supadata-key",
  OPENROUTER_API_KEY: "synthetic-openrouter-key",
};

/** `null` unsets the key entirely; omitted keys fall back to `DEFAULT_ENV`. */
export type EnvOverrides = Partial<Record<EnvKey, string | null>>;

function setEnv(overrides: EnvOverrides = {}): void {
  for (const key of ENV_KEYS) {
    const value = key in overrides ? overrides[key] : DEFAULT_ENV[key];
    if (value === null || value === undefined) {
      Reflect.deleteProperty(process.env, key);
    } else {
      process.env[key] = value;
    }
  }
}

// ---------------------------------------------------------------------------------------------------
// The scripted admin.rpc fake. One queue per RPC name; each call shifts the next scripted response and
// throws loudly if the test forgot to script one — a missing script must fail the test, not silently
// resolve `undefined` and produce a confusing downstream assertion failure.
// ---------------------------------------------------------------------------------------------------

export interface RpcResult {
  data: unknown;
  error: { message: string } | null;
}

export type RpcHandler = RpcResult | ((params: Record<string, unknown> | undefined) => RpcResult);

export interface RpcCall {
  fn: string;
  params: Record<string, unknown> | undefined;
}

export interface FakeAdmin {
  client: SupabaseClient;
  calls: RpcCall[];
  /** Appends more scripted responses for one RPC name, e.g. to extend a default script. */
  queue: (fn: string, ...handlers: RpcHandler[]) => void;
  /** All calls recorded against one RPC name, in order — for asserting exact payloads. */
  callsTo: (fn: string) => RpcCall[];
}

export function ok(data: unknown): RpcResult {
  return { data, error: null };
}

export function fail(message: string): RpcResult {
  return { data: null, error: { message } };
}

export function createFakeAdmin(script: Record<string, RpcHandler[]> = {}): FakeAdmin {
  const calls: RpcCall[] = [];
  const queues = new Map<string, RpcHandler[]>(Object.entries(script).map(([fn, handlers]) => [fn, [...handlers]]));

  const rpc = vi.fn((fn: string, params?: Record<string, unknown>) => {
    calls.push({ fn, params });
    const queue = queues.get(fn);
    if (!queue || queue.length === 0) {
      const seen = calls.filter((call) => call.fn === fn).length;
      throw new Error(`generation-harness: no scripted admin.rpc response for "${fn}" (call #${seen})`);
    }
    const handler = queue.shift();
    return typeof handler === "function" ? handler(params) : handler;
  });

  return {
    client: { rpc } as unknown as SupabaseClient,
    calls,
    queue(fn, ...handlers) {
      queues.set(fn, [...(queues.get(fn) ?? []), ...handlers]);
    },
    callsTo(fn) {
      return calls.filter((call) => call.fn === fn);
    },
  };
}

/**
 * The RPCs every full generation touches that are NOT the point of a given test — the lease, the rate
 * limiter, budget settlement, cache writes, and the ledger flush. A test overrides only the RPC(s) its
 * scenario is actually about; everything else proceeds down the ordinary path.
 */
export function defaultAdminScript(): Record<string, RpcHandler[]> {
  return {
    acquire_generation_lease: [ok("lease-synthetic")],
    release_generation_lease: [ok(true)],
    record_transcript_attempt: [ok(true)],
    // At most one settle per checkpoint (transcript, metadata) in a single request — 2 covers a full run.
    settle_supadata_reservation: [ok(true), ok(true)],
    save_transcript_cache: [ok(false)],
    save_metadata_cache: [ok(null)],
    record_supadata_calls: [ok(null)],
    // Empty array => a cache MISS (getCachedTranscript/getCachedMetadata read `data.length === 0` as null).
    get_transcript_cache: [ok([])],
    get_metadata_cache: [ok([])],
    get_transcript_quote: [ok([])],
    save_transcript_quote: [ok(null)],
    discard_transcript_quote: [ok(null)],
    reserve_supadata_credits: [
      ok([reserveRow({ reservation_id: "budget-res-transcript" })]),
      ok([reserveRow({ reservation_id: "budget-res-metadata" })]),
    ],
  };
}

/** One `begin_generation` row, defaulted to all-null so a test states only what it is about. */
export function beginRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    outcome: "fresh",
    reservation_id: null,
    new_balance: null,
    summary_id: null,
    video_id: null,
    content: null,
    model: null,
    cost: null,
    ...overrides,
  };
}

/** One `reserve_supadata_credits` row. */
export function reserveRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    outcome: "reserved",
    reservation_id: "budget-res-synthetic",
    max_credits: 100,
    used_credits: 10,
    outstanding: 0,
    read_at: new Date(0).toISOString(),
    refresh_claim_id: null,
    ...overrides,
  };
}

/** One `persist_summary` row. */
export function persistRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    outcome: "persisted",
    video_id: "synthetic-video-id",
    summary_id: "synthetic-summary-id",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------------------------------
// The fake RLS-scoped supabase client — the ONE thing `getBalance` reads outside the admin client.
// ---------------------------------------------------------------------------------------------------

export function createFakeSupabase(balance: number | null): SupabaseClient {
  const maybeSingle = vi.fn().mockResolvedValue({ data: balance === null ? null : { balance }, error: null });
  const eq = vi.fn(() => ({ maybeSingle }));
  const select = vi.fn(() => ({ eq, maybeSingle }));
  const from = vi.fn(() => ({ select }));
  return { from } as unknown as SupabaseClient;
}

// ---------------------------------------------------------------------------------------------------
// The global fetch fake for Supadata traffic — routed by pathname, exactly the three real endpoints
// (`fetchTranscript`, `fetchVideoMetadata`, `readVendorBudget`) can reach.
// ---------------------------------------------------------------------------------------------------

export type ResponseSource = (() => Response) | (() => Response)[];

function nextFrom(source: ResponseSource | undefined, label: string): () => Response {
  if (!source) {
    return () => {
      throw new Error(`stubSupadataFetch: no ${label} handler scripted for this call`);
    };
  }
  if (typeof source === "function") return source;
  let index = 0;
  return () => {
    const handler = source[Math.min(index, source.length - 1)];
    index += 1;
    return handler();
  };
}

export function stubSupadataFetch(
  handlers: { transcript?: ResponseSource; metadata?: ResponseSource; me?: ResponseSource } = {},
): ReturnType<typeof vi.fn> {
  const transcript = nextFrom(handlers.transcript, "transcript");
  const metadata = nextFrom(handlers.metadata, "metadata");
  const me = nextFrom(handlers.me, "/v1/me");

  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const { pathname } = new URL(rawUrl);

    if (pathname === "/v1/transcript") return Promise.resolve(transcript());
    if (pathname === "/v1/metadata") return Promise.resolve(metadata());
    if (pathname === "/v1/me") return Promise.resolve(me());
    return Promise.reject(new Error(`stubSupadataFetch: unexpected fetch to ${rawUrl}`));
  });

  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

// ---------------------------------------------------------------------------------------------------
// The synthetic APIContext and request body.
// ---------------------------------------------------------------------------------------------------

export const SYNTHETIC_USER_ID = "00000000-0000-4000-8000-000000000001";
export const SYNTHETIC_REQUEST_ID = "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed";
export const SYNTHETIC_YOUTUBE_URL = "https://www.youtube.com/watch?v=synthetic01";

export function generateRequestBody(
  overrides: Partial<{ url: string; character: string; allowLong: boolean; requestId: string | null }> = {},
): Record<string, unknown> {
  const { requestId = SYNTHETIC_REQUEST_ID, ...rest } = overrides;
  const body: Record<string, unknown> = {
    url: SYNTHETIC_YOUTUBE_URL,
    character: "informational",
    ...rest,
  };
  if (requestId !== null) body.requestId = requestId;
  return body;
}

export function makeContext(
  options: {
    user?: { id: string } | null;
    body?: unknown;
    rawBody?: string;
    headers?: Record<string, string>;
  } = {},
): APIContext {
  const { user = { id: SYNTHETIC_USER_ID }, body, rawBody, headers = {} } = options;
  const requestBody = rawBody ?? (body === undefined ? undefined : JSON.stringify(body));
  return {
    locals: { user },
    request: new Request("http://localhost/api/summaries/generate", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: requestBody,
    }),
    cookies: {} as AstroCookies,
  } as unknown as APIContext;
}

// ---------------------------------------------------------------------------------------------------
// Loading the endpoint under a fresh module registry, with the three seams mocked.
// ---------------------------------------------------------------------------------------------------

export function defaultSummarizeResult(): {
  text: string;
  model: string;
  costUsd: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
} {
  return {
    text: "# Synthetic summary\n\n- one point worth knowing",
    model: "anthropic/claude-sonnet-5",
    costUsd: 0.01,
    promptTokens: 100,
    completionTokens: 50,
  };
}

export interface LoadEndpointOptions {
  env?: EnvOverrides;
  admin?: SupabaseClient | null;
  supabase?: SupabaseClient | null;
  /** A `vi.fn()` standing in for `summarize`. Defaults to one resolving `defaultSummarizeResult()`. */
  summarize?: ReturnType<typeof vi.fn>;
  /**
   * A `vi.fn()` standing in for `fetchTranscript` itself, bypassing the HTTP fake entirely. The ONLY
   * legitimate use is the transient `failed`/`timeout` transcript outcome (research.md §3): under
   * `TRANSCRIPT_MODE = 'native'` those reasons are produced solely by the Whisper job-poll path, which
   * test-plan §7 excludes as unreachable — so the one way to exercise generate.ts's OWN handling of
   * that reason (422, `charged: false`, no cache write) is to hand it the reason directly. Every other
   * transcript scenario goes through `stubSupadataFetch` against the real `transcript.ts`.
   */
  fetchTranscript?: ReturnType<typeof vi.fn>;
}

/**
 * Resets the module registry, sets `process.env`, registers the mocked seams, and re-imports the
 * endpoint fresh — so its `astro:env/server` read and its `createClient`/`createAdminClient`/`summarize`
 * bindings all pick up THIS call's configuration rather than a previous test's.
 */
export async function loadEndpoint(
  options: LoadEndpointOptions = {},
): Promise<typeof import("@/pages/api/summaries/generate")> {
  vi.resetModules();
  setEnv(options.env);

  const admin = options.admin ?? null;
  const supabase = options.supabase ?? null;
  const summarize = options.summarize ?? vi.fn().mockResolvedValue(defaultSummarizeResult());

  vi.doMock("@/lib/supabase-admin", () => ({ createAdminClient: () => admin }));
  vi.doMock("@/lib/supabase", () => ({ createClient: () => supabase }));
  vi.doMock("@/lib/services/llm", () => ({ summarize }));
  if (options.fetchTranscript) {
    const fetchTranscript = options.fetchTranscript;
    vi.doMock("@/lib/services/transcript", () => ({ fetchTranscript, TRANSCRIPT_REQUESTED_LANG: "en" }));
  }

  return import("@/pages/api/summaries/generate");
}

export async function readJson(response: Response): Promise<unknown> {
  return response.json();
}
