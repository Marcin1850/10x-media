import { afterEach, beforeEach, expect } from "vitest";
import { setReportingSink, type ReportedEvent } from "@/lib/services/reporting";

/**
 * The promotion oracle shared by every S-13 promotion test (plan Phases 4-5, §Testing Strategy).
 *
 * A promoted site already writes its own console line, and the suites that cover it silence the
 * console and assert business outcomes — so without this, every `captureEvent` call could be deleted
 * and every suite would stay green. Each promoted site gets one row asserting exactly three things:
 * the KEY, the SEVERITY and the payload FIELD SET. Nothing else — not console copy, not payload values,
 * and never Sentry itself.
 *
 * The field set is where the seam's personal-data rule is enforced (`reporting.ts`, PERSONAL DATA). It
 * is asserted EXACTLY, so an identifier added to a payload outside the reconciliation family fails the
 * row rather than widening the exception one site at a time.
 */

/**
 * Anything shaped like an email address. The reconciliation family is granted opaque UUIDs and nothing
 * more; an address may never appear in ANY payload, an error string included.
 */
const EMAIL_SHAPED = /[^\s@"]+@[^\s@"]+\.[^\s@"]+/;

export interface PromotedEventExpectation {
  key: string;
  severity: string;
  /** The payload's field names, exactly — order-insensitive. */
  fields: readonly string[];
  /**
   * Values that may not appear ANYWHERE in the payload, error strings included — typically the user id
   * the function under test was handed. The field set cannot catch an identifier interpolated into an
   * allowed field, and that is precisely what copying a console line (several name the account) into a
   * payload would do.
   */
  withheld?: readonly string[];
}

export function expectPromotedEvent(
  events: readonly ReportedEvent[],
  { key, severity, fields, withheld = [] }: PromotedEventExpectation,
): void {
  // Exactly one: zero is a deleted promotion, two is one failure doubled into the operator's stream.
  const matching = events.filter((event) => event.context.key === key);
  expect(matching.map((event) => event.context.key)).toEqual([key]);

  const { payload } = matching[0].context;
  expect(matching[0].context.severity).toBe(severity);
  expect(payload).toBeTypeOf("object");
  expect(Object.keys(payload as Record<string, unknown>).sort()).toEqual([...fields].sort());
  const serialized = JSON.stringify(payload);
  expect(serialized).not.toMatch(EMAIL_SHAPED);
  for (const value of withheld) {
    expect(serialized).not.toContain(value);
  }
}

/**
 * Installs a recording sink around every test in the enclosing `describe` and returns the array it
 * fills — emptied before each test, default sink restored after.
 *
 * For a module the test file imports statically. An endpoint loaded through `generation-harness.ts`
 * takes `loadEndpoint`'s `events` option instead: its module registry is reset per load, so a sink
 * installed from here would sit on a `reporting.ts` instance the endpoint never forwards through.
 */
export function recordReportedEvents(): readonly ReportedEvent[] {
  const events: ReportedEvent[] = [];

  beforeEach(() => {
    events.length = 0;
    setReportingSink((event) => {
      events.push(event);
    });
  });

  afterEach(() => {
    setReportingSink(null);
  });

  return events;
}
