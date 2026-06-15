# PBI-010: Shared Visibility — Read Paths

## Directive

Implement the read-path changes from `specs/sharing/spec.md` to complete shared visibility: enable `recall`'s two-query merge with Vectorize metadata sync, add `OR shared = true` to REST list routes and dependency listing, and generalize `markDownstreamStale` to handle cross-owner staleness when entities are shared.

## Scope

- Spec: `specs/sharing/spec.md`
- Covers DoD items 6-8 (deferred from PBI-009):
  6. `recall`'s two-query (owner-scoped + shared-scoped) Vectorize merge/re-rank, with `shared` in vector metadata kept in sync via the cascade.
  7. `OR shared = true` on REST list routes for `projects`/`tasks`/`facts`/`documents`/`thoughts`/`time-series-points`, and on `list_dependencies`/`list_stale`.
  8. Generalize `markDownstreamStale` to mark cross-owner stale edges when the updated entity is `shared = true` (generalizing `markGlobalPersonDownstreamStale`).
- Out of scope: any further cascade or cross-owner rule work (completed in PBI-009); web UI affordance for toggling `shared` or displaying `cascaded` results; reverse/un-share cascades.

## Dependencies

- PBI-009 (items 1-5: `cascadeShare`, `setShared`, `entityExists`/`ensureEntity` position split, cross-owner reference rule, `shared` columns on schema and migration) — all of which this PBI's read-path changes depend on for the `shared` flag to exist and be settable.
- ADR-011 (`docs/adrs/ADR-011-shared-visibility.md`) — the decision guiding this PBI's read-path semantics.
- `specs/memory-model/spec.md` (PBI-002/004/008) — the six tables and their list routes, modified by this PBI to return `owner_id = caller OR shared = true` rows.
- `specs/dependency-graph/spec.md` (PBI-005) — `recall`, `list_dependencies`, `list_stale`, and `markDownstreamStale`, modified by this PBI to include shared-owned results.
- Vectorize metadata index on `shared` — **not yet created** as of PBI-009's close. PBI-009 added the D1 `shared` columns/migration but did not run `wrangler vectorize create-metadata-index` for `shared` (it isn't needed by DoD items 1-5). This PBI must create it (additive, matching the `owner_id`/`kind`/`project_id` indexes documented in `docs/notes/vectorize-setup.md`) before relying on `shared`-filtered Vectorize queries.

## Context

- PBI-009 implemented the write-side changes (schema, migration, cascade, cross-owner reference rule) and established the foundation (`shared` columns, `cascadeShare`, `setShared`, position-aware `entityExists`/`ensureEntity`). This PBI completes the read side.
- `recall`'s two-query approach (owner-scoped + shared-scoped Vectorize queries merged and re-ranked) is required because Vectorize metadata filters cannot express an OR across fields. The `recall` implementation should fetch results from both queries, merge them, sort by score (descending), de-duplicate by entity kind/id, and truncate to the limit.
- Vectorize metadata for `thoughts`, `facts`, and `document_chunks` includes `shared` (a chunk's vector uses its parent document's `shared`), kept in sync by PBI-009's cascade via re-upserting existing vectors with updated metadata (no re-embedding).
- REST list routes and `list_dependencies`/`list_stale` must apply `owner_id = caller OR shared = true` filtering at the database level to return caller-accessible rows.
- `markDownstreamStale` generalizes its existing per-caller scope: when the entity being marked is `shared = true` (or is a `person`, as today), mark stale edges across **all** owners pointing at it.

## Intent Preservation

