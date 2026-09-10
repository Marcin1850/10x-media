import { createTransport, withSentry, type ErrorEvent } from "@sentry/cloudflare";
import { describe, expect, it } from "vitest";
import { sentryWorkerSink } from "@/lib/services/reporting-sink.server";
import { scrubRequestData, sentryWorkerOptions, type SentryWorkerEnv } from "@/lib/services/sentry-worker-options";

/**
 * The Worker's privacy boundary, asserted on the SERIALIZED ENVELOPE (impl-review F1).
 *
 * Oracle: decision D8 and the README's Error monitoring section — no cookies, no request bodies — plus
 * the reporting seam's no-identifiers rule. Request credentials (a sign-in password, an `Authorization`
 * header, a session cookie, the auth callback's `?code=`) must reach Sentry nowhere. Nothing below is
 * read off the implementation: each sentinel is a value this app really receives, and the assertion is
 * that it is absent from the bytes the transport would put on the wire.
 *
 * **Why this file does NOT follow `reporting.test.ts`'s "the sink is the seam" rule.** That rule is right
 * for the seam's own contract. This file tests the opposite boundary — what the SDK ADDS around an
 * app-owned payload — and the promotion tests, which inspect only `contexts.report.payload`, passed
 * green while the surrounding request leaked. Only the real `withSentry` pipeline, with a recording
 * transport in place of the network, can see that.
 *
 * Deliberate breaks, both seen red (2026-09-10):
 *
 *  - `integrations` and `beforeSend` removed from `sentryWorkerOptions` — both envelope cases fail; the
 *    sign-in case names the password, the email, the callback code and the fragment.
 *  - `scrubRequestData` reduced to a no-op, integrations kept — both envelope cases still leak the
 *    callback code and fragment (`RequestData` always attaches the full URL), and the scrubber case
 *    fails. So the `beforeSend` layer is load-bearing on its own, not merely defence in depth.
 *
 * **Mutation check** (`npx stryker run --mutate "src/lib/services/sentry-worker-options.ts:56-128"`,
 * 2026-09-10): first run 17 killed / 30 survived / 0 uncovered. One class answered YES to "would this
 * hurt a user or the business?": `withoutQueryOrFragment`'s `cut === -1` (→ `+1`, → `false`) cut the last
 * character off every query-free URL — the shape most routes have — because every probe URL carried a
 * query. "keeps a URL with no query or fragment whole" now kills both. **Re-run: 19 killed / 28 survived
 * / 0 uncovered.** No other assertion was added to raise the number.
 *
 * Ignored, with the reason:
 *
 * 1. **Layer redundancy (17)** — the `integrations` array emptied; `httpServerIntegration({})` or
 *    `maxRequestBodySize: ""` (which captures up to 1 MB); `requestDataIntegration({})`, `include: {}` or
 *    any `include` flag flipped; `dataCollection: {}`; and `userInfo`, `cookies`, `httpBodies`,
 *    `httpHeaders`, `urlQueryParams` flipped. Each weakens ONE layer while another still holds — usually
 *    `beforeSend` — so no sentinel reaches the envelope. That is the defence-in-depth design, not a gap;
 *    the module header says which layer holds what. Proving a layer holds alone would need its own
 *    isolation case, deliberately not added.
 * 2. **Inert on this runtime (8)** — `genAI` ×3, `graphQL` ×3, `databaseQueryData`,
 *    `stackFrameVariables`. `@sentry/cloudflare`'s default integrations include no AI, GraphQL,
 *    database-client or local-variables integration, so nothing reads these today; they are
 *    future-proofing. Pinning them would snapshot the config, recomputing the expected value the way the
 *    code does.
 * 3. **Equivalent (2)** — `environment: ""` (`@sentry/core`'s `prepareEvent` falls back from an empty
 *    string to `"production"`), and `if (method !== undefined)` → `if (true)` (an `undefined` method is
 *    dropped by JSON serialization, so the envelope is byte-identical).
 * 4. **Unreachable (1)** — `if (url !== undefined)` → `if (true)` would throw inside `beforeSend`, which
 *    makes core drop the event. The Cloudflare wrapper always sets `url` from `request.url`, and an event
 *    with no request skips the block, so no event on this runtime has a request without a URL. Revisit
 *    if a non-fetch handler ever attaches request data.
 *
 * `reporting.ts`'s `describePayload` (`:214-220`, same runs): 4 killed / 0 survived.
 */

/**
 * Local shapes for the probe handler and its execution context. The Workers runtime's global
 * `ExportedHandler` / `ExecutionContext` types are not visible from `src/`, and the three members below
 * are all `withSentry` touches.
 */
interface ProbeContext {
  waitUntil: (promise: Promise<unknown>) => void;
  passThroughOnException: () => void;
  props: Record<string, never>;
}
interface ProbeWorker {
  fetch: (request: Request, env: SentryWorkerEnv, context: ProbeContext) => Response;
}

const SENTINEL = {
  password: "SENTINEL-PASSWORD-7f3a",
  email: "sentinel-body-5b1e@example.test",
  authorization: "SENTINEL-BEARER-91c2",
  cookie: "SENTINEL-SESSION-COOKIE-3d8e",
  code: "SENTINEL-CALLBACK-CODE-44de",
  fragment: "SENTINEL-FRAGMENT-0a9b",
  ip: "203.0.113.77",
} as const;

