# AGENTS.md

> **Project:** brainfog — a shared memory/context layer for AI-assisted work. A remote MCP server plus REST API and minimal web UI, deployed on Cloudflare Workers, used by Claude and OpenCode (and the people working with them) to write and recall durable context across sessions and projects.
> **Core constraints:** Cloudflare-only deployment (Workers, D1, Vectorize, Workers AI, R2); D1 is the canonical store for structured data (R2 is canonical for document content, ADR-008), Vectorize is a derived/rebuildable semantic index; MCP (Streamable HTTP) is the primary agent interface; per-user bearer-token auth, no public signup; spec-first via ASDLC.

## Required Reading

- `VISION.md` — product vision, voice, taste references, and decision heuristics.
- `ARCHITECTURE.md` — system-wide invariants binding all features.
- `specs/<feature>/spec.md` — feature contract for the area being changed.
- `docs/adrs/` — accepted architecture decisions and their rationale.

## Naming

- **brainfog** — the project name, lowercase in prose and code.
- **`@brainfog/*`** — pnpm workspace package scope (e.g. `@brainfog/worker`, `@brainfog/db`, `@brainfog/shared`).
- **`BRAINFOG_`** — environment variable / secret name prefix.
- **Row IDs** — app-generated row IDs are lowercase typed brainfog IDs: `bf<20 lowercase Crockford Base32 chars><type suffix>`, per `specs/memory-model/spec.md`.

## Current Mode

**Platform baseline implemented.** `tasks/PBI-001-platform-baseline.md` has landed: the pnpm workspace, Worker (Hono), D1/Vectorize/Workers AI/R2 bindings, Drizzle `users`/`tokens` schema, shared bearer-token auth, `/mcp` scaffold, `/api/v1` scaffold, and the minimal web UI all exist and the toolchain below is runnable end-to-end.

- `specs/platform-setup/spec.md` defines the platform baseline contract (Definition Of Done checked off).
- `specs/memory-model/spec.md` defines the memory data model (`thoughts`, `people`, `tasks`, `facts`, `documents`, `document_chunks`, `projects`, `time_series_points`, and their links/derivations) that builds on the platform baseline; `tasks/PBI-002-memory-model.md` implements it next.
- The toolchain table below is the **current, working** command set.

## Toolchain

| Action | Command | Notes |
|---|---|---|
| Install | `pnpm install` | pnpm is the only supported package manager |
| Dev | `pnpm dev` | Wrangler dev server for the Worker (MCP + REST + web UI), with D1/Vectorize/AI bindings emulated via Miniflare |
| Build | `pnpm build` | Worker build/bundle check (`wrangler deploy --dry-run`) |
| Lint + format | `pnpm check` | Biome lint/format plus repo policy checks |
| Typecheck | `pnpm typecheck` | `tsc -b`, strict mode |
| Unit/Worker tests | `pnpm test` | Vitest, including `@cloudflare/vitest-pool-workers` for Worker-runtime tests |
| E2E tests | `pnpm test:e2e` | Playwright smoke tests against the web UI |
| DB migrate | `pnpm db:migrate` | Drizzle migrations against D1 (local via Wrangler, then the one hosted D1 database) |
| Seed | `pnpm --filter @brainfog/worker seed` | Creates a local dev user + bearer token (`apps/worker/scripts/seed.ts`) |
| Deploy | `pnpm run deploy` | `wrangler deploy`. Use `pnpm run deploy`, not bare `pnpm deploy` — pnpm's CLI reserves the `deploy` verb for its own "deploy to directory" command and will shadow the workspace script otherwise |

## Judgment Boundaries

**NEVER**
- Commit secrets, tokens, `.dev.vars` files, or real account ids.
- Add a route under `/mcp` or `/api/v1/` that skips bearer-token auth.
- Write a memory record without provenance (source agent/tool, user, project, timestamps).
- Treat Vectorize as the source of truth — D1 always wins; Vectorize is rebuildable.
- Use brainfog to duplicate or replace another project's `specs/`, `docs/adrs/`, or `tasks/`.

**ASK**
- Before introducing a new top-level dependency, a new Cloudflare product/binding, or any paid external API.
- Before changing a `spec.md` Contract section.
- Before changing the auth/token model or token issuance process.
- Before storing a new category of personal or sensitive data.

**ALWAYS**
- Open planned work as `tasks/PBI-XXX.md` pointing at exactly one `specs/<feature>/spec.md`.
- Run `pnpm check && pnpm typecheck && pnpm test` before requesting review once implementation code exists for the active PBI.
- Keep D1 as the source of truth; treat Vectorize as a derived index that can be rebuilt from D1.
- Record provenance (source, project, timestamps) on every memory write, via both MCP and REST paths.

## Context Map

- **Edge:** Cloudflare Workers (Hono) expose `/mcp` (MCP over Streamable HTTP via the `agents` SDK's `McpAgent`), `/api/v1/*` REST routes, and a server-rendered web UI.
- **Data:** D1 holds the memory model (`thoughts`, `people`, `tasks`, `facts`, `documents`, `document_chunks`, `projects`, `time_series_points`, and their junction/derivation tables — `specs/memory-model/spec.md`), users, and tokens; Drizzle owns schema and migrations.
- **Documents:** R2 stores full document content (`documents.r2_key`, ADR-008); D1 holds document metadata plus chunked text for recall.
- **Search:** Vectorize holds embedding vectors for `thoughts`, `facts`, and `document_chunks`, keyed by the D1 row ID itself; Workers AI generates embeddings on write, and Vectorize metadata carries `kind`.
- **Auth:** per-user bearer tokens (hashed in D1), checked by Worker middleware for MCP, REST, and web UI requests.
- **Agents:** Claude and OpenCode connect to `/mcp` as remote MCP clients over HTTPS with a per-user token.

See `ARCHITECTURE.md` for invariants and `docs/adrs/` for the decisions behind these choices.
