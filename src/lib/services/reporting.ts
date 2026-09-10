/**
 * The one swappable notification point (decision #2). Error-monitoring tools treat console output
 * as a breadcrumb attached to OTHER events, so scattered `console.warn` calls may never become an
 * alert on their own — this is the single seam a real receiver plugs into.
 *
 * Since S-13 the receiver exists: every event forwarded here also reaches Sentry, on whichever
 * runtime it was emitted from. Two exports, one transport:
 *
 *  - `captureEvent` — SINK ONLY. Forwards, writes nothing to the console. This is what a site that
 *    already logs its own `console.*` line calls, so promoting it to Sentry does not double its
 *    console output.
 *  - `reportEvent` — the original: both console branches, unchanged, and then `captureEvent`.
 *
 * Severity rule is fixed: `warn` goes to `console.warn` / Sentry `warning`, everything else to
 * `console.error` / Sentry `error`. Callers pass their own severity vocabulary (e.g.
 * `supadata-budget`'s `stop` / `warn` / `untracked`) rather than being narrowed to this module's
 * cases. The mapping is written once, here, so the console and the receiver can never disagree.
 *
 * PERSONAL DATA. The seam's default is NO user identifiers in a payload, and every family not named
 * below keeps it — `[supadata-budget]`, `[unsupported-feature]` and `[paid-path:*]` carry the failing
 * stage, figure or detail, never the account. So does the DEGRADATION family (`[transcript-cache:*]`,
 * `[metadata-cache:*]`, `[transcript-guard:*]`, `[supadata-ledger:*]`, `[supadata-budget:settle-*]`,
 * `[generation-lock:*]`), several of whose functions take a `userId` and must not pass it on. The
 * `reservationId` on `[supadata-budget:settle-*]` is not an exception: it keys a fleet-wide budget
 * reservation, not an account.
 *
 * ONE GRANTED EXCEPTION, the RECONCILIATION FAMILY, and nothing else:
 *
 *  - `[charge-ambiguous:*]` — `userId`, `requestId`, `refusalReason`
 *  - `[credit-leak:*]`      — `userId`, `reservationId`
 *  - `[replay-read:*]`      — `userId`, `requestId`
 *
 * Why these may: each describes a ledger row the app could not settle on its own — a refusal charge
 * whose outcome is unknown, a reservation a failed refund left open, a replay guard that failed open
 * and so can charge a retry twice — and the only remedy is an operator going to THAT row. Stripped of
 * the identifiers, the event says "some user may be out a credit", which nobody can act on.
 *
 * Retention: the identifiers are opaque UUIDs, never an email address or any other contact detail,
 * and they are kept for the Sentry project's retention window like every other event field.
 *
 * A future exception is added to this list first, or not at all. Every promoted site's payload FIELD
 * SET is asserted exactly by its promotion test — `credits.test.ts` for the reconciliation family, each
 * degradation module's colocated `*.test.ts`, and `generate.int.test.ts` for the sites the endpoint
 * owns — so an identifier added anywhere else fails a test instead of quietly widening the rule one site
 * at a time.
 *
 * NEVER THROWS, NEVER BLOCKS. This is a contract, not a style. The seam sits inside `reserveBudget`,
 * immediately before the first paid Supadata call, in a request whose entire design is that a user is
 * never charged for work they did not receive. Forwarding is fire-and-forget: it is never awaited,
 * and both a synchronous throw and a rejected promise are swallowed. `reporting.test.ts` holds that
 * contract to account.
 *
 * NO `astro:env` IMPORT. The DSN is supplied at initialisation time by the two runtime entrypoints
 * (`worker.ts` for the Worker, `sentry.client.config.ts` for the browser), never here — which is also
 * what keeps this module reachable from the `unit` Vitest project (CLAUDE.md §Testing).
 */

/**
 * The two Sentry levels this seam can produce. Deliberately not `@sentry/core`'s `SeverityLevel`:
 * the seam stays free of SDK types, which is what keeps it cheap to import and to test.
 */
export type ReportedLevel = "warning" | "error";

/** One forwarded event, in the shape both sink modules and the tests consume. */
export interface ReportedEvent {
  /**
   * `key` and `severity` ONLY. The payload is deliberately NOT interpolated: a message carrying
   * changing figures is what splits one condition into many issues under Sentry's default grouping.
   */
  readonly message: string;
  readonly level: ReportedLevel;
  /**
   * One condition, one issue, regardless of the figures. Events are sent rather than throttled here —
   * the dashboard shows the stream — but the operator's inbox gets one notification per condition.
   *
   * ONE ACCEPTED EXCEPTION to "every event is sent" (impl-review F5): both SDKs keep Sentry's default
   * `Dedupe` integration, which drops an event identical to the IMMEDIATELY PREVIOUS one from the same
   * client. On the Worker a client lives for one request, so repeats across requests are all sent; in
   * the browser it lives for one page session, so a repeated identical click there counts once. Occurrence
   * counts are therefore per-request / per-session, not exact. A family that needs exact counts has to
   * revisit this rather than inherit it.
   *
   * THE COROLLARY BINDS EVERY PROMOTED SITE: since the payload does not participate in the
   * fingerprint, two failures an operator would act on differently must arrive under DIFFERENT KEYS.
   * A shared key plus a payload discriminator collapses them into one issue.
   */
  readonly fingerprint: readonly [key: string, severity: string];
  /** The payload, carried as structured context rather than as message text. */
  readonly context: {
    readonly key: string;
    readonly severity: string;
    readonly payload: unknown;
  };
}

