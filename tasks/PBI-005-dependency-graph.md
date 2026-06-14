# PBI-005: Dependency Graph

## Spec

`specs/dependency-graph/spec.md`

## Goal

Replace one-off relationship tables and fields with a generic owner-scoped dependency graph that can represent references, derivations, supersession, time-series subjects, and generated-document inputs, including stale dependency tracking.

## Scope

- Add the `dependency_edges` D1 schema and migration.
- Migrate existing thought links, fact derivation links, fact supersession pointers, and time-series subject references into graph edges.
- Remove redundant relationship tables and fields after migration.
- Update existing memory service/MCP/REST behavior to read and write dependency edges while preserving compatible request shapes where specified.
- Add dependency graph MCP tools and REST routes.
- Add staleness tracking for dependency-bearing relationships.
- Add tests required by the spec.

## Out Of Scope

- Automatically regenerating stale documents, facts, or future pages.
- Public graph sharing or cross-user dependency edges.
- Replacing `project_id`, `facts.status`, `facts.citations`, or `document_chunks.document_id`.
- Default UI graph visualization; that belongs in the UI PBI once the graph exists.

## Acceptance Criteria

- All Definition Of Done items in `specs/dependency-graph/spec.md` are satisfied.
- Regression guardrails in `specs/dependency-graph/spec.md`, `specs/platform-setup/spec.md`, and `specs/memory-model/spec.md` still hold.
- Verification includes `pnpm check && pnpm typecheck && pnpm test`.
