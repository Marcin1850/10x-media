import { expect } from "vitest";
import type { ReportedEvent } from "@/lib/services/reporting";

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
}

export function expectPromotedEvent(
  events: readonly ReportedEvent[],
  { key, severity, fields }: PromotedEventExpectation,
): void {
  // Exactly one: zero is a deleted promotion, two is one failure doubled into the operator's stream.
  const matching = events.filter((event) => event.context.key === key);
  expect(matching.map((event) => event.context.key)).toEqual([key]);

  const { payload } = matching[0].context;
  expect(matching[0].context.severity).toBe(severity);
  expect(payload).toBeTypeOf("object");
  expect(Object.keys(payload as Record<string, unknown>).sort()).toEqual([...fields].sort());
  expect(JSON.stringify(payload)).not.toMatch(EMAIL_SHAPED);
}
