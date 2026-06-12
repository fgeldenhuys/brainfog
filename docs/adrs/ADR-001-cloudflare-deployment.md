# ADR-001: Cloudflare Deployment Surface

## Status

Accepted — 2026-06-12

## Context

Brainfog needs a remote MCP server, a REST API, and a minimal web UI, backed by a relational store, a vector index, and an embedding model — operable by a small trusted group with minimal operational overhead. The project is explicitly targeted at Cloudflare.

## Decision

We will use Cloudflare as the sole deployment surface:

- Cloudflare Workers host the MCP server (`/mcp`), REST API (`/api/v1/`), and the server-rendered web UI.
- D1 is the canonical relational store for memories, users, and tokens.
- Vectorize stores embedding vectors for semantic search, keyed by D1 row id.
- Workers AI provides the embedding model used to populate Vectorize.
- KV is not used in v1; if a caching or ephemeral-state need arises, it can be added without an ADR since it doesn't change the canonical-store invariant.

## Consequences

**Positive**
- Single vendor; D1, Vectorize, and Workers AI all bind directly to the Worker with no external network hop.
- Generous free tier fits a personal/small-group tool.
- Wrangler/Miniflare provides local development that mirrors production for Workers, D1, Vectorize, and Workers AI.

**Negative**
- Worker runtime constraints limit which npm packages are usable without `nodejs_compat`.
- D1 (SQLite-based) has different concurrency and feature characteristics than a server-based relational database.
- Vectorize is eventually consistent.
- Vendor lock-in spans Workers, D1, Vectorize, and Workers AI simultaneously — migrating later means replacing all of them together.

**Neutral**
- Secrets live in ignored `.dev.vars` locally or Wrangler-managed secrets in production.
- There is one hosted environment in the early stages (`ARCHITECTURE.md` invariant 7).

## Alternatives Considered

- **Self-hosted PostgreSQL + pgvector (OB1's default):** rejected because it requires hosting and operating a database server, which conflicts with the goal of a low-operational-overhead, Cloudflare-targeted project.
- **Supabase:** rejected because it adds an external vendor/account; the project is specifically targeted at Cloudflare.
- **AWS (Lambda + RDS/Aurora + OpenSearch):** rejected because it requires materially more configuration and operational overhead than Cloudflare's integrated bindings for this scale.
