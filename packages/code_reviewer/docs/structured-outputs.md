# Structured outputs

Source: https://code.claude.com/docs/en/agent-sdk/structured-outputs

## Configuration

The `outputFormat` option (Python: `output_format`) takes:

- `type`: `"json_schema"`
- `schema`: a JSON Schema object. It can be generated from zod with `z.toJSONSchema(schema, { target: "draft-7" })`.

Supported: all basic types (object, array, string, number, boolean, null), `enum`, `const`, `required`, nested
objects, `$ref` definitions. Limitations are listed at
https://platform.claude.com/docs/en/build-with-claude/structured-outputs#json-schema-limitations.

On success, the parsed object arrives as `structured_output` on the `result` message with `subtype: "success"`.
If the model cannot produce valid output within its retries, the run ends with
`subtype: "error_max_structured_output_retries"`.

## Zod → JSON Schema → `safeParse`

```typescript
import { z } from "zod";
import { query } from "@anthropic-ai/claude-agent-sdk";

const FeaturePlan = z.object({
  feature_name: z.string(),
  summary: z.string(),
  steps: z.array(
    z.object({
      step_number: z.number(),
      description: z.string(),
      estimated_complexity: z.enum(["low", "medium", "high"]),
    }),
  ),
  risks: z.array(z.string()),
});
type FeaturePlan = z.infer<typeof FeaturePlan>;

// Convert to JSON Schema using the draft-07 target the SDK expects
const schema = z.toJSONSchema(FeaturePlan, { target: "draft-7" });

try {
  for await (const message of query({
    prompt: "Plan how to add dark mode support to a React app. Break it into implementation steps.",
    options: { outputFormat: { type: "json_schema", schema } },
  })) {
    if (message.type === "result" && message.subtype === "success" && message.structured_output) {
      const parsed = FeaturePlan.safeParse(message.structured_output);
      if (parsed.success) {
        const plan: FeaturePlan = parsed.data;
        console.log(`Feature: ${plan.feature_name}`);
      }
    }
  }
} catch (error) {
  // A single-shot query() throws after yielding an error result, such as
  // error_max_structured_output_retries; see the Error handling section.
  console.error(`Session ended with an error: ${error}`);
}
```

`structured_output` is typed `unknown`, so validate it yourself (`safeParse`). The SDK validates against the
JSON Schema, but the zod schema is the source of truth for the TypeScript type.

## Handling every outcome

```typescript
try {
  for await (const msg of query({
    prompt: "Extract contact info from the document",
    options: { outputFormat: { type: "json_schema", schema: contactSchema } },
  })) {
    if (msg.type === "result") {
      if (msg.subtype === "success" && msg.structured_output) {
        console.log(msg.structured_output);
      } else if (msg.subtype === "error_max_structured_output_retries") {
        console.error("Could not produce valid output");
      } else {
        console.error("Run ended without a structured output");
      }
    }
  }
} catch (error) {
  // A single-shot query() throws after yielding an error result. If the
  // failure was an error result, the error subtype branches above have
  // already run; connection or process failures yield no result message.
  console.log(`Session ended with an error: ${error}`);
}
```

## Note for a tool-less agent

The docs do not say whether structured output relies on an internal tool that `tools: []` or
`disallowedTools: ["*"]` would remove. Check it empirically: the run ends in
`error_max_structured_output_retries`, or finishes `success` without `structured_output`, when that is the case.
