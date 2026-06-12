# brainfog

Brainfog is a shared memory and context layer for AI-assisted work: a remote MCP server plus a REST API and a minimal web UI, deployed on Cloudflare Workers with D1, Vectorize, and R2. Claude, OpenCode, and the people working with them use it to write and recall durable context across sessions and projects.

The platform baseline (pnpm workspace, Worker, D1/Vectorize/Workers AI/R2 bindings, auth, `/mcp`, `/api/v1`, and web UI scaffold) is in place per `specs/platform-setup/spec.md`. Vision, architecture, ADR, and spec artifacts remain the source of truth for what gets built next.

## Start Here

- `VISION.md` — product direction, voice, and decision heuristics.
- `ARCHITECTURE.md` — system-wide constraints and boundaries.
- `AGENTS.md` — agent operating rules and toolchain.
- `docs/adrs/` — accepted architecture decisions.
- `specs/` — ASDLC feature contracts.
- `tasks/` — planned PBI format and lifecycle.

## Getting Started

```sh
pnpm install
cp apps/worker/.dev.vars.example apps/worker/.dev.vars   # fill in BRAINFOG_TOKEN_HASH_SECRET
pnpm db:migrate
pnpm --filter @brainfog/worker seed                       # creates a local user + bearer token
pnpm dev
```

`pnpm seed` prints the bearer token once — use it to authenticate `/api/v1/*` and `/mcp` requests, or sign in via the web UI at `http://localhost:8787`.

## Current Scope

- **Platform baseline** (`specs/platform-setup/spec.md`): pnpm workspace, a Cloudflare Worker with D1/Vectorize/Workers AI bindings, a remote MCP scaffold over Streamable HTTP, per-user bearer-token auth, and a minimal server-rendered web UI shell.
- **Memory model** (`specs/memory-model/spec.md`): first-class `thoughts`, `people`, `tasks`, `facts`, `documents` (R2-backed Markdown with chunked embeddings, ADR-008), `projects`, and generic `time_series_points`, each with owner provenance where applicable; thoughts, facts, and document chunks are semantically searchable via Vectorize. Builds on the platform baseline; implemented by `tasks/PBI-002-memory-model.md` after PBI-001.

## Explicit Non-Scope For The Platform Baseline

- Public or multi-tenant signup.
- Rich media storage (images, audio, files).
- Chat-transcript ingestion or archival.
