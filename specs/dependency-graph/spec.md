# Spec: Dependency Graph

## Blueprint

### Context

Brainfog currently models relationships in several one-off ways: thought junction tables (`thought_people`, `thought_tasks`, `thought_facts`, `thought_documents`), fact derivation junction tables (`fact_source_thoughts`, `fact_source_facts`, `fact_source_documents`, `fact_source_document_chunks`), fact supersession pointer fields (`supersedes_fact_id`, `superseded_by_fact_id`), and generic time-series subject fields (`subject_type`, `subject_id`). That works for the first memory model, but it does not support a broader dependency graph where generated documents, facts, future pages, or other derived records can declare upstream inputs and become stale when those inputs change.

This spec replaces those one-off relationship structures with a generic owner-scoped dependency graph. The graph stores typed directed edges between brainfog objects. The direction is explicit: a dependent object points to the upstream object it depends on. If a generated document depends on three facts and two thoughts, the document has five `derived_from` edges to those upstream objects. When an upstream object changes, downstream generated objects can be marked stale and later refreshed by an agent.

PBI-005 (`tasks/PBI-005-dependency-graph.md`) implements this spec before the default UI work, so the UI can browse and display relationships through one graph service instead of preserving soon-to-be-redundant relationship fields.

### Architecture

- **Graph Semantics**:
  - A graph edge is directed from `dependent` to `dependency`.
  - `dependent_*` identifies the object that may reference, summarize, derive from, supersede, observe, or otherwise rely on another object.
  - `dependency_*` identifies the upstream object.
  - Example: a document generated from a fact stores `dependent_kind = "document"`, `dependent_id = <document id>`, `dependency_kind = "fact"`, `dependency_id = <fact id>`, `relationship = "derived_from"`.
  - Relationship direction is always the same even for weak reference edges. Reverse queries answer "what depends on this object?" without needing duplicate rows.

- **API Contracts**:
  - Existing memory-model tools are updated to use graph edges instead of removed relationship tables/fields:
    - `remember(content, type?, project_id?, links?)` still accepts `links`, but writes graph edges with relationship `references` from the thought to each linked object.
    - `link(thought_id, { people_ids?, task_ids?, fact_ids?, document_ids? })` becomes a compatibility wrapper over graph writes for a thought dependent with relationship `references`.
    - `record_fact(statement, citations?, confidence?, project_id?, topics?, derived_from?, supersedes_fact_id?)` still accepts `derived_from` and `supersedes_fact_id`, but writes `derived_from` and `supersedes` graph edges instead of fact-source junction rows or fact self-pointer fields.
    - `update_fact(...)` updates fact fields and graph supersession edges as needed; fact lifecycle status remains on `facts.status`.
    - `record_time_series_point(..., subject_type?, subject_id?, ...)` still accepts subject fields for API compatibility, but stores the subject relationship as a graph edge with relationship `observes_subject` instead of columns on `time_series_points`.
    - `list_time_series_points(..., subject_type?, subject_id?, ...)` filters through graph edges when subject filters are supplied.
    - `add_document(title, content, project_id?, mime_type?, derived_from?)` accepts optional upstream object IDs and creates `derived_from` graph edges from the document to those inputs.
    - `update_document(id, content, derived_from?)` can replace the document's `derived_from` edges when supplied; otherwise it preserves existing graph edges.
  - New MCP tools exposed under `/mcp`, all authenticated and owner-scoped:
    - `create_dependency(dependent, dependency, relationship, metadata?)` creates one edge between owned objects.
    - `delete_dependency(id)` removes one edge owned by the caller.
    - `list_dependencies(entity_kind, entity_id, direction?, relationship?)` lists upstream and/or downstream graph edges for one owned object. `direction` is `upstream | downstream | both` and defaults to `both`.
    - `mark_stale(entity_kind, entity_id, reason?, stale_since?)` marks downstream generated dependents stale after an upstream change or explicit user/agent decision.
    - `list_stale(kind?, project_id?)` lists owned objects with stale dependency edges or stale generated-object state.
  - REST routes under `/api/v1/dependencies`, all authenticated and owner-scoped, mirror the new dependency tools for the UI:
    - `GET /api/v1/dependencies?entity_kind=&entity_id=&direction=&relationship=`
    - `POST /api/v1/dependencies`
    - `DELETE /api/v1/dependencies/:id`
    - `POST /api/v1/dependencies/stale`
    - `GET /api/v1/dependencies/stale`

