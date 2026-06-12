# ADR-007: Minimal Web UI Via Hono, Server-Rendered

## Status

Accepted — 2026-06-12

## Context

Brainfog needs a minimal web UI for humans to review, search, and curate memories — per `VISION.md`, "the UI is for human review and curation; agents are the primary readers and writers" — served from the same Worker as the MCP server and REST API (ADR-003), without adding a separate frontend build pipeline for a small surface.

## Decision

We will use Hono as the Worker's HTTP framework for routing `/api/v1/*`, `/mcp`, and the web UI. Web UI pages render server-side using Hono's JSX support (`hono/jsx`) with minimal CSS. There is no client-side framework or separate frontend build step (no React/Vite SPA) in v1.

## Consequences

**Positive**
- One framework handles API, MCP, and UI routing.
- Hono is lightweight and Workers-native.
- Server-rendered JSX avoids a separate frontend build/bundle/toolchain.
- Hono middleware implements the bearer-token auth check (ADR-004) once for all route groups.

**Negative**
- No rich client-side interactivity (no SPA-style instant search/filter without page reloads) unless small islands of JS are added later.
- Server-rendered JSX is less familiar than a full SPA to contributors expecting React-style patterns.

**Neutral**
- htmx or small vanilla-JS enhancements can be layered on later without changing the routing/rendering approach.
- A full SPA rewrite would need its own ADR.

## Alternatives Considered

- **React + Vite SPA served as static assets:** rejected for v1 because it adds a separate build pipeline and bundle for a UI whose job is review/curation, not rich interaction — agents, not the UI, are the primary read/write path (`ARCHITECTURE.md`).
- **Hand-rolled routing/templating on a plain Workers `fetch` handler:** rejected because Hono's routing, middleware, and JSX support cover this with minimal overhead, avoiding reimplementing request parsing and auth middleware.
- **Astro or Next.js on Cloudflare Pages:** rejected because both pull in larger frameworks/build systems for a UI that is intentionally minimal in v1. Revisit via ADR if the UI scope grows substantially.