- **Read access via `shared`**: the six shareable tables' list routes, `recall`, `list_dependencies`, and `list_stale` must return rows/edges visible to the caller per the `owner_id = caller OR shared = true` rule. Do not add write access (`shared` only widens reads).
- **Vectorize metadata sync**: when PBI-009's cascade sets `shared` on a `thought`/`fact`, the corresponding Vectorize vectors' metadata is re-upserted with `shared: true` (not re-embedded). This is a best-effort operation; if Vectorize's API changes or doesn't support metadata-only re-upsert, the cascade may fall back to re-embedding (which doesn't change semantics). A full Vectorize rebuild from D1 must reproduce correct `shared` metadata without re-running cascades (D1 canonical, Vectorize rebuildable per `ARCHITECTURE.md`).
- **`recall` re-ranking**: the two-query merge must re-rank by score (descending), de-duplicate, and truncate, so results remain order-stable and consistent with single-query behavior. The re-ranking is necessary because Vectorize cannot express the OR-filter natively.
- **Cross-owner stale propagation**: `markDownstreamStale` must mark all cross-owner edges pointing at a shared entity as stale (not just caller-scoped edges), matching the shared-visibility semantics. This applies when the dependency is `shared = true` or is a `person` (unchanged from today).
- **Regression guardrails**: with all existing rows' `shared = false` (the default), all current list/recall behavior is unchanged (the OR reduces to equality). Cross-owner stale marking applies only to cross-owner edges reachable via shared entities (per PBI-009's cross-owner rule) — no existing behavior changes for private data.

## Verification

- `pnpm test` covering: `recall` returns rows with `owner_id = caller OR shared = true` via merged/re-ranked two-query results; REST list routes for all six shareable types return only caller-accessible rows; `list_dependencies` and `list_stale` include edges where the caller owns the edge or either endpoint is caller-accessible; cross-owner stale propagation when updating a shared entity; Vectorize metadata `shared` field is re-upserted alongside PBI-009's cascade (or falls back to re-embed with re-embed tracking noted in this PBI's summary).
- `pnpm db:migrate` — no new migrations (PBI-009 covered all schema/index changes).
- `pnpm check && pnpm typecheck && pnpm test` all pass.

## Refinement Protocol

- If Vectorize's metadata re-upsert API changes or PBI-009's cascade already implements metadata sync correctly, no further changes needed — verify in testing that vectors' `shared` field reflects D1's `shared` column after cascade.
- If `recall`'s two-query merge reveals unexpected behavior (e.g., score inconsistency, deduplication edge cases), adjust the merge logic and document the trade-off.
- If anything here conflicts with `specs/sharing/spec.md` or ADR-011, the spec/ADR is authoritative — pause and ask before deviating, per `AGENTS.md`.

## Completion Evidence

Implemented entirely in `apps/worker/src/memory.ts` (289 insertions / 55 deletions) and `apps/worker/test/memory.test.ts` (+690 lines, 12 new tests). No schema/migration changes (PBI-009 covered all `shared` columns/indexes).

- `recall`: rewritten to issue two Vectorize queries — `filterA` (`owner_id = caller`, plus `kind`/`project_id`) and `filterB` (`shared = true`, plus the same `kind`/`project_id`) — merge matches by id keeping the highest score, sort descending, de-dupe, truncate to `limit`. `resolveRecallRows`'s D1 lookups (vector-match path and LIKE-fallback path) widened to `owner_id = caller OR shared = true` for thoughts/facts/document_chunks (the latter via parent `documents.shared`).
- New helper `resyncVectorSharedMetadata(ctx, vectorId)`: best-effort (`TEST_MIGRATIONS` short-circuit, try/catch), fetches the existing vector via `VECTORIZE.getByIds`, re-upserts the same values with `metadata.shared = true`. Wired into `cascadeShare` for thought/fact branches and, for documents, fanned out across all `document_chunks` of the document (also in the document_chunk→parent-document redirect branch). `remember`/`recordFact`/`insertChunks` now set `shared: false` in Vectorize metadata at create time; `updateFact` sets `shared: row.shared`.
- REST list routes (`listProjects`, `listTasks`, `listFacts`, `listThoughts`, `listDocuments`, `listTimeSeriesPoints`) and `projectIdForEntity`'s five per-kind branches: base owner filter changed to `or(eq(table.ownerId, ctx.user.id), eq(table.shared, true))`.
- `listDependencies`: `ensureEntity` position changed from `"dependent"` to `"dependency"` for the queried entity; dropped the `dependencyEdges.ownerId = caller` base filter; added an in-app `visibleEdges` filter keeping an edge if the caller owns it, or the non-queried endpoint is accessible (`entityExists(ctx, kind, id, "dependency")`).
- `markStale`: `ensureEntity` position changed from `"dependent"` to `"dependency"`.
- `listStale`: dropped the `ownerId = caller` base filter (queries across all owners), added an in-app `visibleRows` filter keeping a row if the caller owns the edge or either endpoint is accessible via `entityExists(ctx, kind, id, "dependency")`; existing `project_id` post-filter now applies to `visibleRows`.
- `markDownstreamStale` generalized (replacing `markGlobalPersonDownstreamStale`, which was removed): if the dependency is a `person` or has `shared = true`, mark stale edges across all owners; otherwise scope to `ownerId = caller` as before. `upsertPerson`'s call site updated to `markDownstreamStale(ctx, "person", input.id)`.
- `listTimeSeriesPoints`'s `subject_type`/`subject_id` branch: dropped the `dependencyEdges.ownerId = caller` filter from `graphFilters` — safe because the cross-owner reference rule guarantees `dependencyEdges.ownerId == timeSeriesPoints.ownerId` for `observes_subject` edges, and the point itself is already filtered to `owner_id = caller OR shared = true` via `filters[0]`, so this doesn't widen visibility beyond an already-accessible point's own edges.

