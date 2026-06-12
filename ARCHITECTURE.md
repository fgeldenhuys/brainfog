# ARCHITECTURE.md

System-wide constraints for brainfog. Anything in this file is binding across all features. Feature-specific rules live in `specs/<feature>/spec.md`. Decisions and rationale live in `docs/adrs/`.

## System Shape

```text
                    +-------------------------+
Claude / OpenCode -->| Remote MCP client       |
(Streamable HTTP)   +-------------------------+
                                |
                                | Bearer token
                                v
                    +-------------------------------------+
                    | Cloudflare Worker (Hono)             |
                    |  - /mcp   MCP server (McpAgent)      |
                    |  - /api/v1/*  REST routes            |
                    |  - /  minimal web UI (server-rendered)|
                    +--+-----------+-----------+-----------+
                       |           |           |
                       v           v           v
                  +---------+ +----------+ +-----------+
                  |   D1    | |Vectorize | | Workers AI|
                  | memory  |<-| index    |<-| embeddings|
                  | tables, | |(derived,  | |           |
                  | users,  | | rebuild-  | +-----------+
                  | tokens  | | able)     |
                  +----+----+ +-----------+
                       |
                       v
                  +---------+
                  |   R2    |
                  |document |
                  |content  |
                  |(ADR-008)|
                  +---------+
```

## Invariants

1. **Cloudflare is the sole deployment surface.** Workers host the MCP server, REST API, and web UI. D1, Vectorize, and Workers AI are the data/AI primitives. No other hosting provider or database is introduced without a superseding ADR.
2. **D1 is the canonical store for structured data.** Memory tables (`thoughts`, `people`, `tasks`, `facts`, `documents`, `document_chunks`, `projects`, `time_series_points`, and their junction/derivation tables — `specs/memory-model/spec.md`), users, and tokens live in D1. Nothing depends on Vectorize for data that D1 doesn't also hold. The one exception is full document content, which is canonical in R2 (ADR-008); D1 holds a reference (`documents.r2_key`) plus a derived, re-chunkable copy for recall.
3. **Vectorize is a derived, rebuildable index.** It stores embedding vectors for `thoughts`, `facts`, and `document_chunks` rows, keyed by `<kind>:<D1 row id>` (`specs/memory-model/spec.md`). It can be dropped and rebuilt from D1 at any time. Semantic search degrades gracefully (falling back to D1 keyword/tag lookup) if Vectorize is unavailable or out of sync.
4. **Every memory has provenance.** Each stored memory records its source (which agent/tool and which user/token wrote it), the project/scope it belongs to, and created/updated timestamps. Writes without provenance are rejected.
5. **MCP is the primary agent interface.** Claude and OpenCode read and write memories through MCP tools exposed at `/mcp` (Streamable HTTP). The REST API under `/api/v1/` backs the web UI and serves the same service layer as MCP — neither path bypasses the other's invariants.
6. **Auth is per-user bearer tokens.** Every request to `/mcp` and `/api/v1/*` (and the web UI) must carry a valid bearer token tied to a user record in D1. There is no public signup and no anonymous access.
7. **One hosted environment.** Brainfog has no separate hosted dev/staging/preview Cloudflare environment in the early stages. Local development uses Wrangler/Miniflare to emulate Workers, D1, Vectorize, Workers AI, and Durable Objects. Any configured Cloudflare resource is treated as the single production target until an ADR introduces environment separation.
8. **Worker API contracts are additive within a version.** REST routes live under `/api/v1/`; fields may be added but not removed or renamed without a new version once clients depend on them.
9. **Secrets never live in committed files.** Local secrets live in ignored `.dev.vars`; production secrets are Wrangler-managed. `.dev.vars.example` documents required variable names without real values.
10. **Memory content is text/structured JSON, plus R2-stored documents, in v1.** `documents` (Markdown, stored in R2 — ADR-008) is the one exception to "text/JSON in D1". No other binary or large media (images, audio, arbitrary file attachments) is stored. Expanding beyond Markdown documents requires a new ADR.

## Boundaries

- **Client (web UI) to data:** the web UI talks only to the Worker's REST API; it never queries D1 or Vectorize directly.
- **Agents to data:** Claude/OpenCode talk only to the `/mcp` MCP endpoint; they never receive D1 or Vectorize credentials.
- **D1 to Vectorize:** D1 is upstream of Vectorize. Writes go to D1 first; embedding generation and Vectorize upsert follow and may lag. A memory exists in D1 even if its Vectorize entry has not yet been written or has fallen out of sync.
- **MCP to REST:** both surfaces call the same internal service layer, so a memory written via MCP is immediately visible via REST and vice versa.
- **Brainfog to per-project ASDLC:** brainfog stores cross-project/cross-session memory. It does not own or duplicate any individual project's `specs/`, `docs/adrs/`, or `tasks/` — those remain that project's source of truth.

## Non-Goals

- Public or multi-tenant signup.
- Rich media storage (images, audio, binary file attachments). Markdown documents via R2 (ADR-008) are in scope; other media types are not.
- Ingesting or archiving full chat transcripts as a primary feature.
- Acting as a replacement for a project's own specs, ADRs, or PBIs.
- Real-time collaboration/presence features.

## Where To Look

- `AGENTS.md` — how agents work this project.
- `specs/` — feature contracts.
- `tasks/` — in-flight PBIs.
- `docs/adrs/` — decisions, immutable after acceptance.
- `docs/notes/` — mutable engineering and product notes.
