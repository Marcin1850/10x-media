/**
 * Vendor `Response` factories for the stub layer (test-plan §6.1, layer 1; plan Phase 4).
 *
 * The seam is the global `fetch` — every Supadata call in this codebase (`transcript.ts`,
 * `metadata.ts`, `supadata-budget.ts`) goes through it directly, `@supadata/js` being a types-only
 * dependency now (research.md §7.5). `vi.stubGlobal("fetch", …)` in the consuming test resolves to
 * whichever factory the scenario needs; nothing here touches Vitest itself, mirroring
 * `supabase-stub.ts`'s convention of plain factories with no test-runner coupling beyond the
 * `Response` type.
 *
 * **Every factory's shape is a MEASUREMENT, not an assumption.** Each carries a comment citing the
 * value and the date it was recorded in
 * `context/changes/persist-time-and-cost/docs/supadata-billable-requests.md` — that file is the
 * fixture's authority, never the code that reads the response. Where the code's own defensive
 * contract (not a vendor measurement) is what's being exercised — a malformed header, an unusable
 * `/v1/me` figure — the comment says so and cites `supadata-ledger.ts` / `supadata-budget.ts` instead.
 */

const SUPADATA_JSON_HEADERS = { "content-type": "application/json" };

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...SUPADATA_JSON_HEADERS, ...headers } });
}

/**
 * `200` native transcript. §Measured 2026-07-29: `x-billable-requests: 1`, actually billed 1 — the
 * unremarkable case where the header and the bill agree, included so every fixture in this file has a
 * documented "billed as reported" baseline to contrast the others against.
 */
export function supadataTranscriptOk(
  overrides: Partial<{ content: string; lang: string; availableLangs: string[]; billableRequests: string }> = {},
): Response {
  const {
    content = "synthetic transcript content",
    lang = "en",
    availableLangs = ["en"],
    billableRequests = "1",
  } = overrides;
  return jsonResponse(200, { content, lang, availableLangs }, { "x-billable-requests": billableRequests });
}

/**
 * `206 transcript-unavailable` with NO `x-billable-requests` header — §Measured Finding 2, observed
 * three times across two videos, always absent, always billed 1 credit. `Response.ok` is true across
 * 200–299, so this reaches `fetchTranscript`'s success path and is classified `unavailable` on the
 * missing `content` field (`transcript.ts:369-372`), not through the thrown-error branch. This is the
 * fixture that makes `null` ≠ `0` load-bearing: the ledger records this call as `billable_credits:
 * null`, and reconciliation must not coerce that to a free call.
 */
export function supadataTranscriptUnavailable206(): Response {
  return jsonResponse(206, { error: "transcript-unavailable" });
}

/**
 * `524` gateway timeout, no body, no header. §Measured: the vendor's own docs state timed-out
 * requests still consume credits, so this cost is UNKNOWN, not zero — `readBillableCredits` returns
 * `null` (no header to read), which is the honest answer, distinct from the `206`'s "billed but
 * unreported" case: here the bill itself is unverifiable, not merely unreported.
 */
export function supadataGatewayTimeout524(): Response {
  return new Response(null, { status: 524 });
}

/**
 * A `2xx` whose `content-type` is not JSON. Every direct-`fetch` call site (`transcript.ts:197-207`,
 * `metadata.ts`) treats this as unreadable and synthesizes an `internal-error` `SupadataError` rather
 * than attempting `.json()` — this fixture exercises that branch, not a vendor measurement.
 */
export function supadataNonJsonContentType(status = 200): Response {
  return new Response("<html>not json</html>", { status, headers: { "content-type": "text/html" } });
}

/**
 * A `200` native transcript response with no `x-billable-requests` header at all — the "absent"
 * variant of the parsing contract in `supadata-ledger.ts` (`readBillableCredits` → `null` when
 * `response.headers.get(...)` is `null`), as opposed to the `206`'s vendor-measured absence above.
 */
export function supadataMissingBillableHeader(): Response {
  return jsonResponse(200, { content: "synthetic transcript content", lang: "en", availableLangs: ["en"] });
}

