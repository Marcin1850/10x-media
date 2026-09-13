# Overview and quickstart

Sources:

- https://code.claude.com/docs/en/agent-sdk/quickstart
- https://code.claude.com/docs/en/agent-sdk/migration-guide
- https://code.claude.com/docs/en/agent-sdk/typescript-v2-preview (V1 streaming example)

## What the SDK is

The Agent SDK runs the same agent loop as Claude Code, with the same tools, permissions, settings and hooks,
driven from your own code. In TypeScript the entry point is `query()`. It spawns a Claude Code process and
returns an async generator of messages (`system` init, `assistant`, `user`, `result`, …).

## Install

```bash
npm install @anthropic-ai/claude-agent-sdk
```

The package used to be called `@anthropic-ai/claude-code`. Imports now come from the new name:

```typescript
// Before
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-code";
// After
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
```

For a new TypeScript project the quickstart recommends `"type": "module"` in `package.json` (for top-level
`await`) and [tsx](https://tsx.hirok.io) to run `.ts` files directly.

Peer dependencies of `0.3.270`: `zod ^4`, `@anthropic-ai/sdk >=0.93.0`, `@modelcontextprotocol/sdk ^1.29.0`.
npm 7+ installs them automatically.

## Authentication

An Anthropic API key in `ANTHROPIC_API_KEY` in the process environment. This package passes no `env` option
(see `query-options.md`), so the key comes from `process.env`, which `tsx --env-file-if-exists=.env` fills in.

## The basic loop

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

// Agentic loop: streams messages as Claude works
for await (const message of query({
  prompt: "Review utils.py for bugs that would cause crashes. Fix any issues you find.",
  options: {
    allowedTools: ["Read", "Edit", "Glob"], // Auto-approve these tools
    permissionMode: "acceptEdits", // Auto-approve file edits
  },
})) {
  if (message.type === "assistant" && message.message?.content) {
    for (const block of message.message.content) {
      if ("text" in block) {
        console.log(block.text); // Claude's reasoning
      } else if ("name" in block) {
        console.log(`Tool: ${block.name}`); // Tool being called
      }
    }
  } else if (message.type === "result") {
    console.log(`Done: ${message.subtype}`); // Final result
  }
}
```

The quickstart example **gives the agent tools and lets it edit files**. That is the opposite of what this
package wants. See `query-options.md` and `permissions.md` for the locked-down configuration.

Extracting text from assistant messages:

```typescript
for await (const msg of query({ prompt: "Hello!", options: { model: "claude-opus-4-7" } })) {
  if (msg.type === "assistant") {
    const text = msg.message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    console.log(text);
  }
}
```

## System prompt default

Since v0.1.0 the SDK **no longer** uses Claude Code's system prompt by default. It uses a minimal one. To get
the old behaviour, request `systemPrompt: { type: "preset", preset: "claude_code" }`. A plain string replaces
the prompt entirely.
