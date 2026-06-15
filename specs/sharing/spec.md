# Spec: Shared Visibility

## Blueprint

### Context

Every owner-scoped table in `specs/memory-model/spec.md` is currently visible only to its `owner_id` (the sole exception is `people`, made a global authenticated pool by ADR/PBI-008). This spec implements ADR-011: a generic `shared` flag that lets any owner make a row of theirs readable by every authenticated user, plus the propagation rules that make "share a project" actually share the project's contents and everything they depend on, and that let collaborators build on each other's shared work.

The real intent is collaboration: multiple authenticated users working on the same project, with each other's tasks, research (facts/documents/thoughts), and time-series observations visible as a group. Per `ARCHITECTURE.md`'s "Real-time collaboration/presence features" non-goal, this spec covers asynchronous read visibility only — every row keeps exactly one `owner_id` and only that owner can write or delete it. "Working together on a project" means each collaborator's own contributions (scoped to the shared project, or referencing its shared contents) become visible to the rest of the group, not joint editing of one row.

This spec builds on `specs/memory-model/spec.md` (the six owner-scoped tables that gain `shared`) and `specs/dependency-graph/spec.md` (`dependency_edges`, `entityExists`/`ensureEntity`, `markDownstreamStale`, `list_dependencies`, `list_stale`). It amends the cross-owner restrictions in both: see "Amendments" below. PBI-009 (`tasks/PBI-009-shared-visibility.md`) implements this spec.

### Amendments To Existing Specs

- `specs/memory-model/spec.md`'s Regression Guardrail "All new tables and routes except `people` must enforce `owner_id` scoping — no non-person query in this spec may return or modify another user's rows, even when given a valid ID" is narrowed to **modify**: `shared = true` rows remain readable (not modifiable) cross-owner, per this spec.
- `specs/dependency-graph/spec.md`'s constraint "All graph writes validate `owner_id` on both endpoints. No edge may connect objects owned by different users" is replaced by the cross-owner reference rule below. The Regression Guardrail "The graph must never become a cross-user side channel; every edge endpoint is owner-validated before write and before read" is preserved in spirit: an edge can only ever reach a non-owned entity that is itself `shared = true`.

### Architecture

- **Data Model**:
  - A `shared` boolean column (`integer`, mode `boolean`, `NOT NULL DEFAULT false`) is added to `projects`, `tasks`, `facts`, `documents`, `thoughts`, and `time_series_points`, each with its own index (`<table>_shared_idx`).
  - `document_chunks` get no column of their own; a chunk's effective `shared` is its parent `documents.shared`.
  - `people` are unaffected — already global per ADR/PBI-008.
  - `dependency_edges` get no column; an edge's visibility is derived from its endpoints (see Read Paths below). `dependencyEdges.ownerId` continues to mean "who created this edge" and is unaffected.

- **`set_shared` — direct marking**:
  - New MCP tool `set_shared(entity_kind, entity_id, shared)` and REST route `POST /api/v1/shared` (body `{ entity_kind, entity_id, shared }`), authenticated, mirroring the `entity_kind`/`entity_id` dispatch already used by `mark_stale`/`list_dependencies`.
  - `entity_kind` is one of `project`, `task`, `fact`, `document`, `thought`, `time_series_point` (the kinds that carry `shared`). `person`, `document_chunk`, and `dependency_edge` are rejected with `400`.
  - The entity must be owned by the caller (`owner_id = caller`, **not** `OR shared = true` — only an owner can change their own row's visibility). Not found / not owned → `404`.
  - Setting `shared = true` runs the cascade below and returns the updated entity plus `cascaded: { kind, id }[]` — every other entity newly marked `shared = true` as a result, so callers (and the UI) can surface the blast radius of the action.
  - Setting `shared = false` only flips the target row's own flag. It does not walk the cascade in reverse and does not affect any row previously marked `shared = true` by a prior cascade.

- **Cascade-on-share** (triggered by `set_shared(..., true)`, and by the cross-owner reference rule below):
  - Maintain a visited set, seeded with the target entity. Process a FIFO queue, starting with the target:
    1. Dequeue an entity. If its `shared` is already `true` and it is not the original target, skip (already processed by a prior cascade — stop expanding here).
    2. Set `shared = true` on the entity (for a `document_chunk`, this means setting it on its parent `document`, then continuing the walk from that `document`).
    3. **Containment** (only when the entity is a `project`): enqueue every row in `tasks`, `facts`, `documents`, `thoughts`, `time_series_points` with `project_id` equal to this project's id. This direction is one-way — marking a non-project entity shared never marks its own `project_id` project shared.
    4. **Graph dependencies** (for every entity, including `project`): enqueue every `dependency_kind`/`dependency_id` reached by `dependency_edges` where this entity is `dependent_kind`/`dependent_id`.
    5. `person` entities are cascade-terminal: they may appear as a dependency target (step 4) but are not marked (no `shared` column) and are not expanded further. This bounds the cascade to the originating owner's data plus whatever has already been deliberately shared by others (reached only via the cross-owner rule below, which is itself gated on `shared`).
  - For every `thoughts`/`facts`/`document_chunks` row whose effective `shared` changes to `true` during this walk, the corresponding Vectorize vector's metadata is updated to include `shared: true` (re-upserting the existing vector values with updated metadata; re-embedding is not required since the text content hasn't changed).

