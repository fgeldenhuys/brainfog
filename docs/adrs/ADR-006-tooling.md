# ADR-006: TypeScript, pnpm, Biome, Vitest, Wrangler, Playwright

## Status

Accepted — 2026-06-12

## Context

Brainfog needs a small, low-maintenance toolchain for a Cloudflare Workers project with a server-rendered web UI: package management, linting/formatting, typechecking, unit and Worker-runtime tests, database migrations, and end-to-end smoke tests.

## Decision

We will use:

- pnpm as the only package manager, with pnpm workspaces.
- TypeScript in strict mode.
- Biome for lint and format.
- Vitest, with `@cloudflare/vitest-pool-workers`, for unit and Worker-runtime tests.
- Drizzle Kit for D1 schema and migrations (ADR-002).
- Wrangler for local development (Miniflare) and deployment.
- Playwright for web-UI end-to-end smoke tests.

## Consequences

**Positive**
- Biome (a single fast binary) replaces ESLint + Prettier.
- Vitest shares TypeScript configuration with application code and runs Worker-runtime tests via the official Cloudflare pool.
- pnpm workspaces enforce clean dependency boundaries as the project grows beyond one package.
- Wrangler gives local/production parity for Workers, D1, Vectorize, and Workers AI.

**Negative**
- Biome's rule set is narrower than ESLint's plugin ecosystem.
- Wrangler/Miniflare versions must track Cloudflare runtime updates to avoid local/production drift.

**Neutral**
- No npm, yarn, Bun, or competing lockfiles.
- Policy checks introduced by the platform baseline should reject package-manager drift and committed secrets.

## Alternatives Considered

- **npm or Yarn:** rejected because pnpm's strict, symlinked `node_modules` avoids phantom-dependency bugs as the workspace grows.
- **ESLint + Prettier:** rejected because Biome is faster, needs no plugin configuration for this TypeScript/Workers use case, and avoids ESLint/Prettier rule conflicts.
- **Jest:** rejected because Vitest shares Vite/TypeScript configuration natively and has first-class Cloudflare Workers pool support via `@cloudflare/vitest-pool-workers`.
- **Cypress:** rejected because Playwright has better multi-browser and viewport coverage for the minimal web UI's smoke tests.
