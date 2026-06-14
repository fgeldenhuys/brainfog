# PBI-008: Global People Pool

## Spec

`specs/memory-model/spec.md`

## Goal

Make `people` a shared brainfog-wide entity pool instead of user-scoped memory, so every authenticated user can list, reference, and set their own `self_person_id` to the same canonical person records.

## Intent Preservation

- Preserve per-user scoping for user-authored memories (`thoughts`, `tasks`, `facts`, `documents`, `projects`, `time_series_points`) and their recall/search behavior.
- Remove owner filtering from `people` only; do not make other memory tables globally visible.
- Keep `users.self_person_id` as a user-specific pointer to a globally visible person.
- Keep provenance for person writes via `source` and timestamps; if `owner_id` remains during migration compatibility, it must not be used for visibility or self-person validation.
- Avoid introducing public or anonymous access. All MCP and REST access remains bearer-token authenticated.

## Scope

- Update `specs/memory-model/spec.md` so `people` is documented as a global authenticated pool rather than owner-scoped data.
- Update Drizzle schema and D1 migrations so current and future databases support global `people` visibility.
- Update memory service logic so `upsert_person`, `list_people`, `getSelfPerson`, `setSelfPerson`, person reference validation, thought-person links, dependency graph person endpoints, and time-series person subjects treat `people` as globally visible.
- Preserve owner scoping for all non-person entities and all embedded recall vectors.
- Update REST/MCP behavior and web UI expectations only where they read or write `people`/`self_person_id`.
- Add or update tests covering cross-user visibility of people and self-person assignment to a person created by another user.

## Out Of Scope

- Global visibility for projects, thoughts, tasks, facts, documents, document chunks, time-series points, or recall results.
- Public signup, anonymous access, or unauthenticated people endpoints.
- Person merge/deduplication workflows beyond using `upsert_person(id, ...)` on a known global person.
- Changing bearer-token authentication or token issuance.
- Adding a new Cloudflare product, external dependency, or non-D1 canonical store.

## Acceptance Criteria

- [x] `list_people()` returns the shared people pool to any authenticated user.
- [x] `set_self_person` accepts a globally visible person regardless of which authenticated user originally created it.
- [x] `get_self_person` returns the configured global person for the authenticated user.
- [x] Linking a thought to a person still requires the thought to be owned by the caller, but the person may be any global person.
- [x] Person dependency graph validation and display paths no longer reject global people because of `owner_id` mismatch.
- [x] Cross-user reads/writes remain rejected for every non-person memory table.
- [x] Existing hosted data can be migrated without losing current `people` rows.
- [x] Verification includes `pnpm check && pnpm typecheck && pnpm test`.

## Completion Evidence

Implemented in `specs/memory-model/spec.md`, `packages/db/src/schema.ts`, `packages/db/migrations/0005_global_people_pool.sql`, `packages/db/migrations/0003_dependency_graph.sql`, `apps/worker/src/memory.ts`, `apps/worker/src/mcp/index.ts`, and `apps/worker/test/memory.test.ts`.

Final verification on 2026-06-14: `pnpm check && pnpm typecheck && pnpm test` passed with 98 Vitest tests. Vitest still emitted the existing post-run close-timeout warning after all tests passed.

## Ship-PBI Log

- Iteration 1: Implemented global people visibility, self-person assignment to global people, global person validation for person references, a migration preserving existing people rows, and tests. Direct verification passed with `pnpm check && pnpm typecheck && pnpm test` (97 tests). Critic found that global person updates only marked the updater's dependency edges stale.
- Iteration 2: Added global-person downstream stale marking across all owners while keeping dependency reads owner-scoped, plus regression coverage. Direct verification passed with `pnpm check && pnpm typecheck && pnpm test` (98 tests). Critic confirmed the staleness fix and noted the migration file is untracked until commit/stage time; the file exists in the workspace and must be included with the journal update when committing.
