# Spec: Platform Baseline

## Blueprint

### Context

Brainfog currently has only ASDLC documentation (`VISION.md`, `ARCHITECTURE.md`, `AGENTS.md`, ADRs) and no code. This spec defines the target state of the platform baseline: a working pnpm workspace with a deployable Cloudflare Worker, a D1 database with its first tables, Vectorize and Workers AI bindings wired in (even before any memory features use them), a remote MCP scaffold, a REST scaffold, a minimal web UI scaffold, and per-user bearer-token auth enforced across all of it.

Nothing in this spec is about memories yet — that is a future spec built on top of this baseline. The goal here is that `pnpm install && pnpm dev` brings up a Worker where an authenticated request can reach `/api/v1/*`, `/mcp`, and `/`, and an unauthenticated request is rejected, using the toolchain and bindings established in ADR-001 through ADR-007.

PBI-001 (`tasks/PBI-001-platform-baseline.md`) implements this spec.

### Architecture

- **API Contracts**:
  - `GET /api/v1/health` — unauthenticated health check, returns `200 { "status": "ok" }`. Used for uptime checks; must remain unauthenticated.
  - `GET /api/v1/whoami` — requires `Authorization: Bearer <token>`. Returns `401` if the token is missing or invalid; otherwise returns `200` with the authenticated user's `id` and `name` from D1.
  - `/mcp` — MCP server scaffold (Streamable HTTP via the `agents` SDK `McpAgent`, per ADR-003), exposing at least one placeholder tool (e.g. `ping`). Connections without a valid bearer token are rejected.
  - `GET /` — minimal Hono JSX page (ADR-007). Prompts for a bearer token if none is stored; once a valid token is submitted, stores it in a cookie and shows the authenticated user's name on subsequent loads.

- **Data Models** (D1, via Drizzle — ADR-002):
  - `users`: `id` (primary key), `name`, `created_at`.
  - `tokens`: `id` (primary key), `user_id` (foreign key to `users.id`), `token_hash`, `created_at`, `last_used_at`.
  - No `memories` table yet — schema and provenance fields for memories are out of scope for this spec.

- **Dependencies**:
  - Workspace: `apps/worker` (the Cloudflare Worker), `packages/db` (Drizzle schema, migrations, D1 client setup), `packages/shared` (shared types/utilities), per the `pnpm-workspace.yaml` layout from ADR-006.
  - Runtime deps: `hono`, `agents` (Cloudflare Agents SDK), `drizzle-orm`.
  - Dev deps: `typescript`, `@cloudflare/workers-types`, `@biomejs/biome`, `drizzle-kit`, `wrangler`, `vitest`, `@cloudflare/vitest-pool-workers`, `@playwright/test`.
  - Cloudflare bindings declared in the Worker's Wrangler config: D1 database, Vectorize index, Workers AI (ADR-001, ADR-005) — Vectorize and Workers AI are bound and reachable in this baseline even though no feature uses them yet, so later memory work doesn't start with a binding/config gap.

- **Constraints**:
  - Cloudflare is the only deployment surface (ADR-001) — no other hosting, database, or queue.
  - D1 is canonical; any data this baseline stores (`users`, `tokens`) lives in D1 via Drizzle migrations, never hand-edited (ADR-002).
  - `/api/v1/*` (except `/api/v1/health`) and `/mcp` are protected by the same bearer-token middleware (ADR-004), backed by the `tokens` table.
  - `/` uses server-rendered Hono JSX, no client-side framework or separate build step (ADR-007).
  - Toolchain commands match `AGENTS.md`'s toolchain table exactly: `pnpm install`, `pnpm dev`, `pnpm build`, `pnpm check`, `pnpm typecheck`, `pnpm test`, `pnpm test:e2e`, `pnpm db:migrate`, `pnpm deploy` (ADR-006).
  - No secrets committed; `.dev.vars` is gitignored and `.dev.vars.example` documents required variable names only (`ARCHITECTURE.md` invariant 9).

## Contract

### Definition Of Done

- [x] pnpm workspace exists at the repo root with `apps/worker`, `packages/db`, and `packages/shared`, matching `pnpm-workspace.yaml`.
- [x] `apps/worker` is a Hono-based Cloudflare Worker with a Wrangler config declaring D1, Vectorize, and Workers AI bindings.
- [x] `packages/db` contains the Drizzle schema for `users` and `tokens`, drizzle-kit config targeting D1, and an initial migration that creates both tables.
- [x] `GET /api/v1/health` returns `200 { "status": "ok" }` without requiring authentication.
- [x] `GET /api/v1/whoami` returns `401` without a valid bearer token, and `200` with the user's `id` and `name` when given a valid token.
- [x] `/mcp` is reachable over Streamable HTTP via the `agents` SDK `McpAgent`, exposes at least one tool, and rejects connections without a valid bearer token.
- [x] `/` renders a minimal page that accepts a bearer token, stores it as a cookie, and then displays the authenticated user's name on reload.
- [x] A documented seed step (script or migration) creates at least one local development user and token, referenced from `README.md` or `AGENTS.md`.
- [x] `pnpm install`, `pnpm dev`, `pnpm build`, `pnpm check`, `pnpm typecheck`, `pnpm test`, `pnpm test:e2e`, `pnpm db:migrate`, and `pnpm deploy` all run successfully as described in `AGENTS.md`.
- [x] `pnpm test` includes Vitest tests (via `@cloudflare/vitest-pool-workers`) covering the bearer-token middleware: missing token, invalid token, and valid token.
- [x] `pnpm test:e2e` includes a Playwright smoke test covering the web UI's token-entry flow.
- [x] `.dev.vars.example` documents all required local environment variable names without real values, and `.dev.vars` is gitignored.

### Regression Guardrails

- The bearer-token middleware must reject requests with a missing or invalid token on every route under `/api/v1/*` (except `/api/v1/health`) and on `/mcp`. Any route added to these groups in a future PBI must remain covered by this same middleware and its tests.
- `GET /api/v1/health` must remain reachable without authentication. It must not be moved behind auth without updating this spec.
- D1 schema changes must always go through a Drizzle migration (`pnpm db:migrate`); the hosted D1 database must never be edited by hand.

### Scenarios

```gherkin
Feature: Platform baseline

  Scenario: Health check is reachable without authentication
    Given the brainfog Worker is running
    When a client sends GET /api/v1/health
    Then the response status is 200
    And the response body indicates the service is healthy

  Scenario: Protected REST route rejects requests without a token
    Given the brainfog Worker is running
    When a client sends GET /api/v1/whoami without an Authorization header
    Then the response status is 401

  Scenario: Protected REST route accepts a valid bearer token
    Given a user and a valid token exist in D1
    When a client sends GET /api/v1/whoami with "Authorization: Bearer <token>"
    Then the response status is 200
    And the response body contains the user's id and name

  Scenario: MCP endpoint requires a valid bearer token
    Given the brainfog Worker is running
    When an MCP client connects to /mcp without a valid bearer token
    Then the connection is rejected with an authentication error

  Scenario: Web UI accepts a token and remembers the session
    Given a user and a valid token exist in D1
    When a person opens the brainfog web UI and submits the token
    Then the page shows the authenticated user's name
    And a subsequent page load remains authenticated via the stored cookie
```
