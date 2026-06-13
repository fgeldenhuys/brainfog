# PBI-001: Platform Baseline

## Directive

Stand up the brainfog platform baseline: a pnpm workspace containing a Cloudflare Worker (Hono) with D1, Vectorize, and Workers AI bindings; a Drizzle schema and migration for `users` and `tokens`; shared bearer-token auth middleware; an `/mcp` scaffold; an `/api/v1` REST scaffold; a minimal server-rendered web UI; and the full toolchain described in `AGENTS.md`.

## Scope

- Spec: `specs/platform-setup/spec.md`
- Covers DoD items: all items in `specs/platform-setup/spec.md`'s Definition Of Done — this is the first and currently only PBI for that spec.
- Out of scope:
  - Any memory model, `memories` table, or `remember`/`recall`/`search_memories` tools — these belong to a future spec.
  - Real semantic search behavior beyond declaring and smoke-testing the Vectorize/Workers AI bindings.
  - Provisioning a production Cloudflare account/environment — `pnpm deploy` should run without error, but a live deploy is not required if no account is configured (note which was done in the close-out).

## Dependencies

- ADR-001 through ADR-007 (all Accepted, no open questions).
- None of the work depends on another PBI — this is the first.

## Context

The repo currently contains only ASDLC documentation: `VISION.md`, `ARCHITECTURE.md`, `AGENTS.md`, `CLAUDE.md`, `README.md`, `docs/adrs/ADR-001` through `ADR-007`, and `specs/platform-setup/spec.md`. There is no `package.json`, `tsconfig.json`, `apps/`, or `packages/` yet — lightweight root tooling files (`package.json`, `pnpm-workspace.yaml`, `biome.json`, `.gitignore`, `.dev.vars.example`) may exist as placeholders; check before recreating, and extend rather than overwrite if present.

`AGENTS.md`'s "Current Mode: Planning" section describes the toolchain table as a *target* established by this PBI. Once this PBI lands and the toolchain is real, update that section of `AGENTS.md` to reflect that the baseline now exists (without removing the rest of `AGENTS.md`'s content).

## Intent Preservation

- D1 remains the canonical store (ADR-002); Vectorize and Workers AI bindings are declared and reachable (ADR-005) but not used for real memory data in this PBI — don't invent memory-related schema or endpoints ahead of their own spec.
- The bearer-token middleware (ADR-004) must be a single shared mechanism applied to both `/api/v1/*` (except `/api/v1/health`) and `/mcp` — do not write separate auth logic for REST vs. MCP.
- `/api/v1/health` must remain unauthenticated.
- No secrets committed: `.dev.vars` stays gitignored; `.dev.vars.example` documents variable names only, no real values.
- The web UI stays server-rendered Hono JSX (ADR-007) — no SPA framework or separate frontend build step.

## Verification

- `pnpm install` completes successfully.
- `pnpm check && pnpm typecheck && pnpm test` all pass. Test evidence must include Vitest/Miniflare Worker tests (via `@cloudflare/vitest-pool-workers`) covering the bearer-token middleware's three cases: missing token, invalid token, valid token.
- `pnpm test:e2e` passes, including a Playwright scenario for the web UI's token-entry flow on `/`.
- `pnpm db:migrate` applies the initial `users`/`tokens` migration cleanly against local D1 with no drift.
- `pnpm dev` brings up the Worker locally, and the following are confirmed (via test or manual check, recorded in the close-out):
  - `GET /api/v1/health` → `200` without an `Authorization` header.
  - `GET /api/v1/whoami` → `401` without a token, `200` with the seeded local token.
  - `/mcp` rejects a connection without a valid bearer token and accepts one with a valid token, exposing at least the placeholder tool.
- `pnpm build` and `pnpm deploy` run without error (deploy may be a dry-run/preview if no live Cloudflare account is configured — state which in the close-out).

## Refinement Protocol

- If anything in `specs/platform-setup/spec.md` proves ambiguous or infeasible as written (e.g. a Cloudflare binding behaves differently than expected), pause and flag it rather than silently deviating — the spec is the Contract and changes to it need explicit review.
- If implementation surfaces a need for a new dependency, Cloudflare product/binding, or paid API not already covered by ADR-001 through ADR-007, stop and follow `AGENTS.md`'s "ASK" rule before adding it.
- If the workspace layout (`apps/worker`, `packages/db`, `packages/shared`) needs adjustment for practical reasons, prefer adjusting within this PBI and note the change in the close-out summary rather than opening a new PBI for a pure layout tweak.
