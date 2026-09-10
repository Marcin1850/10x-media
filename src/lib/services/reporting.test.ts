import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  captureEvent,
  reportEvent,
  reportUnsupportedFeature,
  setReportingSink,
  type ReportedEvent,
} from "@/lib/services/reporting";

/**
 * The seam's transport contract (S-13 Phase 3).
 *
 * Oracle: `reporting.ts`'s own module contract and roadmap S-13's first hard constraint — "reporting
 * must never be able to break a paid request". Nothing below is read off the implementation: each
 * case names a way a monitoring transport can hurt the request it is reporting on (throw, reject,
 * hang, log twice) and asserts it cannot happen here.
 *
 * **The sink is the seam.** Every case drives `setReportingSink`. Do NOT stub `fetch` or Sentry's
 * transport instead: those belong to Sentry, and a test that fakes them proves things about the SDK
 * rather than about the two functions this file covers.
 *
 * Why this contract is worth a direct test at all, when almost nothing else in `src/lib/services` is
 * tested for "does not throw": `captureEvent` runs inside `reserveBudget`, immediately before the
 * first paid Supadata call, in a request whose whole design is that a user is never charged for work
 * they did not receive. A transport that can fail that request would introduce a money bug into the
 * flow every other guardrail in the roadmap exists to protect.
 */

/** Collects events without asserting anything about them — the double most cases here want. */
function recordingSink(): { events: ReportedEvent[]; sink: (event: ReportedEvent) => void } {
  const events: ReportedEvent[] = [];
  return {
    events,
    sink: (event) => {
      events.push(event);
    },
  };
}

/** Lets pending microtasks AND one macrotask turn run, which is when a stray rejection would surface. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

let consoleWarn: MockInstance<typeof console.warn>;
let consoleError: MockInstance<typeof console.error>;

beforeEach(() => {
  consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  // Restore the real transport as well as the console: a leaked recording sink would make the next
  // file's events invisible, and a leaked spy would silence a real regression elsewhere.
  setReportingSink(null);
  vi.restoreAllMocks();
});

describe("the transport can never break its caller", () => {
  it("swallows a sink that throws synchronously", () => {
    setReportingSink(() => {
      throw new Error("transport is down");
    });

    expect(() => {
      captureEvent("[paid-path:summarize]", "error", { stage: "summarize" });
    }).not.toThrow();
    expect(() => {
      reportEvent("[supadata-budget]", "stop", { spent: 1 });
    }).not.toThrow();
  });

  it("swallows a sink that returns a rejected promise, without an unhandled rejection", async () => {
    // The distinct regression from the case above: a `try/catch` around a call that returns a promise
    // catches nothing, and on workerd an unhandled rejection is attributed to whichever request
    // happened to be running — i.e. someone else's paid generation.
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      setReportingSink(() => Promise.reject(new Error("ingest refused the envelope")));

      expect(() => {
        captureEvent("[credit-leak:refund-failed]", "error", {});
      }).not.toThrow();
      await settle();

      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("returns before a sink that never settles has settled", () => {
    // A microtask queued BEFORE the call is the probe: if it has still not run afterwards, nothing
    // inside `reportEvent` awaited anything. This is what fails if the seam is ever made `async`.
    setReportingSink(() => new Promise<never>(() => undefined));

    let microtaskRan = false;
    queueMicrotask(() => {
      microtaskRan = true;
    });

    reportEvent("[supadata-budget]", "warn", { remaining: 3 });

    expect(microtaskRan).toBe(false);
  });

  it("is a silent no-op with the default sink and no initialised client", async () => {
    // No `setReportingSink` double here on purpose: this is the real runtime split, in the state every
    // local run, both Vitest projects, the e2e run and the `ci`/`e2e` CI jobs are in — no DSN, so no
    // Sentry client, so nothing is sent and nothing is thrown.
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      setReportingSink(null);

      expect(() => {
        captureEvent("[replay-read:threw]", "error", { requestId: "req-1" });
      }).not.toThrow();
      await settle();

      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("logging and forwarding are separate", () => {
  it("forwards without writing to the console", () => {
    const { events, sink } = recordingSink();
    setReportingSink(sink);

    captureEvent("[paid-path:persist]", "error", { youtubeId: "abc" });

    expect(events).toHaveLength(1);
    // The whole reason `captureEvent` exists: every site promoted in Phases 4-5 already writes its
    // own line, so a sink that logged would double it.
    expect(consoleWarn).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it.each([
    { severity: "warn", stream: "warn" as const },
    { severity: "stop", stream: "error" as const },
  ])("$severity: reportEvent writes exactly one line and forwards once", ({ severity, stream }) => {
    const { events, sink } = recordingSink();
    setReportingSink(sink);

    reportEvent("[supadata-budget]", severity, { spent: 12 });

    // Exactly ONE line, on exactly one stream — the severity rule is the only thing that chooses it,
    // and `captureEvent` must not have added a second.
    expect(stream === "warn" ? consoleWarn : consoleError).toHaveBeenCalledTimes(1);
    expect(stream === "warn" ? consoleError : consoleWarn).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
  });

  it("still logs when the sink throws", () => {
    // The console is the forensic fallback (Workers Logs). A broken receiver must not cost the
    // operator the log line as well as the alert.
    setReportingSink(() => {
      throw new Error("transport is down");
    });

    reportEvent("[supadata-budget]", "stop", { spent: 12 });

    expect(consoleError).toHaveBeenCalledTimes(1);
  });
});

describe("what the receiver is told", () => {
  it.each([
    { severity: "warn", level: "warning" },
    { severity: "stop", level: "error" },
    { severity: "untracked", level: "error" },
    { severity: "error", level: "error" },
  ])("maps severity $severity to level $level", ({ severity, level }) => {
    const { events, sink } = recordingSink();
    setReportingSink(sink);

    captureEvent("[supadata-budget]", severity, {});

    expect(events[0].level).toBe(level);
  });

  it("keeps the payload out of the message and carries it as context", () => {
    // A message carrying changing figures is what splits one condition into many issues under
    // Sentry's default grouping — the exact failure mode the fingerprint below exists to prevent, so
    // the message must not reintroduce it.
    const { events, sink } = recordingSink();
    setReportingSink(sink);

    captureEvent("[supadata-budget]", "warn", { spent: 999.5 });

    expect(events[0].message).toBe("[supadata-budget] warn");
    expect(events[0].message).not.toContain("999.5");
    expect(events[0].context).toEqual({ key: "[supadata-budget]", severity: "warn", payload: { spent: 999.5 } });
  });

  it("routes the unsupported-feature family under its own key", () => {
    const { events, sink } = recordingSink();
    setReportingSink(sink);

    reportUnsupportedFeature("top-up");

    expect(events).toEqual([
      expect.objectContaining({ level: "warning", fingerprint: ["[unsupported-feature]", "warn"] }),
    ]);
  });
});

/**
 * The event keys this seam is expected to carry, one row per CONDITION an operator would act on
 * differently. Phases 4 and 5 of the S-13 plan append their promoted keys here — that is the point of
 * the table: the fingerprint is `[key, severity]` and ignores the payload, so two conditions sharing
 * a key silently merge into one issue in the dashboard, and this is where that gets caught instead.
 */
