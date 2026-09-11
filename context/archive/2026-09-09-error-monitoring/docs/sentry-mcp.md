# Sentry MCP — install at user scope, not in this repo

> Phase 1 §5 of `../plan.md`. Decision **D7**: the repo gets the instructions, the machine gets the
> server.

## Why this is a doc and not a `.mcp.json` entry

`.mcp.json` is committed, and this repository is **public**. A project-scoped MCP entry for Sentry
would have to name the org slug and the project slug in the URL, which publishes two account
identifiers that nothing in the codebase otherwise needs — the same class of leak `lessons.md`'s
"Never commit account identifiers from a real-environment pass" rule exists to stop, one step earlier.

The MCP server is also not a build or test dependency. Nothing in `npm run build`, either Vitest
project, the e2e suite or CI reads it; it is an operator convenience for asking about issues from the
editor. A per-machine install is therefore the right scope on its own terms, not just the safe one.

**`.mcp.json` is not modified by this change.**

## Endpoint

The remote server is hosted by Sentry at `https://mcp.sentry.dev`, and it accepts three levels of
scoping:

| URL                                                        | Scope                                       |
| ---------------------------------------------------------- | ------------------------------------------- |
| `https://mcp.sentry.dev/mcp`                               | every org the authenticated account can see |
| `https://mcp.sentry.dev/mcp/{organizationSlug}`             | one organization                            |
| `https://mcp.sentry.dev/mcp/{organizationSlug}/{projectSlug}` | one project                                 |

**Use the project-scoped form.** It is the narrowest of the three, and this change has exactly one
project to ask about. A tool that can only see the project it is meant to see cannot answer a question
about another one by accident.

## Install (user scope, this machine only)

```bash
claude mcp add --scope user --transport http sentry https://mcp.sentry.dev/mcp/<org-slug>/<project-slug>
```

`--scope user` writes to `~/.claude.json`, which is outside the repository — that is what keeps the
two slugs uncommitted. Substitute the real slugs recorded during Phase 1 §1; they are deliberately not
written down here.

The first connection runs an **OAuth flow** in the browser against your Sentry account. No token is
stored in the config, and none is pasted into a file — which is the second reason this stays out of
the repo's committed config: there would be nothing useful to commit anyway.

## Verify

Run `/mcp` in Claude Code. The `sentry` server should be listed as connected and its tools
enumerated.

## Removing it

```bash
claude mcp remove --scope user sentry
```