/**
 * A `200` native transcript response whose `x-billable-requests` header cannot be trusted as a
 * measurement. Each `kind` pins one branch of `readBillableCredits`'s contract
 * (`supadata-ledger.ts:199-214`, sourced from `supadata-billable-requests.md` §Parsing contract):
 *
 * - `"non-numeric"` — `"1oops"`: a `parseInt`-style prefix read would silently accept this as `1`,
 *   inventing a measurement the vendor did not send. The whole-string regex must reject it.
 * - `"fractional"` — `"1.5"`: same hazard, and the column is an `int4` besides.
 * - `"out-of-range"` — one past `2_147_483_647`, the `int4` ceiling `record_supadata_calls` casts
 *   into; an unrejected value here would fail the whole batch insert, discarding sibling rows.
 */
export function supadataMalformedBillableHeader(kind: "non-numeric" | "fractional" | "out-of-range"): Response {
  const value = { "non-numeric": "1oops", fractional: "1.5", "out-of-range": "2147483648" }[kind];
  return supadataTranscriptOk({ billableRequests: value });
}

/**
 * `200` metadata (`Metadata` shape from `@supadata/js`, read via `metadata.ts:97-204`). Not a
 * `billable-requests` measurement fixture — it exercises the shape `fetchVideoMetadata` narrows
 * (`media.type === "video"`, `additionalData.channelId`), so the header defaults to the same `1`
 * §Measured recorded for a metadata call.
 */
export function supadataMetadataOk(
  overrides: Partial<{
    title: string;
    channelName: string;
    channelId: string;
    durationSeconds: number;
    thumbnailUrl: string;
  }> = {},
): Response {
  const {
    title = "Synthetic video title",
    channelName = "Synthetic Channel",
    channelId = "UC_synthetic0000000000000",
    durationSeconds = 300,
    thumbnailUrl = "https://example.invalid/thumb.jpg",
  } = overrides;
  return jsonResponse(
    200,
    {
      platform: "youtube",
      type: "video",
      id: "synthetic-video-id",
      url: "https://www.youtube.com/watch?v=synthetic",
      title,
      description: null,
      author: { username: channelName, displayName: channelName, avatarUrl: "", verified: false },
      stats: { views: null, likes: null, comments: null, shares: null },
      media: {
        type: "video",
        url: "https://example.invalid/video.mp4",
        duration: durationSeconds,
        width: 1280,
        height: 720,
        thumbnailUrl,
      },
      tags: [],
      createdAt: new Date(0).toISOString(),
      additionalData: { channelId },
    },
    { "x-billable-requests": "1" },
  );
}

/**
 * `GET /v1/me`, well-formed — `{ organizationId, plan, maxCredits, usedCredits }`
 * (`supadata-account-limits.md`, read via `readVendorBudget` in `supadata-budget.ts`). Carries
 * no `x-billable-requests` header, matching the vendor's own documented free-endpoint status.
 */
export function supadataMeOk(
  overrides: Partial<{ organizationId: string; plan: string; maxCredits: number; usedCredits: number }> = {},
): Response {
  const { organizationId = "org-synthetic", plan = "free", maxCredits = 100, usedCredits = 18 } = overrides;
  return jsonResponse(200, { organizationId, plan, maxCredits, usedCredits });
}

/**
 * `GET /v1/me` in every shape `readVendorBudget` must fail open on (`readVendorBudget` in `supadata-budget.ts`),
 * never a vendor measurement — these are the code's own defensive contract, not an observed response:
 *
 * - `"negative"` — `usedCredits: -1`. `isCreditFigure` rejects it; a negative figure would invent
 *   budget in `max - used - outstanding`.
 * - `"fractional"` — `maxCredits: 100.5`. Not representable in the `integer` columns that store it.
 * - `"missing"` — `usedCredits` absent from the body entirely.
 * - `"not-ok"` — a non-2xx status (`503`), the vendor's own outage response.
 * - `"non-json"` — `2xx` with a non-JSON body, same shape as `supadataNonJsonContentType` but scoped
 *   to this endpoint for call-site clarity.
 */
export function supadataMeUnusable(kind: "negative" | "fractional" | "missing" | "not-ok" | "non-json"): Response {
  switch (kind) {
    case "negative":
      return jsonResponse(200, { organizationId: "org-synthetic", plan: "free", maxCredits: 100, usedCredits: -1 });
    case "fractional":
      return jsonResponse(200, { organizationId: "org-synthetic", plan: "free", maxCredits: 100.5, usedCredits: 18 });
    case "missing":
      return jsonResponse(200, { organizationId: "org-synthetic", plan: "free", maxCredits: 100 });
    case "not-ok":
      return jsonResponse(503, { error: "internal-error" });
    case "non-json":
      return supadataNonJsonContentType(200);
  }
}
