# ADR-002: D1 With Drizzle ORM

## Status

Accepted — 2026-06-12

## Context

D1 is Cloudflare's SQLite-based serverless database, bound directly to Workers (ADR-001). Brainfog needs typed schema definitions, migrations, and queries for memories, users, tokens, and supporting tables (projects/tags) as the memory model grows.

## Decision

We will use D1 as the canonical relational store, with Drizzle ORM and Drizzle Kit (`drizzle-orm/d1`) for schema definition, migrations, and typed queries against D1's SQLite dialect.

## Consequences

**Positive**
- Drizzle has first-class D1 support and a typed query builder, catching schema mistakes at compile time.
- Drizzle Kit generates SQLite-compatible migrations that can be applied to D1 via Wrangler.
- Shares the project's TypeScript toolchain (ADR-006) — no separate ORM-specific build step.

**Negative**
- D1/SQLite lacks some features available in server-based Postgres (no native arrays, limited JSON operators, single-writer semantics) — schema design must stay within SQLite's type system (TEXT/INTEGER/REAL/BLOB) and Drizzle's D1 dialect.
- D1 is not suited to high-concurrency write workloads; this is acceptable at brainfog's personal/small-group scale (VISION.md).

**Neutral**
- Local development uses D1's local SQLite emulation via Wrangler.
- Migrations apply to the single hosted D1 database (`ARCHITECTURE.md` invariant 7).

## Alternatives Considered

- **Raw SQL via D1's `prepare()`/`bind()` without an ORM:** rejected because it loses type safety and migration tooling for a schema that will grow beyond a handful of tables.
- **Prisma with a D1 driver adapter:** rejected because it adds build complexity and a heavier client than Drizzle's D1 integration, which matters for Worker bundle size.
- **KV as the primary store:** rejected because KV has no query, filter, or relational capability, which memories, tags, and provenance fields require.
