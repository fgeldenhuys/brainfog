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
