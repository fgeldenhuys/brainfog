# brainfog

![brainfog](apps/worker/public/thinker.png)

Brainfog is a shared memory and context layer for AI-assisted work: a remote MCP server plus a REST API and a minimal web UI, deployed on Cloudflare Workers with D1, Vectorize, and R2. Claude and the people working with it use brainfog to write and recall durable context across sessions and projects.

## Start Here

- `VISION.md` — product direction, voice, and decision heuristics.
- `ARCHITECTURE.md` — system-wide constraints and boundaries.
- `AGENTS.md` — agent operating rules and toolchain.
- `docs/adrs/` — accepted architecture decisions.
- `specs/` — ASDLC feature contracts.
- `tasks/` — PBI format and lifecycle.

## Features

### Memory model

Seven first-class kinds, all owned per-user:

| Kind | Description |
|---|---|
| `thoughts` | Freeform notes, observations, and captured context |
| `facts` | Named key/value assertions (`subject`, `predicate`, `value`) |
| `people` | Contact and relationship records |
| `tasks` | Tracked work items with status and priority |
| `documents` | Long-form Markdown stored in R2, chunked and embedded for search |
| `projects` | Grouping and dependency container for other records |
| `time_series_points` | Timestamped numeric measurements keyed by `seriesKey` |

Thoughts, facts, and document chunks are semantically searchable via Cloudflare Vectorize.

Records can be linked with typed dependency edges (e.g. `depends_on`, `related_to`) and marked stale with a reason and timestamp.

### MCP server

Remote MCP over Streamable HTTP at `/mcp`. Tools available to agents:

- **Memory**: `remember`, `recall`, `record_fact`, `update_fact`
- **People**: `upsert_person`, `set_self_person`, `list_people`
- **Tasks**: `create_task`, `update_task`, `list_tasks`
- **Documents**: `add_document`, `update_document`
- **Projects**: `create_project`, `list_projects`
- **Time series**: `record_time_series_point`, `record_time_series_points` (bulk), `list_time_series_points` (with `series_prefix` filter)
- **Dependencies**: `create_dependency`, `delete_dependency`, `list_dependencies`, `list_stale`, `mark_stale`
- **Pages**: `create_page`, `update_page`, `get_page`, `list_pages`, `preview_page`, `create_page_access_link`, `list_page_access_links`, `revoke_page_access_link`
- **Misc**: `ping`, `whoami`, `link`, `set_shared`

### User pages

Dynamic, server-rendered pages with Mustache templates. Each page defines one or more named datasets (queries against the memory store) and a Handlebars/Mustache template that renders them.

**Query capabilities:**
- `kind`: any memory kind (`thoughts`, `time_series_points`, etc.)
- `filters`: `series_key`, `series_prefix` (LIKE filter on `seriesKey`), and more
- `limit`: up to 500 rows (higher limits available for pivot use cases)
- `transforms`: `pivot_by_date` (groups `time_series_points` rows by calendar date, one row per date with series suffixes as fields), `count`
- `display_formulas`: server-side computed fields using math expressions over row values

**`pivot_by_date` transform**: Collapses multiple time-series per date into one row. Series suffix (text after the first dot in `seriesKey`) becomes a field name. Notes are merged across the group (first non-empty wins). Enables combined tables for multi-series data.

Pages can be shared publicly via access links (random-token URLs, no auth required) or kept private.

### Auth

- Bearer token auth for MCP and API
- OAuth 2.0 provider (PKCE) at `/oauth/authorize` and `/oauth/token` for MCP client integrations
- Session cookie auth for the web UI

### Web UI

Server-rendered UI at `/app`:
- Browser: list, search, and view all memory records by kind
- Search: semantic search across thoughts, facts, and document chunks
- Metrics: time-series charting
- Pages: manage and preview user pages
- Users: admin user management

## Getting Started

```sh
pnpm install
cp apps/worker/.dev.vars.example apps/worker/.dev.vars   # fill in BRAINFOG_TOKEN_HASH_SECRET
pnpm db:migrate
pnpm --filter @brainfog/worker seed                       # creates a local user + bearer token
pnpm dev
```

`pnpm seed` prints the bearer token once — use it to authenticate `/api/v1/*` and `/mcp` requests, or sign in via the web UI at `http://localhost:8787`.

## Stack

- **Runtime**: Cloudflare Workers (Hono)
- **Database**: D1 (SQLite) via Drizzle ORM
- **Vector search**: Cloudflare Vectorize
- **Object storage**: R2
- **KV**: Cloudflare KV (OAuth state)
- **Workspace**: pnpm monorepo (`apps/worker`, `packages/db`, `packages/shared`)
