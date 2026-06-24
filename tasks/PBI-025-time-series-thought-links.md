# PBI-025: Time-Series Thought Links

## Directive

Allow users and agents to attach thoughts to specific time-series points, including Garmin activity points, through the existing `remember(..., links)` and `link(...)` compatibility APIs backed by dependency-graph `references` edges.

## Scope

- Spec: `specs/dependency-graph/spec.md`
- Covers DoD items: Extends the completed dependency-graph compatibility behavior for `remember` and `link` so thoughts can reference `time_series_point` dependencies in addition to people, tasks, facts, and documents, preserving the spec's owner validation, graph storage, and source-compatible compatibility wrapper intent.
- Out of scope:
- Creating a first-class `activities` table or Garmin-specific entity type.
- Changing Garmin ingestion output shape or re-ingesting existing Garmin data.
- User-page rendering of linked thoughts; that is PBI-026.
- New Cloudflare bindings, external APIs, or frontend routes.
- Cross-owner references beyond the existing sharing rules in `specs/sharing/spec.md`.

## Dependencies

- PBI-005 dependency graph implementation, especially `dependency_edges`, `createDependency`, `ensureEntity`, and owner/shared validation rules.
- PBI-012 time-series prefix/list behavior.
- PBI-019/PBI-020 Garmin connector work, which records Garmin activities as multiple `time_series_points` rows sharing `metadata.activity_id` / `metadata.external_activity_id`.
- ADR-002/D1 canonical storage and ADR-011/shared visibility rules.

## Context

Garmin activities are currently represented as multiple time-series metric rows such as `garmin.activities.duration`, `garmin.activities.distance`, and `garmin.activities.avg_heart_rate`. Each row has a D1 row id, and all rows for the same Garmin activity share metadata including `activity_id` and `activity_name`.

The dependency graph already allows `time_series_point` as an endpoint kind, and the generic `create_dependency` MCP tool can manually create a `thought -> time_series_point` edge. The missing piece is the ergonomic compatibility layer: `remember(..., links)` and `link(thought_id, links)` only accept `people_ids`, `task_ids`, `fact_ids`, and `document_ids` today.

For Garmin activity notes, the canonical dependency target should be one specific time-series point row for the activity. Prefer the `garmin.activities.duration` point when present because every activity has duration and it naturally represents the activity occurrence. Do not introduce a new entity table in this PBI.

## Intent Preservation

1. **Use graph edges, not new junction tables.** Thought-to-time-series links must be stored as `dependency_edges` with dependent `thought`, dependency `time_series_point`, and relationship `references`.
2. **Keep existing link shapes source-compatible.** Existing `links` payloads must continue working unchanged; `time_series_point_ids` is additive.
3. **Validate ownership before writing.** A caller must not be able to link a thought to another user's private time-series point.
4. **Preserve provenance.** Any created graph edge must carry the existing source context (`mcp:tool`, `rest:api`, etc.) through the dependency service.
5. **No Garmin-only coupling in generic memory APIs.** The API should support any time-series point id, not just Garmin rows.
6. **No duplicate thought content.** Do not store activity notes as time-series metadata or synthetic time-series rows when they are semantically thoughts.

## Implementation Plan

### 1. Confirm Current Link Service And Tool Schemas

- Read `AGENTS.md`, `ARCHITECTURE.md`, `specs/dependency-graph/spec.md`, and this PBI before editing.
- Inspect `apps/worker/src/memory.ts` around `applyThoughtLinks`, `validateThoughtLinks`, `remember`, and `linkThought`.
- Inspect `apps/worker/src/mcp/index.ts` and `apps/worker/src/routes/api.ts` for `remember` and `link` input schemas.
- Confirm `ensureEntity(ctx, "time_series_point", ...)` exists and uses the correct owner/shared-read rules before relying on it.
- Acceptance criteria:
- The implementor has identified all schema/type surfaces where the `links` object is validated.

### 2. Add `time_series_point_ids` To Thought Link Inputs

