# ADR-011: Shared Visibility For Memory Records

## Status

Accepted — 2026-06-15

## Context

Brainfog's memory model (`specs/memory-model/spec.md`) and dependency graph (`specs/dependency-graph/spec.md`) scope nearly every table by `owner_id`. The one existing exception is `people` (ADR/PBI-008's "global people pool"): every authenticated user can see and reference the same canonical person rows, while every other table remains strictly single-owner.

The product intent is for multiple authenticated brainfog users to work together: see the same project, and have each other's tasks, facts, documents, and thoughts under that project visible to the group. `ARCHITECTURE.md` lists "Real-time collaboration/presence features" as a non-goal; this decision stays inside that boundary by being about asynchronous *read* visibility — each user still creates and edits only their own rows — not live multi-user editing of the same row.

There is currently no mechanism for a user to grant other authenticated users read access to anything beyond the global `people` pool.

## Decision

We introduce a generic `shared` boolean column (default `false`) on every owner-scoped memory table: `projects`, `tasks`, `facts`, `documents`, `thoughts`, `time_series_points`. A row with `shared = true` is readable — not writable — by any authenticated user, in addition to its owner. `document_chunks` have no column of their own; they inherit visibility from their parent `documents.shared`. `people` are already global and unaffected. `dependency_edges` carry no `shared` column; an edge's visibility is derived from its endpoint entities.

Three rules govern `shared`, all detailed in `specs/sharing/spec.md`:

1. **Direct marking.** One new generic tool/route, `set_shared(entity_kind, entity_id, shared)`, lets an owner flip their own row's flag. It reuses the `entity_kind`/`entity_id` dispatch pattern already established by `mark_stale`/`list_dependencies` (`specs/dependency-graph/spec.md`), rather than adding a `shared?` parameter to every `create_*`/`update_*` tool.

2. **Cascade-on-share (monotonic, write-time).** When an entity's `shared` flips to `true`, the service walks outward and also marks `shared = true` on:
   - every row whose `project_id` points at it, if the entity is a `project` (its "contents"), and
   - every entity reachable by following `dependency_edges` from `dependent` to `dependency` (what it "depends on"), recursively.

   The walk is cycle-safe via a visited set and stops at entities already `shared = true`. It never un-shares anything: later graph changes, or explicitly setting the root's own `shared` back to `false`, do not retract shares it already caused.

3. **Cross-owner references become allowed — and contagious.** `dependency_edges` and `project_id` references currently require both endpoints to have the same `owner_id` (`specs/dependency-graph/spec.md`: "All graph writes validate `owner_id` on both endpoints. No edge may connect objects owned by different users."). We relax this: a reference from entity A (owner X) to entity B (owner Y ≠ X) is allowed if and only if `B.shared == true`. Creating such a reference also sets `A.shared = true` (triggering rule 2's cascade from A). `person` references, and a `document_chunk`'s implicit reference to its parent `document`, are exempt from triggering A becoming shared — `people` are unconditionally global already, and treating every person-linked thought as "shared" would make sharing effectively mandatory given how common person links are (`remember`'s `links.people_ids`).

Every owner-scoped read path (`entityExists`, `ensureProject`, `recall`, `list_*` tools/routes, `list_dependencies`, `list_stale`) is extended from `owner_id = caller` to `owner_id = caller OR shared = true`. `recall`'s Vectorize metadata gains a `shared` field. Because Vectorize metadata filters are an implicit AND across fields with no cross-field OR, `recall` issues two scoped Vectorize queries — one filtered by `owner_id = caller`, one by `shared = true` — then merges, re-ranks by score, and truncates to `limit` in the worker.

## Consequences

**Positive**

- One boolean, one generic tool, and one cascade function cover both halves of the ask: "mark a project (or anything) shared" and "share what it depends on."
- Rule 3 lets collaborators build on each other's shared work (new cross-owner edges and `project_id` references) without a blanket cross-user read path: a reference can only ever point at something already shared, and creating it shares the referencing side too, so the graph never ends up with a private node pointing at a node its owner can't see.
- Consistent with the `people`-pool precedent (ADR/PBI-008): visibility is widened per-table via an explicit flag, not by removing `owner_id` scoping.
- "Cascade-on-write into a denormalized column" keeps `recall`'s Vectorize filter a simple equality/membership check rather than a recursive graph query at read time.

**Negative**

- Because cascaded shares are permanent (rule 2), a single cross-owner reference created by another user can permanently cascade-share a non-trivial chunk of the referencing user's existing dependency graph. This is a real, irreversible side effect of one write and needs to be visible to users (e.g., surfaced in the UI/response when it happens).
- `recall`'s two-query-and-merge approach roughly doubles Vectorize query volume for every `recall` call, whether or not any shared content is actually relevant.
- Every list/read path in the memory and dependency-graph services gains an `OR shared = true` clause — a mechanical but pervasive change across `apps/worker/src/memory.ts`.

**Neutral**

- Write/delete permissions are unchanged by `shared` — only the owner can mutate a row. "Collaboration" in this decision means parallel contribution to a shared project (each person's own rows become visible to the group), not joint editing of the same row.
- `set_shared(..., false)` is allowed and flips the target's own flag back, but per rule 2 does not retract any shares it previously caused on other rows.

## Alternatives Considered

- **Compute visibility at read time via a recursive CTE over `dependency_edges` and `project_id`, instead of a denormalized `shared` column**: rejected — always correct and trivially reversible, but cannot be expressed as a Vectorize metadata filter, which is the canonical filtering layer for `recall` (ADR-005, `specs/memory-model/spec.md`). A recursive query on every list/recall call is also a much larger query-time cost than a column check.
- **Reference-counted / reversible cascade, where un-sharing a root un-shares only the rows it alone caused to be shared**: rejected per explicit product direction — tracking which root(s) caused each cascaded share adds real bookkeeping for an un-sharing case the product doesn't need yet.
- **A `shared?` parameter on every `create_*`/`update_*` tool instead of one generic `set_shared` tool**: rejected — would touch seven tool signatures for a flag that's almost always set after creation (when a user decides to start collaborating on something), versus one new tool reusing the existing `entity_kind`/`entity_id` dispatch already established by `mark_stale`.
- **Let `people`-style "always visible" extend automatically to anything referenced by a person link**: rejected — `people` are referenced constantly, so this would make sharing effectively automatic for most thoughts and defeat the opt-in model (hence rule 3's exemption).
