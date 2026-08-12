/**
 * The one swappable notification point (decision #2). Error-monitoring tools treat console output
 * as a breadcrumb attached to OTHER events, so scattered `console.warn` calls may never become an
 * alert on their own — this is the single seam a real receiver plugs into later.
 *
 * Severity rule is fixed: `warn` goes to `console.warn`, everything else to `console.error`. Callers
 * pass their own severity vocabulary (e.g. `supadata-budget`'s `stop` / `warn` / `untracked`) rather
 * than being narrowed to this module's cases.
 */
export function reportEvent(key: string, severity: string, payload: unknown): void {
  const message = `${key} ${JSON.stringify(payload)}`;
  if (severity === "warn") {
    // eslint-disable-next-line no-console
    console.warn(message);
    return;
  }
  // eslint-disable-next-line no-console
  console.error(message);
}

/** Stable search key for every unsupported-feature event. Counted per feature in Workers logs. */
const UNSUPPORTED_FEATURE_EVENT = "[unsupported-feature]";

/**
 * The top-up affordance (and anything else not yet built) renders and tells the truth about it —
 * see decision #2. No user identifiers in the payload.
 */
export function reportUnsupportedFeature(feature: string): void {
  reportEvent(UNSUPPORTED_FEATURE_EVENT, "warn", { feature });
}