- File scope: `apps/worker/src/memory.ts`, `apps/worker/src/mcp/index.ts`, and REST route input handling if it has explicit schemas/types for thought links.
- Extend the thought links object to accept `time_series_point_ids?: string[]`.
- Update `validateThoughtLinks` to validate each id with `ensureEntity(ctx, "time_series_point", id, "time-series point link not found")` or the project-standard error wording.
- Update `applyThoughtLinks` to create `references` dependency edges from the thought to each time-series point id.
- Preserve existing behavior for people/tasks/facts/documents.
- Acceptance criteria:
- `remember` can create a thought linked to an existing owned time-series point in one call.
- `link` can add a time-series point reference to an existing thought.
- Existing link payloads remain valid.

### 3. Add Tests For Time-Series Thought Links

- File scope: likely `apps/worker/test/memory.test.ts` and, if MCP schemas are explicit, a focused MCP tool test.
- Add tests covering:
- `remember` with `links.time_series_point_ids` creates a `dependency_edges` row with relationship `references`.
- `link` with `time_series_point_ids` creates the same edge for an existing thought.
- Cross-owner private time-series point links are rejected.
- Duplicate link attempts remain idempotent or fail consistently with existing dependency unique-edge behavior; prefer matching current `createDependency` behavior.
- Existing people/task/fact/document link tests still pass.
- Acceptance criteria:
- Tests prove the new link type is available through the service and the MCP/REST surfaces that expose `remember`/`link`.

### 4. Optional Agent Ergonomics Note

- Do not add a new tool unless the current tool ergonomics are genuinely unusable.
- If a helper is needed later, prefer a separate PBI for an activity-oriented tool such as `remember_activity_note(activity_id, content)` after the page/UI behavior is proven.
- This PBI should document in tests or comments that Garmin notes should link to the canonical `garmin.activities.duration` point for the activity.

## Verification

- `pnpm check && pnpm typecheck && pnpm test` pass.
- Targeted Worker tests show `remember` and `link` can create `thought -> time_series_point` `references` edges.
- Targeted tests show cross-owner private time-series links are rejected.
- Manual MCP smoke, if low-cost: create a thought linked to a Garmin `garmin.activities.duration` point id and verify `list_dependencies(entity_kind="thought", entity_id=<thought>, direction="upstream", relationship="references")` includes the time-series point.

## Close-Out Checklist

- [x] `remember(..., links.time_series_point_ids)` is supported.
- [x] `link(thought_id, { time_series_point_ids })` is supported.
- [x] Thought-to-time-series links are dependency-graph `references` edges.
- [x] Owner/shared validation prevents private cross-owner links.
- [x] Tests cover service and exposed API/tool behavior.

Completion evidence: Implemented on 2026-06-24 by extending the thought-link compatibility layer to accept `time_series_point_ids`, validating points through the existing graph endpoint ownership/shared rules, and writing `thought -> time_series_point` `references` edges through `createDependency`. Added REST and MCP coverage for `remember` and `link`, including private cross-owner rejection and MCP provenance assertions. Verified with `pnpm check && pnpm typecheck && pnpm test` (12 test files, 253 tests passed). Critic review found no blocking issues; non-blocking note was that duplicate-edge behavior remains covered by the unchanged `createDependency(...).onConflictDoNothing()` path rather than a new time-series-specific duplicate test.

## Refinement Protocol

- If the implementation requires changing the dependency-graph Contract beyond the additive compatibility input, pause and ask before editing `specs/dependency-graph/spec.md`.
- If Garmin activity notes require first-class activity identity rather than linking to a canonical time-series point, split that into a separate spec/PBI instead of expanding this one.
- If existing `createDependency` behavior around duplicate edges is surprising, preserve current behavior and document it in tests rather than changing graph semantics here.

## Ship-PBI Log

- 2026-06-24: Implementation pass completed for `apps/worker/src/memory.ts`, `apps/worker/src/mcp/index.ts`, and `apps/worker/test/memory.test.ts`.
- 2026-06-24: Deterministic gates passed with `pnpm check && pnpm typecheck && pnpm test` (12 test files, 253 tests passed). Known non-blocking output: Cloudflare local AI/Vectorize warnings, sourcemap warnings, expected OAuth error logs, and Vitest close-timeout notice.
- 2026-06-24: Critic review found no blocking Contract, scope, intent-preservation, or brainfog-invariant issues. Non-blocking duplicate-link test gap accepted because duplicate semantics are unchanged and centralized in `createDependency`.
