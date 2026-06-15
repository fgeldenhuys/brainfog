# PBI-009: Shared Visibility

## Directive

Implement `specs/sharing/spec.md`: add a `shared` flag to the owner-scoped memory tables, a `set_shared` tool/route with cascade-on-share, the cross-owner reference rule for `dependency_edges`/`project_id`, and the resulting `OR shared = true` read-path changes — so a user can mark a project (or any record) shared and have its contents and dependencies become visible to, and buildable-on by, other authenticated users.

## Scope

- Spec: `specs/sharing/spec.md`
- Covers DoD items 1-5 (PBI-009 deliverables):
  1. `shared` column + index + migration on `projects`, `tasks`, `facts`, `documents`, `thoughts`, `time_series_points`.
  2. `set_shared(entity_kind, entity_id, shared)` MCP tool and `POST /api/v1/shared` REST route, owner-only, returning `cascaded: { kind, id }[]` on `shared: true`.
  3. Cascade-on-share algorithm: project containment (one-way) + `dependency_edges` traversal, cycle-safe, terminating at `person` nodes and already-shared entities.
  4. Cross-owner reference rule for `createDependency` and `project_id`-setting paths, including `person`/`document_chunk` exemptions, contagion to the dependent, and `cascaded: { kind, id }[]` reporting (matching `set_shared`'s shape) when contagion triggers.
  5. `entityExists`/`ensureEntity` `"dependent" | "dependency"` position split; `ensureProject` uses `"dependency"` semantics.
- Deferred to PBI-010 (read-path changes):
  6. `recall`'s two-query (owner-scoped + shared-scoped) Vectorize merge/re-rank, with `shared` in vector metadata kept in sync via the cascade.
  7. `OR shared = true` on REST list routes for `projects`/`tasks`/`facts`/`documents`/`thoughts`/`time-series-points`, and on `list_dependencies`/`list_stale`.
  8. Generalize `markDownstreamStale` to mark cross-owner stale edges when the updated entity is `shared = true` (generalizing `markGlobalPersonDownstreamStale`).
- Out of scope: any web UI affordance for toggling `shared` or displaying `cascaded` results (follow-up PBI if wanted); reverse/un-share cascades or reference-counted shares (explicitly rejected by ADR-011); real-time collaboration/presence (`ARCHITECTURE.md` non-goal, unaffected by this PBI).

## Dependencies

- ADR-011 (`docs/adrs/ADR-011-shared-visibility.md`) — the decision this PBI implements.
- `specs/memory-model/spec.md` (PBI-002/004/008) — the six tables this PBI adds `shared` to, and their list routes.
- `specs/dependency-graph/spec.md` (PBI-005) — `dependency_edges`, `entityExists`/`ensureEntity`, `createDependency`, `markDownstreamStale`/`markGlobalPersonDownstreamStale`, `list_dependencies`, `list_stale`, all modified by this PBI.
- No new Cloudflare bindings or npm packages. One additive Vectorize metadata index (`shared`) is created via `wrangler vectorize create-metadata-index` (does not require recreating the index, unlike ADR-010's dimension change).

## Context

- The product intent is collaboration: multiple authenticated users working on the same project, with each other's tasks, research (facts/documents/thoughts), and time-series observations visible once shared. `specs/sharing/spec.md`'s Context section and ADR-011 capture the full reasoning; this PBI is the implementation of both.
- `specs/memory-model/spec.md` and `specs/dependency-graph/spec.md` have already been amended (Regression Guardrails/Constraints) to cross-reference `specs/sharing/spec.md` rather than contradict it — read those amendments alongside the sharing spec.
- `apps/worker/src/memory.ts` already has a precedent for cross-owner staleness: `markGlobalPersonDownstreamStale`. This PBI generalizes that function's approach to "any entity with `shared = true`", with `person` becoming one case of the general rule.
- The next migration file is `packages/db/migrations/0006_*.sql` (current latest is `0005_global_people_pool.sql`).

## Intent Preservation

- **Monotonic cascade**: `set_shared(..., true)` only ever sets `shared = true`; `set_shared(..., false)` only flips the target row's own flag and never retracts cascaded shares elsewhere. Do not add reference-counting or reverse propagation.
- **`person` and `document_chunk`-via-parent-`document` exemptions**: referencing a global person, or a document_chunk through its parent document, must never itself flip the referencing row's `shared` to `true`. This is what keeps sharing opt-in given how common person links are.
- **Position-aware `entityExists`/`ensureEntity`**: the entity being created/updated (`"dependent"`) is always strictly `owner_id = caller`; only the referenced entity (`"dependency"`, including `ensureProject`'s `project_id` target) gets the `OR shared = true` relaxation. Do not relax the dependent-side check — that would let a caller attach edges to rows they don't own.
- **Write/delete authorization is unchanged**: `shared` only ever widens read access. Every mutation path (including `set_shared` itself) remains `owner_id = caller`, strict.
- **D1 canonical / Vectorize rebuildable**: the cascade only writes D1 `shared` columns (plus a best-effort Vectorize metadata re-upsert for embedded rows). A full Vectorize rebuild from D1 must reproduce correct `shared` metadata without re-running any cascade.
- **`cascaded` response field**: surfacing the blast radius of a share is part of the contract (ADR-011's negative consequence about irreversible cascades needing to be visible) — don't drop it as an implementation simplification. This applies to `set_shared` *and* to `create_dependency`/`project_id`-setting calls that trigger contagion (the latter includes the dependent itself in `cascaded`, since its own `shared` flip is also a side effect the caller didn't directly request).

## Verification

- `pnpm test` (Vitest/Miniflare) covering: cascade from a shared project through `project_id` containment and transitive `dependency_edges` (including a cycle); cross-owner `dependency_edges`/`project_id` creation rejected when the target isn't shared and allowed-with-contagion when it is; `person`/`document_chunk` exemptions from contagion; `set_shared` owner-only enforcement, `cascaded` reporting, and `false` not retracting prior cascades. (Note: `OR shared = true` visibility in `recall`, REST list routes, `list_dependencies`, and `list_stale`, plus cross-owner stale propagation, are deferred to PBI-010.)
- `pnpm db:migrate` — new `0006_*` migration applies cleanly with no drift.
- `pnpm check && pnpm typecheck && pnpm test` all pass.

## Completion Evidence

Implemented in `packages/db/src/schema.ts`, `packages/db/migrations/0006_shared_visibility.sql`, `apps/worker/src/memory.ts`, `apps/worker/src/mcp/index.ts`, `apps/worker/src/routes/api.ts`, and `apps/worker/test/memory.test.ts`. Spec amendments landed in `specs/sharing/spec.md` (DoD items 1-5 marked complete; 6-8 remain for PBI-010), `specs/memory-model/spec.md`, `specs/dependency-graph/spec.md`, and `ARCHITECTURE.md`. ADR-011 recorded in `docs/adrs/ADR-011-shared-visibility.md`.

Final verification on 2026-06-15: `pnpm check && pnpm typecheck && pnpm test` passed (47 files checked, 0 errors/warnings; typecheck clean; 107/107 Vitest tests across 6 files). `pnpm db:migrate` reported "No migrations to apply!" for both local and remote D1 — migration `0006_shared_visibility.sql` was already applied during implementation. Vitest emitted the existing post-run close-timeout warning after all tests passed (pre-existing, unrelated to this PBI).

DoD items 6-8 (recall two-query merge, `OR shared = true` on list routes/`list_dependencies`/`list_stale`, generalized `markDownstreamStale`) are tracked in `tasks/PBI-010-shared-visibility-read-paths.md` and remain unimplemented.

## Scope Split Note

DoD items 6-8 (read-path changes: `recall` two-query merge, `OR shared = true` on list routes/dependency queries, and cross-owner stale propagation generalization) have been deferred to PBI-010 (`tasks/PBI-010-shared-visibility-read-paths.md`) to keep the write-side changes (items 1-5) in one, testable unit. PBI-010 builds on PBI-009's schema, cascade, and cross-owner reference rule and carries forward the Intent Preservation constraints around D1-canonical/Vectorize-rebuildable semantics and cascaded response transparency that apply to the read paths.

## Refinement Protocol

- If Vectorize's API doesn't support a metadata-only re-upsert without supplying vector values (per `specs/sharing/spec.md`'s assumption that existing values can be fetched and re-upserted), check whether `getByIds`/equivalent returns values; if not, fall back to re-embedding cascaded rows' existing content (no semantic change, just a re-embed) and note this discrepancy in the PBI rather than silently dropping the metadata-sync requirement.
- If the full read-path sweep (`recall`, all list routes, `list_dependencies`, `list_stale`, `markDownstreamStale`) is too large to verify in one pass alongside the schema/cascade/cross-owner-rule work, split it into a follow-up PBI (e.g. PBI-010 for the read-path changes) and note the split here — but keep the cross-owner reference rule (DoD item 4) and its `entityExists` plumbing (item 5) together with the schema/cascade work, since the cross-owner rule's validation depends on the `"dependency"`-position check existing.
- If anything here conflicts with `specs/sharing/spec.md` or ADR-011, the spec/ADR is authoritative — pause and ask before deviating, per `AGENTS.md`.

## Ship-PBI Log

- **Iteration 1, pass 1 (implementor)**: Implemented schema/migration (`0006_shared_visibility.sql`), `setShared`/`cascadeShare`, `createDependency`'s cross-owner reference rule, position-aware `entityExists`/`ensureEntity`, and 7 new tests. Deferred DoD items 6-8 to a follow-up PBI per the Refinement Protocol, but did not yet create that PBI or update this file's Scope.
- **Deterministic gate (after pass 1)**: `pnpm check` FAILED — 2 Biome format errors plus 22 new `noExplicitAny`/`noNonNullAssertion` lint warnings, all in code/tests added by this PBI. `pnpm typecheck`/`pnpm test` (106/106)/`pnpm db:migrate` were green.
- **Iteration 1, pass 2 (implementor, gate-fix pass)**: Ran `biome check --write`, replaced `any`/non-null-assertion usages in `memory.ts` (`getEntityOwner`/`getEntityShared`/`cascadeShare`/`createDependency`/`setShared`) with proper types following the existing `entityExists` precedent, and replaced `json<any>` in the new tests with the file's established `json<{...}>` shape convention. Also did the PBI split bookkeeping: created `tasks/PBI-010-shared-visibility-read-paths.md` (DoD items 6-8) and added this file's "Scope Split Note", narrowing Scope to items 1-5.
- **Deterministic gate (after pass 2)**: `pnpm check && pnpm typecheck && pnpm test` (106/106) and `pnpm db:migrate` all green.
- **Critic report 1**: One blocking issue — DoD item 4's cross-owner reference rule was incomplete for `project_id`-setting paths (only `createDependency`'s contagion was implemented; `ensureProject`'s cross-owner-shared-project case didn't mark the referencing entity `shared = true`, run the cascade, or report `cascaded`). Spec Gherkin scenario 6 ("Assigning project_id to a shared project shares the new row") was untested. No other blocking issues; split into PBI-010 judged sound.
- **Iteration 2 (implementor)**: Added `applyProjectContagion` helper (mirrors `createDependency`'s contagion logic: same-owner → no-op, cross-owner — always `shared = true` by the time `ensureProject` succeeds — → mark entity shared, run `cascadeShare`, return `cascaded` including the entity itself) and wired it into all 6 `ensureProject` call sites (`createTask`, `updateTask`, `remember`, `recordFact`, `addDocument`, `recordTimeSeriesPoint`). Added the scenario-6 test.
- **Deterministic gate (after iteration 2)**: `pnpm check && pnpm typecheck && pnpm test` (107/107) and `pnpm db:migrate` all green.
- **Critic report 2**: No blocking issues. `applyProjectContagion` correctly implements the spec's cross-owner `project_id` rule across all 6 call sites, `updateTask`'s guard fires only when `project_id` changes, `recordTimeSeriesPoint`'s dependency-vs-project contagion ordering is a sound non-duplicating optimization, and the new test correctly exercises scenario 6. Noted (non-blocking) that `listDependencies`/`markStale` still use strict `"dependent"`-position `entityExists` checks — appropriate for PBI-009's write-side scope, to be relaxed in PBI-010's read-path work.
- **Total**: 2 iterations (well within the 3-iteration budget). Proceeding to closeout via `close-pbi`.
