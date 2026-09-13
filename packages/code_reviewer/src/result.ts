import type { SDKResultError, SDKResultSuccess, TerminalReason } from "@anthropic-ai/claude-agent-sdk";
import type { z } from "zod";

import { ReviewOutput } from "./schema.js";

type ResultCommon =
  | "type"
  | "subtype"
  | "is_error"
  | "total_cost_usd"
  | "duration_ms"
  | "session_id"
  | "num_turns"
  | "terminal_reason";

/**
 * The fields of the SDK's result message this module reads. A full `SDKResultMessage` is assignable to it;
 * narrowing to a `Pick` keeps test fixtures honest about which fields the outcome depends on.
 */
export type ResultInput =
  | Pick<SDKResultSuccess, ResultCommon | "structured_output">
  | Pick<SDKResultError, ResultCommon | "errors">;

export interface ResultMeta {
  costUsd: number;
  durationMs: number;
  sessionId: string;
  numTurns: number;
}

export type ReviewOutcome =
  | { kind: "ok"; output: ReviewOutput; meta: ResultMeta }
  | { kind: "invalid-output"; issues: z.core.$ZodIssue[]; meta: ResultMeta }
  | {
      kind: "agent-error";
      subtype: ResultInput["subtype"];
      terminalReason: TerminalReason | undefined;
      errors: string[];
      meta: ResultMeta;
    };

/**
 * Decides whether a finished run actually produced a usable review. "The loop ended" is not success:
 * `ok` requires `subtype: "success"`, `is_error: false` (the SDK reports a failed final API call as
 * `success` + `is_error: true`, docs/messages-and-errors.md), and `structured_output` that passes the schema.
 */
export function interpretResult(message: ResultInput): ReviewOutcome {
  const meta: ResultMeta = {
    costUsd: message.total_cost_usd,
    durationMs: message.duration_ms,
    sessionId: message.session_id,
    numTurns: message.num_turns,
  };

  if (message.subtype !== "success") {
    return {
      kind: "agent-error",
      subtype: message.subtype,
      terminalReason: message.terminal_reason,
      errors: message.errors,
      meta,
    };
  }

  if (message.is_error) {
    return { kind: "agent-error", subtype: message.subtype, terminalReason: message.terminal_reason, errors: [], meta };
  }

  const parsed = ReviewOutput.safeParse(message.structured_output);
  if (!parsed.success) {
    return { kind: "invalid-output", issues: parsed.error.issues, meta };
  }
  return { kind: "ok", output: parsed.data, meta };
}