- **Data Models** (D1, via Drizzle; all app-generated IDs follow the memory-model ID convention, adding suffix `e` for dependency edges):
  - **`dependency_edges`**:
    - `id` (pk), `owner_id` (fk -> `users.id`), `source`, `dependent_kind`, `dependent_id`, `dependency_kind`, `dependency_id`, `relationship`, `metadata` (JSON object, default `{}`), `stale_at` (nullable timestamp), `stale_reason` (nullable text), `last_verified_at` (nullable timestamp), `created_at`, `updated_at`.
    - `relationship` values in v1: `references`, `derived_from`, `summarizes`, `supersedes`, `observes_subject`, `mentions`, `related_to`.
    - `dependent_kind` and `dependency_kind` allowed values in v1: `project`, `person`, `task`, `fact`, `time_series_point`, `document`, `document_chunk`, `thought`.
    - `UNIQUE (owner_id, dependent_kind, dependent_id, dependency_kind, dependency_id, relationship)`.
    - Indexes: `dependency_edges(owner_id, dependent_kind, dependent_id)`, `dependency_edges(owner_id, dependency_kind, dependency_id)`, `dependency_edges(owner_id, relationship)`, `dependency_edges(owner_id, stale_at)`.
  - **Removed/replaced structures**:
    - Drop `thought_people`, `thought_tasks`, `thought_facts`, and `thought_documents`; replace with `dependency_edges` where dependent is `thought`, relationship is `references`, and dependency is the linked object.
    - Drop `fact_source_thoughts`, `fact_source_facts`, `fact_source_documents`, and `fact_source_document_chunks`; replace with `dependency_edges` where dependent is `fact`, relationship is `derived_from`, and dependency is the source object.
    - Remove `facts.supersedes_fact_id` and `facts.superseded_by_fact_id`; replace with `dependency_edges` where dependent is the newer/current fact, dependency is the older fact, and relationship is `supersedes`. `facts.status` remains the lifecycle field.
    - Remove `time_series_points.subject_type` and `time_series_points.subject_id`; replace with `dependency_edges` where dependent is the time-series point, dependency is the observed object, and relationship is `observes_subject`.

- **Migration Rules**:
  - Existing junction-table rows are migrated into `dependency_edges` before those tables are dropped.
  - Existing fact supersession pointers are migrated into `dependency_edges` before those columns are removed.
  - Existing time-series subject references are migrated into `dependency_edges` before those columns are removed.
  - Migration is idempotent enough for local reruns: duplicate edge attempts collapse into the unique edge constraint.
  - Edges are only created when both referenced objects exist and belong to the same owner. Invalid orphaned relationships are skipped and surfaced in migration notes/tests rather than creating cross-owner or dangling graph edges.

- **Staleness Rules**:
  - Updating an upstream object marks downstream edges stale when the relationship is dependency-bearing: `derived_from`, `summarizes`, `supersedes`, or `observes_subject`.
  - Weak relationships such as `references`, `mentions`, and `related_to` do not automatically mark downstream objects stale unless the caller explicitly requests it.
  - `stale_at` on an edge means the dependent may need review because that specific upstream dependency changed.
  - `last_verified_at` is updated when an agent or user confirms the dependent remains current after reviewing the upstream change; verification clears `stale_at` and `stale_reason` for that edge.
  - This spec only tracks staleness. It does not automatically regenerate documents or facts.

- **Constraints**:
  - All graph writes validate `owner_id` on both endpoints. No edge may connect objects owned by different users.
  - D1 remains canonical for graph edges and staleness state.
  - Graph edges do not replace project scoping; `project_id` remains on project-scoped entities for fast filtering and ownership semantics.
  - Graph edges do not replace `document_chunks.document_id`; chunks remain structurally owned by a document and are regenerated with that document.
  - Graph edges do not replace `facts.status`; lifecycle status remains a fact field, while supersession relationships move to the graph.
  - Graph edges do not replace `citations`; free-text external citations remain on facts because they are not owned brainfog objects.

