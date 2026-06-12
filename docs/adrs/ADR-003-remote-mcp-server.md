# ADR-003: Remote MCP Server Via Cloudflare Agents SDK

## Status

Accepted — 2026-06-12

## Context

Claude and OpenCode both support remote MCP servers over HTTP. Brainfog should expose memory tools (e.g. `remember`, `recall`, `search_memories`) to any connected agent without requiring a locally-running process, consistent with the "few trusted people, low friction" goal in `VISION.md`.

## Decision

We will implement the MCP server using Cloudflare's `agents` SDK (`McpAgent`, built on Durable Objects), running inside the same Worker that serves the REST API and web UI (ADR-001), exposed over Streamable HTTP at `/mcp`. Each connection authenticates via a per-user bearer token (ADR-004). MCP tool handlers call the same internal service layer used by the REST API, per `ARCHITECTURE.md` invariant 5.

## Consequences

**Positive**
- No local process for users to install or keep running — Claude and OpenCode connect directly to a URL.
- Durable Objects give the MCP session stable per-connection state where needed.
- A single service layer behind both MCP and REST keeps behavior consistent between the two surfaces.

**Negative**
- Durable Objects add a binding and a billing/operational dimension beyond plain Workers.
- Streamable HTTP MCP support across clients is newer than stdio and may need fallback handling for some clients.

**Neutral**
- An SSE transport fallback can be added later for clients that don't yet support Streamable HTTP, without changing the service layer.

## Alternatives Considered

- **Local stdio MCP server proxying to a hosted REST API:** rejected because every user would need to install and keep a local process updated; remote MCP removes that friction entirely.
- **Hand-rolled `@modelcontextprotocol/sdk` server without Cloudflare's `agents` SDK:** rejected because it would require reimplementing the Streamable HTTP/SSE transport and session handling that the `agents` SDK already provides for Workers/Durable Objects.
