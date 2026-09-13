import { query } from "@anthropic-ai/claude-agent-sdk";

import { buildReviewPrompt, SYSTEM_PROMPT } from "./prompt.js";
import { interpretResult, type ReviewOutcome } from "./result.js";
import { reviewOutputJsonSchema } from "./schema.js";

/** Small on purpose: a tool-less review is one model turn plus room for structured-output retries. */
const MAX_TURNS = 3;

/**
 * Tools the session may expose despite `tools: []`. `StructuredOutput` is how the SDK delivers `outputFormat`
 * (observed in the init message on SDK 0.3.270); it gives the model no access to anything outside the prompt.
 */
export const EXPECTED_SESSION_TOOLS: readonly string[] = ["StructuredOutput"];

/** What the session reported about itself in its `system`/`init` message — the proof of the lockdown. */
export interface SessionInit {
  initTools: string[];
  model: string;
}

export type ReviewRun =
  | (ReviewOutcome & Partial<SessionInit>)
  | ({ kind: "no-result"; error: unknown } & Partial<SessionInit>);

/**
 * The one place that calls `query()`.
 *
 * Two failure channels (docs/messages-and-errors.md): an error result is yielded and then the iterator
 * throws; a process/connection failure throws with no result at all. The result is interpreted as soon as
 * it arrives, the throw is caught, and the outcome is decided from what was captured — never from the
 * loop merely ending.
 */
export async function runReview({ diff, model }: { diff: string; model?: string }): Promise<ReviewRun> {
  let init: SessionInit | undefined;
  let outcome: ReviewOutcome | undefined;

  try {
    for await (const message of query({
      prompt: buildReviewPrompt(diff),
      options: {
        systemPrompt: SYSTEM_PROMPT,
        // `tools: []` removes the built-in tools; `allowedTools` would only auto-approve and remove nothing.
        tools: [],
        permissionMode: "dontAsk",
        // No user/project/local settings: no ~/.claude rules, no repo CLAUDE.md, hooks, or skills.
        settingSources: [],
        outputFormat: { type: "json_schema", schema: reviewOutputJsonSchema },
        maxTurns: MAX_TURNS,
        ...(model ? { model } : {}),
        // Deliberately no `env`: it replaces the subprocess environment instead of merging into it.
      },
    })) {
      if (message.type === "system" && message.subtype === "init") {
        init = { initTools: message.tools, model: message.model };
      } else if (message.type === "result") {
        outcome = interpretResult(message);
      }
    }
  } catch (error) {
    // Only the documented throw-after-error-result is expected; it carries nothing the captured result lacks.
    // A throw after a successful result is not documented, so it never exits as success.
    if (!outcome || outcome.kind === "ok") return { kind: "no-result", error, ...init };
  }

  if (!outcome)
    return { kind: "no-result", error: new Error("The SDK stream ended without a result message"), ...init };
  return { ...outcome, ...init };
}