## Contract

### Definition Of Done

- [x] Drizzle schema defines `dependency_edges` with the fields, allowed kind/relationship validation, uniqueness, and indexes described here.
- [x] Migration creates `dependency_edges`, migrates existing thought links, fact derivation links, fact supersession pointers, and time-series subject references into graph edges, then removes the redundant tables/columns.
- [x] App-generated dependency edge IDs use `bf<20 lowercase Crockford Base32 chars>e`.
- [x] `remember`, `link`, `record_fact`, `update_fact`, `record_time_series_point`, `list_time_series_points`, `add_document`, and `update_document` use dependency graph edges for relationships described in this spec.
- [x] New MCP tools `create_dependency`, `delete_dependency`, `list_dependencies`, `mark_stale`, and `list_stale` exist and are authenticated/owner-scoped.
- [x] REST routes under `/api/v1/dependencies` mirror the dependency graph tools and are authenticated/owner-scoped.
- [x] Updates to upstream objects mark dependency-bearing downstream edges stale without marking weak reference edges stale by default.
- [x] Owner validation rejects cross-user edges and dangling object references.
- [x] `pnpm test` includes coverage for migration shape, compatibility inputs (`links`, `derived_from`, `supersedes_fact_id`, `subject_type`/`subject_id`), cross-owner rejection, upstream/downstream queries, and staleness marking.
- [x] `pnpm check && pnpm typecheck && pnpm test` pass.

Completion evidence: PBI-005 implementation added the `dependency_edges` Drizzle schema and migration, migrated/replaced the prior thought-link/fact-derivation/fact-supersession/time-series-subject relationship storage, updated the memory service, MCP tools, REST routes, and tests to use the graph, and added stale-edge handling including document-chunk regeneration/delete cleanup. Verified on 2026-06-14 with `pnpm check && pnpm typecheck && pnpm test` (35/35 tests passed). Critic review completed four passes; final report found no blocking issues and confirmed auth, owner scoping, D1 canonical storage, and Vectorize rebuildability invariants were preserved. Known non-blocking output: Biome reports schema/deprecation infos and Vitest sometimes emits a post-success Vite close-timeout warning.

### Regression Guardrails

- Existing memory-model tool and REST request shapes remain source-compatible where explicitly noted, even though storage moves to `dependency_edges`.
- `facts.status`, `facts.citations`, `project_id`, and `document_chunks.document_id` are not removed by this spec.
- The graph must never become a cross-user side channel; every edge endpoint is owner-validated before write and before read.
- Vectorize remains derived and rebuildable; graph edges do not alter vector IDs or embedding behavior.

### Scenarios

```gherkin
Feature: Dependency graph

  Scenario: Linking a thought to a person uses graph edges
    Given an authenticated user has a thought and a person
    When they call link with the thought id and person id
    Then a dependency edge is created from the thought to the person
    And the relationship is references

  Scenario: Recording a derived fact uses graph edges
    Given an authenticated user has a thought, fact, document, and document chunk
    When they call record_fact with derived_from naming those objects
    Then dependency edges are created from the new fact to each source object
    And the relationship is derived_from

  Scenario: Superseding a fact uses graph edges
    Given an authenticated user has an existing fact
    When they record a newer fact with supersedes_fact_id
    Then a dependency edge is created from the newer fact to the older fact
    And the relationship is supersedes
    And the older fact status is updated to superseded

  Scenario: Generated document depends on source memories
    Given an authenticated user has thoughts and facts
    When they add a document with derived_from naming those thoughts and facts
    Then dependency edges are created from the document to each source object
    And later updates to those source objects mark the document's dependency edges stale

  Scenario: Time-series subject uses graph edges
    Given an authenticated user has a project
    When they record a time-series point with subject_type project and the project id
    Then a dependency edge is created from the point to the project
    And list_time_series_points can filter by that subject through the graph

  Scenario: Cross-user edge is rejected
    Given two users have separate facts
    When one user tries to create a dependency edge to the other user's fact
    Then the write is rejected
```
