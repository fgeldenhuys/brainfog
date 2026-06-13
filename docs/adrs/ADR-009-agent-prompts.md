# ADR-009: Agent Guidance Via MCP Prompts

## Status

Accepted — 2026-06-13

## Context

Brainfog's MCP server (ADR-003) now exposes 16 memory tools (`specs/memory-model/spec.md`) covering recall, facts, thoughts, tasks, documents, people, projects, and time-series. Per `VISION.md`, agents are the primary readers and writers of brainfog memory, but nothing currently tells a connected agent *when* to call `recall` versus `remember`/`record_fact`/`create_task`, or builds a habit of doing so at natural points in a session — recalling relevant context at the start, and persisting durable facts, decisions, and follow-ups before it ends.

Two ways to deliver this agent-side guidance were considered:

1. Extend the existing `/mcp` server with the MCP `prompts` capability — named, parameterized prompt templates that any connected MCP client can list and invoke.
2. Author and distribute Claude Code / OpenCode skill files (e.g. `.claude/skills/*.md`) that wrap brainfog tool calls, shipped via a plugin or copied into each project.

## Decision

We will add MCP prompts to brainfog's existing `/mcp` server (`BrainfogMCP`, ADR-003), using `@modelcontextprotocol/sdk`'s `McpServer.prompt(...)`, which is already available via the existing `@modelcontextprotocol/sdk`/`agents` dependencies — no new package. `specs/agent-prompts/spec.md` defines the prompt set, starting with `recall-context` and `save-session-notes`.

## Consequences

**Positive**

- No new package, distribution channel, or per-project install step — any MCP client connected to `/mcp` with a valid bearer token (ADR-004) automatically sees the prompts via `prompts/list`.
- Works identically for Claude Code and OpenCode (both MCP clients), and for any future MCP client, without per-client-format duplication.
- Keeps brainfog's "remote MCP server is the primary agent interface" story (`ARCHITECTURE.md` invariant 5) coherent — prompts are just another MCP capability alongside tools.

**Negative**

- MCP prompts are plain templated text/messages — less rich than a full Claude Code Skill (no bundled scripts/resources), and how a client surfaces a prompt for invocation varies by client.
- Prompt wording changes require a brainfog deploy, rather than a client-side file the user could tweak locally.

**Neutral**

- Distributable skill files (option 2) remain possible later for clients that want richer, customizable workflows; this ADR doesn't preclude adding them, but they are not part of v1.

## Alternatives Considered

- **Distributable Claude Code / OpenCode skill files**: rejected for v1 because it requires a separate distribution mechanism (plugin or per-project copy) and duplicate authoring for each client's skill/agent format, working against brainfog's "any agent can plug in without bespoke per-tool integration" taste reference (`VISION.md`).
- **Hybrid (MCP prompts + bundled skill files)**: deferred — MCP prompts alone cover the immediate need (recall at session start, persist at session end); revisit if MCP prompts prove insufficient for richer workflows.
