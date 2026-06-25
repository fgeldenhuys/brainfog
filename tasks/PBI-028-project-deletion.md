# PBI-028: Project Deletion

## Directive

Add service, REST, and MCP support for deleting a project and unlinking all owned objects from it.

## Scope

- **Spec:** `specs/memory-model/spec.md`
- **Covers DoD items:** Follow-up to the existing project CRUD: `createProject`/`listProjects` exist but no delete path.
- **Out of scope:**
  - Cascade-deleting project-scoped objects (thoughts, tasks, facts, documents, time-series points). Instead, unlink them by setting `project_id` to null.
  - Adding project archive, restore, or soft-delete.
  - Changing project ownership or sharing.
  - Adding project-level access control beyond existing owner scoping.

## Dependencies

- Existing `createProject`/`listProjects` service functions in `apps/worker/src/memory.ts`.
- Existing `GET /projects` and `POST /projects` REST routes in `apps/worker/src/routes/api.ts`.
- Existing `create_project` and `list_projects` MCP tools in `apps/worker/src/mcp/index.ts`.
- ERD/schema: `packages/db/src/schema.ts` — `projects` table with foreign-key references from `thoughts`, `tasks`, `facts`, `documents`, `time_series_points`.

## Context

Projects can be created and listed but never deleted. When a project is no longer needed, its row and its `project_id` references on all scoped objects remain in D1 forever. The schema does not use `ON DELETE` foreign-key actions, so a direct `DELETE FROM projects` would either violate FK constraints or silently cascade into unintended row deletion depending on D1's FK enforcement mode.

The safest approach is to:
1. Verify the caller owns the project.
2. Unlink all owned objects that reference it by setting their `project_id` to null.
3. Delete all project-scoped dependency graph edges (if any).
4. Delete the project row.

## Intent Preservation

1. **Unlink, don't cascade-delete.** Setting `project_id` to null preserves the objects; their content, provenance, and recall behavior are unchanged.
2. **Owner-scoped.** Only the project owner can delete it. Other users' objects referencing the same project are left untouched (their `project_id` remains set).
3. **No deletion of non-project entities.** The scope of mutation is: the `projects` row itself plus `project_id` on owned `thoughts`, `tasks`, `facts`, `documents`, and `time_series_points`. Nothing else.
4. **No silent cascade.** Do not delete thoughts, tasks, facts, documents, or time series points. The caller must explicitly remove those first if desired.

## Implementation Plan

### 1. Add `deleteProject` Service Function

- Add in `apps/worker/src/memory.ts`:
  - Fetch project by id, verify ownership (`project.ownerId === ctx.user.id`).
  - Set `project_id = null` on all owned `thoughts`, `tasks`, `facts`, `documents`, and `time_series_points` that reference this project.
  - Delete the project row.
  - Return `{ ok: true }`.
- Use a D1 transaction (`ctx.env.DB.batch()`) to keep unlinks + delete atomic.

### 2. Add REST Endpoint

- Add `DELETE /api/v1/projects/:id` in `apps/worker/src/routes/api.ts`.
- Delegate to `deleteProject`.
- Return `{ ok: true }` with 200.

### 3. Add MCP Tool

- Add `delete_project(id)` MCP tool in `apps/worker/src/mcp/index.ts` alongside the existing `create_project` and `list_projects` tools.

### 4. Tests

- Test deleting an owned project with no scoped objects succeeds.
- Test deleting an owned project with scoped objects unlinks (not deletes) thoughts, tasks, facts, documents, and time series points.
- Test another user cannot delete a project they don't own.
- Test that a non-existent project id returns 404.
- Test that listed projects no longer include the deleted project.

## Verification

- `pnpm check && pnpm typecheck && pnpm test` pass.
- Targeted Worker tests demonstrate:
  - Owned project deletion with and without scoped objects.
  - Cross-owner project deletion is rejected.
  - Scoped objects survive with `project_id = null` after project deletion.

## Refinement Protocol

- If D1 FK enforcement mode prevents updating `project_id` to null on rows that reference a project being deleted, use separate updates before the delete within the same batch.
- If the UI or other tools depend on the project remaining in the list, surface that as a separate follow-up rather than blocking deletion.