/**
 * Loopback and unroutable. The recording transport below replaces the network entirely; the DSN only
 * has to be present so the SDK initialises at all.
 */
const PROBE_ENV: SentryWorkerEnv = { SENTRY_DSN: "http://public@127.0.0.1:9/1" };

function credentialHeaders(extra: Record<string, string> = {}): Headers {
  return new Headers({
    authorization: `Bearer ${SENTINEL.authorization}`,
    cookie: `sb-access-token=${SENTINEL.cookie}`,
    "x-forwarded-for": SENTINEL.ip,
    "cf-connecting-ip": SENTINEL.ip,
    ...extra,
  });
}

/** Runs one request through the real `withSentry` pipeline and returns every envelope it sent. */
async function envelopesFor(request: Request, fetch: () => Response): Promise<string[]> {
  const envelopes: string[] = [];
  const pending: Promise<unknown>[] = [];
  const worker = withSentry<SentryWorkerEnv, unknown, unknown, ProbeWorker>(
    (env) => ({
      ...sentryWorkerOptions(env),
      transport: (transportOptions) =>
        createTransport(transportOptions, (outgoing) => {
          envelopes.push(typeof outgoing.body === "string" ? outgoing.body : new TextDecoder().decode(outgoing.body));
          return Promise.resolve({ statusCode: 200 });
        }),
    }),
    { fetch },
  );
  const context: ProbeContext = {
    waitUntil: (promise) => {
      pending.push(promise);
    },
    passThroughOnException: () => undefined,
    props: {},
  };

  // The unhandled-exception case rethrows by design; the envelope, not the response, is under test.
  await Promise.resolve()
    .then(() => worker.fetch(request, PROBE_ENV, context))
    .catch(() => undefined);
  await Promise.all(pending);
  return envelopes;
}

const cases = [
  {
    name: "an app event emitted through the Worker sink during a sign-in POST",
    request: () =>
      new Request(`https://10xmedia.test/api/auth/signin?code=${SENTINEL.code}#${SENTINEL.fragment}`, {
        method: "POST",
        headers: credentialHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ email: SENTINEL.email, password: SENTINEL.password }),
      }),
    path: "/api/auth/signin",
    marker: "[privacy-probe:app-event]",
    fetch: () => {
      sentryWorkerSink({
        message: "[privacy-probe:app-event] error",
        level: "error",
        fingerprint: ["[privacy-probe:app-event]", "error"],
        context: { key: "[privacy-probe:app-event]", severity: "error", payload: { stage: "probe" } },
      });
      return new Response("ok");
    },
  },
  {
    name: "an unhandled exception during the auth callback",
    request: () =>
      new Request(`https://10xmedia.test/auth/callback?code=${SENTINEL.code}#${SENTINEL.fragment}`, {
        method: "GET",
        headers: credentialHeaders(),
      }),
    path: "/auth/callback",
    marker: "privacy probe: unhandled failure",
    fetch: (): Response => {
      throw new Error("privacy probe: unhandled failure");
    },
  },
];

describe("the Worker's Sentry envelope carries no request credentials", () => {
  it.each(cases)("$name", async ({ request, fetch, path, marker }) => {
    const probe = request();
    // The probe really carries its secrets — otherwise their absence below would prove nothing.
    expect(probe.url).toContain(SENTINEL.code);
    expect(probe.headers.get("authorization")).toContain(SENTINEL.authorization);
    expect(probe.headers.get("cookie")).toContain(SENTINEL.cookie);

    const sent = (await envelopesFor(probe, fetch)).join("\n");

    // Two-sided: the event did reach the transport, with the route an operator needs...
    expect(sent).toContain(marker);
    expect(sent).toContain(path);
    // ...and not one sentinel came with it. Filtered rather than looped, so a failure names every leak.
    expect(Object.values(SENTINEL).filter((value) => sent.includes(value))).toEqual([]);
  });
});

describe("scrubRequestData", () => {
  it("keeps only the method and the URL without its query or fragment", () => {
    const event: ErrorEvent = {
      type: undefined,
      request: {
        method: "POST",
        url: `https://10xmedia.test/auth/callback?code=${SENTINEL.code}#${SENTINEL.fragment}`,
        query_string: `code=${SENTINEL.code}`,
        data: JSON.stringify({ password: SENTINEL.password }),
        headers: { authorization: `Bearer ${SENTINEL.authorization}` },
        cookies: { "sb-access-token": SENTINEL.cookie },
      },
    };

    expect(scrubRequestData(event).request).toEqual({ method: "POST", url: "https://10xmedia.test/auth/callback" });
  });

  it("keeps a URL with no query or fragment whole", () => {
    // Most routes carry no query, so this is the URL shape nearly every event has. An off-by-one in the
    // cut would report `/api/summaries/generate` as `/api/summaries/generat` on all of them.
    const event: ErrorEvent = {
      type: undefined,
      request: { method: "POST", url: "https://10xmedia.test/api/summaries/generate" },
    };

    expect(scrubRequestData(event).request).toEqual({
      method: "POST",
      url: "https://10xmedia.test/api/summaries/generate",
    });
  });

  it("does not invent request data on an event that has none", () => {
    expect(scrubRequestData({ type: undefined, message: "no request" })).not.toHaveProperty("request");
  });
});