/**
 * What a sink does with an event. The return value is ignored except to be disarmed: a sink may be
 * synchronous or return a promise, and neither is ever awaited.
 */
export type ReportingSink = (event: ReportedEvent) => unknown;

/** Stable search key for every unsupported-feature event. */
const UNSUPPORTED_FEATURE_EVENT = "[unsupported-feature]";

/**
 * The runtime split, resolved lazily and memoised.
 *
 * `import.meta.env.SSR` is replaced with a LITERAL by Vite in each bundle, so one arm of this branch
 * is eliminated at build time and only the other's `import()` survives. Both arms must stay DYNAMIC:
 * a static import of either SDK at the top of this module defeats the tree-shake and lands
 * `@sentry/cloudflare` in the client bundle. That is what the `SENTRY_WORKER_SINK` grep in the plan's
 * Phase 3 criteria proves, in both directions.
 */
let pendingSink: Promise<ReportingSink> | undefined;

function loadDefaultSink(): Promise<ReportingSink> {
  if (import.meta.env.SSR) {
    return import("./reporting-sink.server").then((module) => module.sentryWorkerSink);
  }
  return import("./reporting-sink.client").then((module) => module.sentryBrowserSink);
}

/**
 * NOT `async`, and `tsc`'s "this may be converted to an async function" hint is wrong here: `async`
 * would make the first `await` a suspension point inside `captureEvent`'s synchronous call, which is
 * exactly the never-blocks half of the contract. The promise is returned so `captureEvent` can disarm
 * it, never so anyone can wait on it.
 */
function defaultSink(event: ReportedEvent): Promise<void> {
  pendingSink ??= loadDefaultSink();
  return pendingSink.then((forward) => {
    forward(event);
  });
}

let sink: ReportingSink = defaultSink;

/**
 * TEST-ONLY BY CONVENTION. Swaps the transport for a recording double, or restores the default with
 * `null`.
 *
 * This named seam is what the contract tests and every promotion test drive. Do NOT reach for
 * `vi.mock("@sentry/cloudflare")` or a `fetch` stub instead: the sink is the boundary this module
 * actually owns, and a test that fakes Sentry's transport proves things about Sentry rather than
 * about this seam.
 */
export function setReportingSink(next: ReportingSink | null): void {
  sink = next ?? defaultSink;
}

/**
 * Forward an event to the receiver WITHOUT writing to the console.
 *
 * For sites that already log their own line, so that promoting one changes what reaches Sentry and
 * leaves console output byte-for-byte as it was.
 *
 * Returns synchronously and never throws, whatever the sink does.
 */
export function captureEvent(key: string, severity: string, payload: unknown): void {
  try {
    const result = sink({
      message: `${key} ${severity}`,
      level: severity === "warn" ? "warning" : "error",
      fingerprint: [key, severity],
      context: { key, severity, payload },
    });
    // A promise is never awaited — only disarmed. Without this a rejecting SDK (or a transport that
    // is simply offline) surfaces as an unhandled rejection, which on workerd is an error attributed
    // to whichever request happened to be running.
    if (isPromiseLike(result)) {
      void Promise.resolve(result).catch(swallow);
    }
  } catch {
    // A monitoring transport must not be able to fail the request it is reporting on.
  }
}

/**
 * Log an event AND forward it. The two existing families (`[supadata-budget]`,
 * `[unsupported-feature]`) keep behaving exactly as they did — the console branches below are
 * untouched — and now also reach the receiver.
 */
export function reportEvent(key: string, severity: string, payload: unknown): void {
  const message = `${key} ${describePayload(payload)}`;
  if (severity === "warn") {
    // eslint-disable-next-line no-console
    console.warn(message);
  } else {
    // eslint-disable-next-line no-console
    console.error(message);
  }
  captureEvent(key, severity, payload);
}

/**
 * The top-up affordance (and anything else not yet built) renders and tells the truth about it —
 * see decision #2. No user identifiers in the payload.
 *
 * Emitted from a hydrated client island, so this family travels on the BROWSER transport
 * (`reporting-sink.client.ts`, initialised by `sentry.client.config.ts`) while
 * `reportBudgetThreshold`'s travels on the Worker's. Both reach the same Sentry project; they are
 * told apart by the event key and by the `sink` tag each module sets, not by separate projects.
 */
export function reportUnsupportedFeature(feature: string): void {
  reportEvent(UNSUPPORTED_FEATURE_EVENT, "warn", { feature });
}

/**
 * The console line's rendering of a payload, which must not be able to throw either. `JSON.stringify`
 * throws on a circular structure, a `bigint` or a throwing `toJSON`, and `payload` is `unknown`, so the
 * seam cannot rule any of them out (impl-review F3). The line degrades to a marker; the payload itself
 * still reaches the sink untouched.
 */
function describePayload(payload: unknown): string {
  try {
    return JSON.stringify(payload);
  } catch {
    return "[unserializable payload]";
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as PromiseLike<unknown> | null)?.then === "function";
}

function swallow(): void {
  // Named so the intent is legible at the call site: the rejection is disarmed, not handled.
}