- **Cross-owner reference rule** (`dependency_edges` and `project_id`):
  - A reference from entity A (the `dependent` in `createDependency`, or the row being created/updated with a `project_id`) to entity B (the `dependency`, or the referenced `project`) is validated as:
    - A is always required to be owned by the caller (`owner_id = caller`) — unchanged. You can only attach new edges/`project_id`s to your own rows.
    - If `B.owner_id == A.owner_id`: allowed, unchanged from today.
    - If `B.owner_id != A.owner_id`: allowed only if `B.shared == true`. If allowed, `A.shared` is set to `true` (if not already) and the cascade above runs from A.
    - `person` dependencies are exempt from the owner check entirely (unchanged, global) and from the "A becomes shared" side effect.
    - `document_chunk` dependencies are validated using their parent `document`'s `owner_id`/`shared`: a reference to a chunk of a cross-owner document is allowed exactly when a reference to that document itself would be (i.e., the document is `shared = true`), and rejected otherwise. When allowed, it is additionally exempt from the "A becomes shared" side effect — referencing a chunk of a document you don't own doesn't itself need to share your row; only referencing the *document* directly does.
  - `entityExists`/`ensureEntity` (`apps/worker/src/memory.ts`) take a `position: "dependent" | "dependency"` argument: `"dependent"` checks `owner_id = caller` only (no change); `"dependency"` checks `owner_id = caller OR shared = true` (`person` always true, `document_chunk` via parent `document`). `ensureProject` uses `"dependency"` semantics for the referenced project.
  - **Cascade transparency for contagion**: when a cross-owner reference (via `create_dependency` or a `project_id`-setting call) triggers A's `shared` flag per the rule above, the response includes `cascaded: { kind, id }[]` — the same shape `set_shared` returns — listing every entity (including A itself) newly marked `shared = true` as a result. The field is omitted (or empty) when no contagion occurs. This mirrors `set_shared`'s transparency requirement (ADR-011's "needs to be visible to users" consequence) for the contagion path, not just the direct-marking path.

- **Read paths — `owner_id = caller OR shared = true`**:
  - `recall(query, kinds?, project_id?, limit?)`: Vectorize metadata for `thoughts`/`facts`/`document_chunks` gains `shared` (a chunk's vector uses its parent document's `shared`, as it already does for `owner_id`/`project_id`). Because Vectorize metadata filters cannot express an OR across fields, `recall` issues two Vectorize queries — one filtered by `owner_id = caller` (plus any `kinds`/`project_id` filters), one filtered by `shared = true` (plus the same `kinds`/`project_id` filters) — fetches the matching D1 rows for both result sets, merges, re-ranks by score, de-duplicates, and truncates to `limit`.
  - REST list routes for `projects`, `tasks`, `facts`, `documents`, `thoughts`, and `time-series-points` (`specs/memory-model/spec.md`) return rows where `owner_id = caller OR shared = true`.
  - `list_dependencies(entity_kind, entity_id, direction?, relationship?)` and `list_stale(kind?, project_id?)`: an edge is returned if `dependencyEdges.ownerId == caller`, or the `dependent` entity satisfies `owner_id = caller OR shared = true`, or the `dependency` entity does.
  - `markDownstreamStale(ctx, dependencyKind, dependencyId, reason)`: if the entity at `dependencyKind`/`dependencyId` has `shared == true` (or is a `person`, as today via `markGlobalPersonDownstreamStale`), mark stale edges across **all** owners pointing at it; otherwise (private entity, so by the cross-owner rule no edge from another owner can point at it) scope to `ownerId = caller` as today. This generalizes `markGlobalPersonDownstreamStale` to "any shared dependency", and `markGlobalPersonDownstreamStale` becomes that function's `person` case.

- **Dependencies**:
  - No new Cloudflare bindings or npm packages.
  - A new Vectorize metadata index on `shared` is created (`wrangler vectorize create-metadata-index`, additive — unlike ADR-010's dimension change, this does not require recreating the index), alongside the existing `owner_id`/`kind`/`project_id` metadata indexes (`docs/notes/vectorize-setup.md`).

- **Constraints**:
  - D1 remains canonical (`ARCHITECTURE.md` invariant 2); Vectorize `shared` metadata is a derived projection of `documents`/`thoughts`/`facts`.`shared` and is reproduced correctly by a full rebuild (invariant 3).
  - `owner_id`-based write/delete authorization is unchanged everywhere — `shared` only widens read access.
  - `dependency_edges` uniqueness, self-reference rejection, and kind/relationship checks (`specs/dependency-graph/spec.md`) are unchanged and apply identically to cross-owner edges.

## Contract

### Definition Of Done

- [x] Drizzle schema adds `shared` (`integer`, boolean mode, `NOT NULL DEFAULT false`) plus an index to `projects`, `tasks`, `facts`, `documents`, `thoughts`, `time_series_points`, with a migration.
- [x] `set_shared(entity_kind, entity_id, shared)` (MCP) and `POST /api/v1/shared` (REST) flip `shared` on a caller-owned entity (`owner_id = caller`, strict), reject unsupported `entity_kind`s with `400` and not-found/not-owned with `404`, and on `shared: true` return the updated entity plus `cascaded: { kind, id }[]`.
- [x] The cascade described above runs on `set_shared(..., true)`: project containment (one-way, project → `project_id`-scoped rows), then `dependency_edges` traversal (`dependent` → `dependency`) from every newly-shared entity, cycle-safe via a visited set, terminating at `person` nodes and at already-shared entities.
- [x] `createDependency` and `project_id`-setting paths (`ensureProject` and any equivalent) enforce: dependent owned by caller; dependency either same-owner, or `shared = true` (cross-owner) with the dependent's `shared` set to `true` and the cascade run; `person` and `document_chunk`-via-parent-`document` exempt from both the cross-owner gate and the "dependent becomes shared" side effect. When contagion triggers, the response includes `cascaded: { kind, id }[]` (including the dependent itself), matching `set_shared`'s shape.
- [x] `entityExists`/`ensureEntity` accept a `"dependent" | "dependency"` position and apply `owner_id = caller` (strict) vs. `owner_id = caller OR shared = true` (`person` always true, `document_chunk` via parent) respectively.
- [x] `recall` returns rows with `owner_id = caller OR shared = true` via two merged/re-ranked Vectorize queries (owner-scoped and shared-scoped) plus D1 lookups; Vectorize metadata for `thoughts`/`facts`/`document_chunks` includes `shared` and is kept in sync (re-upserted) when the cascade changes it.
- [x] REST list routes for `projects`, `tasks`, `facts`, `documents`, `thoughts`, `time-series-points` return `owner_id = caller OR shared = true` rows.
- [x] `list_dependencies` and `list_stale` return edges where the caller owns the edge, or either endpoint satisfies `owner_id = caller OR shared = true`.
- [x] `markDownstreamStale` marks stale edges across all owners when the updated entity is `shared = true` (generalizing `markGlobalPersonDownstreamStale`), and remains caller-scoped for private entities.
- [x] `pnpm test` covers: cascade from a shared project to its `project_id` contents and their transitive `dependency_edges` (including a cycle); cross-owner `dependency_edges`/`project_id` creation rejected when the target isn't shared, allowed (with contagion to the dependent) when it is; `person`/`document_chunk` exemption from contagion; `set_shared` owner-only enforcement and `cascaded` reporting; OR-shared visibility in `recall`, REST list routes, `list_dependencies`, and `list_stale`; cross-owner stale propagation when a shared entity is updated; `set_shared(..., false)` not retracting prior cascades.
- [x] `pnpm check && pnpm typecheck && pnpm test` pass.

### Regression Guardrails

- With every row's `shared = false` (the default for all existing and newly-created rows), all current memory-model and dependency-graph behavior, tests, and query results are unchanged — `owner_id = caller OR shared = true` reduces to `owner_id = caller`.
- `people`'s global visibility (PBI-008) and `markGlobalPersonDownstreamStale`'s existing cross-owner staleness behavior for persons are unchanged (the latter is now one case of the generalized shared-entity staleness rule).
- No `shared = true` row becomes writable or deletable by a non-owner; only read paths (`recall`, list routes, `list_dependencies`, `list_stale`, `entityExists` in `"dependency"` position) are affected.
- Vectorize remains a derived, rebuildable index (`ARCHITECTURE.md` invariant 3): rebuilding from D1 reproduces correct `shared` metadata for every vector without re-running any cascade (cascades only ever set D1's `shared` columns; the rebuild reads them).
- `dependency_edges` uniqueness (`UNIQUE (owner_id, dependent_kind, dependent_id, dependency_kind, dependency_id, relationship)`), self-reference rejection, and kind/relationship `CHECK` constraints (`specs/dependency-graph/spec.md`) continue to hold for cross-owner edges.

### Scenarios

```gherkin
Feature: Shared visibility

  Scenario: Marking a project shared cascades to its contents
    Given user A owns a project with a task, a fact, and a thought whose project_id is that project
    When user A calls set_shared with entity_kind "project", the project's id, and shared true
    Then the project's shared flag is true
    And the task, fact, and thought are each marked shared true
    And the response's cascaded list includes the task, fact, and thought

  Scenario: Cascade follows dependency edges transitively and is cycle-safe
    Given user A's shared project contains a fact F1
    And F1 has a derived_from dependency edge to a thought T1 owned by user A but with a different project_id
    And T1 has a derived_from dependency edge back to F1
    When user A's project is marked shared
    Then F1 and T1 are both marked shared true
    And the cascade terminates without error despite the cycle

  Scenario: Cross-owner dependency edge is rejected when the target isn't shared
    Given user A has a private fact F owned by user A
    And user B has a thought T owned by user B
    When user B calls create_dependency with dependent thought T and dependency fact F
    Then the request is rejected

  Scenario: Cross-owner dependency edge shares the dependent when the target is shared
    Given user A has marked fact F as shared true
    And user B has a thought T owned by user B with shared false
    When user B calls create_dependency with dependent thought T and dependency fact F
    Then the edge is created
    And T's shared flag becomes true
    And anything T depends on is cascaded to shared per the cascade rules

  Scenario: Referencing a global person does not trigger sharing
    Given user B has a thought T owned by user B with shared false
    And a global person P exists
    When user B calls remember with content referencing P via links.people_ids
    Then a references edge from T to P is created
    And T's shared flag remains false

  Scenario: Assigning project_id to a shared project shares the new row
    Given user A has marked project PR as shared true
    And user B creates a new task with project_id set to PR
    When the task is created
    Then the task is owned by user B
    And the task's shared flag is true
    And user A can see the task via a list route or recall

  Scenario: Recall returns another user's shared content
    Given user A has a thought marked shared true with content "shared project kickoff notes"
    When user B calls recall with a query relevant to that content
    Then the results include user A's shared thought
    And user B's own private thoughts that don't match are not returned

  Scenario: set_shared is owner-only
    Given user A owns a task with shared false
    When user B calls set_shared with entity_kind "task", user A's task id, and shared true
    Then the request is rejected with not found
    And the task's shared flag remains false

  Scenario: Un-sharing the root does not retract cascaded shares
    Given user A marked project PR as shared true, cascading shared true to task TK
    When user A calls set_shared with entity_kind "project", PR's id, and shared false
    Then PR's shared flag is false
    And TK's shared flag remains true

  Scenario: Updating a shared entity marks cross-owner dependents stale
    Given user A's fact F is shared true
    And user B's document D has a derived_from edge to F
    When user A updates F's statement
    Then the derived_from edge from D to F is marked stale
    And user B can see the stale edge via list_stale
```