**Testing**: 12 new tests across 4 `describe` blocks in the "Shared visibility" suite — recall two-query merge (cross-owner shared content + de-dup/re-rank), REST list routes returning shared rows for projects/tasks/facts/thoughts/documents/time-series-points, dependency-graph access via shared entities, cross-owner stale propagation (`markDownstreamStale` generalization including the spec's "Updating a shared entity marks cross-owner dependents stale" scenario), and Vectorize `shared` metadata re-sync (including document → chunk fan-out).

Final verification on 2026-06-15: `pnpm check && pnpm typecheck && pnpm test` passed (47 files checked, 0 errors/warnings; typecheck clean; 119/119 Vitest tests across 6 files, up from 107). `pnpm db:migrate` not required (no schema changes). Vitest's pre-existing post-run close-timeout warning persisted (unrelated to this PBI, noted in PBI-009's closeout too).

The Vectorize metadata index on `shared` (`wrangler vectorize create-metadata-index brainfog-vectors --propertyName shared --type boolean`) is created as part of this PBI's deploy step (see Ship-PBI Log) — required before `recall`'s `filterB` (`shared = true`) query returns results in production.

## Ship-PBI Log

- **Iteration 1, pass 1 (implementor)**: Implemented all four read-path areas — `recall` two-query merge + `resyncVectorSharedMetadata` wired into `cascadeShare`, `OR shared = true` on the six REST list routes and `projectIdForEntity`, `listDependencies`/`markStale`/`listStale` relaxed to `"dependency"`-position checks with in-app endpoint-accessibility filtering, and `markDownstreamStale` generalized (removing `markGlobalPersonDownstreamStale`).
- **Deterministic gate (after pass 1)**: `pnpm check && pnpm typecheck && pnpm test` (107/107, unchanged from PBI-009 baseline) all green — but no new tests had been added for this PBI's read-path changes.
- **Iteration 1, pass 1b (implementor, same pass — test coverage)**: Added 12 new tests to `apps/worker/test/memory.test.ts` covering recall's two-query merge, REST list routes' shared visibility, dependency-graph cross-owner access, cross-owner stale propagation, and Vectorize metadata sync. No changes to `memory.ts` were needed.
- **Deterministic gate (after pass 1b)**: `pnpm check && pnpm typecheck && pnpm test` (119/119) all green.
- **Critic report 1**: No blocking issues. Verified the two-query merge/re-rank/de-dup, the six list routes' and `projectIdForEntity`'s OR-filters, `listDependencies`/`listStale`'s OR-condition (edge owner, dependent-accessible, or dependency-accessible), the `markDownstreamStale` generalization (and full removal of `markGlobalPersonDownstreamStale`), and `resyncVectorSharedMetadata`'s wiring including document→chunk fan-out. Test coverage judged substantive (not smoke tests). Noted as a non-blocking operational reminder that the `shared` Vectorize metadata index must be created before `recall`'s shared-scoped query returns results in production.
- **Total**: 1 iteration (well within the 3-iteration budget). Proceeding to closeout via `close-pbi`.