const PROMOTED_KEYS: readonly (readonly [key: string, severity: string])[] = [
  ["[supadata-budget]", "stop"],
  ["[supadata-budget]", "warn"],
  ["[supadata-budget]", "untracked"],
  ["[unsupported-feature]", "warn"],
  // Phase 4 — money integrity. One key per cause an operator reconciles differently.
  ["[charge-ambiguous:no-row]", "error"],
  ["[charge-ambiguous:unknown-outcome]", "error"],
  ["[charge-ambiguous:rejected]", "error"],
  ["[credit-leak:refund-failed]", "error"],
  ["[credit-leak:refund-threw]", "error"],
  ["[replay-read:rpc-error]", "error"],
  ["[replay-read:threw]", "error"],
  ["[paid-path:begin]", "error"],
  ["[paid-path:summarize]", "error"],
  ["[paid-path:persist]", "error"],
  ["[paid-path:persist-skipped]", "error"],
  ["[paid-path:replay-readback]", "error"],
];

describe("one condition, one issue", () => {
  it.each(PROMOTED_KEYS)("%s/%s fingerprints identically whatever the payload carries", (key, severity) => {
    const { events, sink } = recordingSink();
    setReportingSink(sink);

    captureEvent(key, severity, { spent: 1, requestId: "req-a" });
    captureEvent(key, severity, { spent: 987654, requestId: "req-b", extra: null });

    expect(events[0].fingerprint).toEqual([key, severity]);
    expect(events[1].fingerprint).toEqual(events[0].fingerprint);
  });

  it("gives every promoted condition a fingerprint of its own", () => {
    const { events, sink } = recordingSink();
    setReportingSink(sink);

    for (const [key, severity] of PROMOTED_KEYS) captureEvent(key, severity, {});

    const fingerprints = events.map((event) => event.fingerprint.join(" "));
    expect(new Set(fingerprints).size).toBe(PROMOTED_KEYS.length);
  });
});
