# Spec: Memory Model

## Blueprint

### Context

This spec defines brainfog's core data model — the schema for everything brainfog remembers. It builds on the platform baseline (`specs/platform-setup/spec.md`, PBI-001) for auth, D1/Drizzle setup, and the Vectorize/Workers AI bindings, and on ADR-008 for the new R2 binding.

The model is loosely based on [OB1](https://github.com/NateBJones-Projects/OB1)'s `thoughts` table: a single denormalized record fusing raw text, an embedding, and lightweight structured metadata (`people[]`, `action_items[]`, `dates_mentioned[]`, `topics[]`, a `type` enum, and a `source` tag), accessed only via `match_thoughts` (read) and `upsert_thought` (write). Brainfog keeps `thoughts` as the core record of "things noticed in passing", but goes further than OB1's single-table model: `people`, `tasks`, `facts`, `documents`, `projects`, and `time_series_points` are first-class tables with their own fields and lifecycle, and `thoughts`/`facts` link to source material via junction tables rather than inline JSON arrays or a generic `type` enum. `thoughts.metadata` is correspondingly smaller than OB1's — it keeps only the fields that don't have a dedicated table (`topics`, `dates_mentioned`).

Every non-junction table introduced here carries `owner_id`, `source`, and timestamps per `ARCHITECTURE.md` invariant 4 (provenance — "every memory has provenance: source agent/tool, user/token, project/scope, timestamps; writes without provenance are rejected"), except `document_chunks`, whose ownership/provenance is derived from its parent `documents` row. `project_id` is added to `thoughts`, `tasks`, `facts`, `documents`, and `time_series_points` (the entities that meaningfully belong to a project); `people` and `projects` themselves are not project-scoped.

This spec also extends ADR-005's Vectorize indexing scheme from "one vector per memory row" to "one vector per embeddable row across three tables" (`thoughts`, `facts`, `document_chunks`), using the embedded D1 row ID itself as the Vectorize ID and carrying `kind` in vector metadata. This is a refinement of ADR-005's implementation detail (the vector ID convention), not a reversal of its Decision (Workers AI + Vectorize, D1 canonical / Vectorize derived) — ADR-005 remains Accepted as-is.

PBI-002 (`tasks/PBI-002-memory-model.md`) implements this spec. PBI-004 (`tasks/PBI-004-embedding-model-upgrade.md`) updates the embedding model and Vectorize dimension per ADR-010.

**Out of scope for this spec** (noted so future specs know where to extend, not because they're forgotten): task assignees other than the owner, person-to-project association, and document versioning/history.

### Architecture

- **API Contracts**:

  MCP tools exposed under `/mcp` (extending the platform baseline's scaffold, ADR-003), all requiring a valid bearer token (ADR-004) and operating only on rows owned by the authenticated user:
  - `remember(content, type?, project_id?, links?)` → creates a `thoughts` row (`type` defaults to `observation`), generates its embedding via Workers AI, and upserts it into Vectorize using the thought row `id` as the vector ID. `links` is an optional `{ people_ids?, task_ids?, fact_ids?, document_ids? }` of existing record IDs (owned by the same user) to associate via the junction tables below.
  - `record_fact(statement, citations?, confidence?, project_id?, topics?, derived_from?, supersedes_fact_id?)` → creates a `facts` row (`citations` is an array of free-text citation strings, default `[]`; `derived_from` is an optional `{ thought_ids?, fact_ids?, document_ids?, document_chunk_ids? }` of existing record IDs owned by the same user; `supersedes_fact_id` optionally names an existing fact this new fact replaces), generates its embedding, applies derivation/supersession links, and upserts it into Vectorize using the fact row `id` as the vector ID.
  - `update_fact(id, statement?, citations?, confidence?, status?, topics?, supersedes_fact_id?, superseded_by_fact_id?)` → updates a fact and its lifecycle fields, re-embedding when `statement` changes. Status changes to `superseded`/`proven_wrong` do not delete the fact or its vector; they preserve recallable history with lifecycle metadata.
  - `add_document(title, content, project_id?, mime_type?)` → writes `content` to R2 (ADR-008), creates a `documents` row with the resulting `r2_key`, splits `content` into `document_chunks`, and generates+upserts an embedding per chunk using the chunk row `id` as the vector ID.
  - `update_document(id, content)` → rewrites the R2 object at the existing `r2_key`, deletes the document's existing `document_chunks` (and their Vectorize vectors), and re-chunks/re-embeds as in `add_document`.
  - `recall(query, kinds?, project_id?, limit?)` → embeds `query`, searches Vectorize filtered by `owner_id` (and `project_id`/`kinds` if given; `kinds` defaults to all of `thought`, `fact`, `document_chunk`), and returns the matching rows from D1 joined with their `kind`. A `document_chunk` result includes its parent `documents.id` and `title`.
  - `create_task(title, description?, project_id?, due_at?, status?, priority?, recurrence?)`, `update_task(id, ...)`, `list_tasks(project_id?, status?)` — CRUD over `tasks`. `recurrence` is nullable structured JSON for recurring tasks; no embedding.
  - `record_time_series_point(series_key, value?, unit?, observed_at?, project_id?, subject_type?, subject_id?, metadata?)`, `list_time_series_points(series_key?, project_id?, subject_type?, subject_id?, from?, to?)` — append/list generic time-series observations for anything the user tracks over time.
  - `upsert_person(id?, name, aliases?, contact_info?, notes?)`, `list_people()` — CRUD over `people`. No embedding. When `id` names an existing person, `aliases`/`contact_info`/`notes` are partial-update fields: omitting one preserves its current stored value, while an explicit value (including `[]`, `{}`, or `null`) replaces it.
  - `create_project(name, description?)`, `list_projects()` — CRUD over `projects`.
  - `link(thought_id, { people_ids?, task_ids?, fact_ids?, document_ids? })` → adds rows to the junction tables for an existing thought (in addition to the inline `links` on `remember`).

  REST routes under `/api/v1/*` (same auth as the platform baseline) mirror the above for use by the web UI (ADR-007): list/create routes for `projects`, `people`, `tasks`, `facts`, `thoughts`, `documents`, and `time-series-points` (with `GET /api/v1/documents/:id/content` proxying the R2 object), plus `GET /api/v1/recall?q=...` mirroring the `recall` tool. Request/response shapes follow the same fields as the Data Models below; `owner_id` is always derived from the authenticated token and is never accepted from the client.

- **Data Models** (D1, via Drizzle — ADR-002; all `id` columns are app-generated typed brainfog IDs; all timestamps are Unix seconds; `created_at`/`updated_at` exist on every non-junction table below except `document_chunks`, whose rows are regenerated rather than updated and therefore carry only `created_at`; `updated_at` is refreshed on every update where present):

  - **ID format**: all app-generated row IDs use lowercase text in the form `bf<random><type>`, where `<random>` is 20 characters of Crockford-style lowercase Base32 using `0123456789abcdefghjkmnpqrstvwxyz`, and `<type>` is a one-character entity suffix. This yields 100 bits of randomness in a compact, URL-safe, recognisable ID (23 characters total). Suffixes are: `r` project, `p` person, `k` task, `f` fact, `s` time_series_point, `d` document, `c` document_chunk, `t` thought, `u` user, and `n` token. Example: `bf8k2m9q4t7v6x1c3n5p0t`.

  - **`projects`**
    - `id` (pk), `owner_id` (fk → `users.id`), `source`, `name`, `description` (nullable), `created_at`, `updated_at`.

  - **`people`**
    - `id` (pk), `owner_id` (fk → `users.id`), `source`, `name`, `aliases` (JSON array of strings, default `[]`), `contact_info` (JSON object, default `{}` — freeform contact details, e.g. email, phone, social handles; shape not enforced by schema), `notes` (nullable), `created_at`, `updated_at`.
    - No `project_id`, no embedding.

  - **`tasks`**
    - `id` (pk), `owner_id` (fk → `users.id`), `project_id` (nullable, fk → `projects.id`), `source`, `title`, `description` (nullable), `status` (`open | in_progress | done | cancelled`, default `open`), `priority` (real, default `0.5`, `CHECK (priority >= 0.0 AND priority <= 1.0)`), `due_at` (nullable timestamp), `recurrence` (nullable JSON object), `created_at`, `updated_at`.
    - `recurrence` shape: `{ frequency: "daily" | "weekly" | "monthly" | "yearly", interval?: number, days_of_week?: number[], day_of_month?: number, timezone?: string, starts_at?: number, ends_at?: number, count?: number }`. `interval` defaults to `1`; `days_of_week` uses `0`-`6` for Sunday-Saturday. The service layer validates that `interval > 0`, `days_of_week` values are in range, and `ends_at` is after `starts_at` when both are present.
    - No embedding — tasks are a lifecycle entity, not a recall target.

  - **`facts`**
    - `id` (pk), `owner_id` (fk → `users.id`), `project_id` (nullable, fk → `projects.id`), `source`, `statement`, `citations` (JSON array of strings, default `[]` — each entry a free-text citation/source reference), `confidence` (real, `CHECK (confidence >= 0.0 AND confidence <= 1.0)`), `status` (`current | superseded | proven_wrong`, default `current`), `supersedes_fact_id` (nullable self-fk → `facts.id`, `ON DELETE SET NULL`), `superseded_by_fact_id` (nullable self-fk → `facts.id`, `ON DELETE SET NULL`), `metadata` (JSON `{ topics: string[] }`, default `{}`), `created_at`, `updated_at`.
    - `status` tracks the claim's lifecycle. `current` means the fact is presently accepted by the user/agent; `superseded` means a newer fact replaces it; `proven_wrong` means later evidence invalidated it rather than merely refining it. `supersedes_fact_id` points from a newer fact to the older fact it replaces; `superseded_by_fact_id` points from an older fact to the newer replacement. The service layer keeps these reciprocal pointers consistent when supersession is requested and rejects self-references.
    - Embedding of `statement` → Vectorize vector ID `<id>`.

  - **`time_series_points`**
    - `id` (pk), `owner_id` (fk → `users.id`), `project_id` (nullable, fk → `projects.id`), `source`, `series_key` (text), `subject_type` (nullable text), `subject_id` (nullable text), `value` (nullable real), `unit` (nullable text), `observed_at` (timestamp), `metadata` (JSON object, default `{}`), `created_at`, `updated_at`.
    - Generic append-oriented observations for any tracked value over time, not limited to health data. Examples: `sleep.hours`, `build.duration_ms`, `mood.score`, `supplement.adherence`, `weight.kg`, or `api.latency_ms`.
    - `subject_type`/`subject_id` optionally associate the point with another entity such as a `person`, `task`, `project`, `fact`, or future domain object. These are intentionally not foreign keys because the table is generic; the service layer validates known in-model subject references when a known `subject_type` is used.
    - `value` is numeric when the point represents a measurement; non-numeric observations use `metadata` for structured payloads and may leave `value` null.
    - No embedding — time-series points are queried by owner/project/series/time rather than semantic recall.

  - **`documents`**
    - `id` (pk), `owner_id` (fk → `users.id`), `project_id` (nullable, fk → `projects.id`), `source`, `title`, `r2_key` (text, ADR-008), `mime_type` (default `text/markdown`), `size_bytes` (nullable), `created_at`, `updated_at`.
    - Full content lives in R2 at `r2_key`; D1 holds metadata only.

  - **`document_chunks`**
    - `id` (pk), `document_id` (fk → `documents.id`, `ON DELETE CASCADE`), `chunk_index` (integer), `content` (text, derived from the R2 object), `created_at`. `UNIQUE (document_id, chunk_index)`.
    - Embedding of `content` → Vectorize vector ID `<id>`. No `owner_id`/`project_id` of its own — derived from the parent `documents` row.

  - **`thoughts`**
    - `id` (pk), `owner_id` (fk → `users.id`), `project_id` (nullable, fk → `projects.id`), `source`, `content`, `type` (`observation | idea | reference | person_note`, default `observation`), `metadata` (JSON `{ topics: string[], dates_mentioned: string[] }`, default `{}`), `created_at`, `updated_at`.
    - Embedding of `content` → Vectorize vector ID `<id>`.
    - `type` describes the nature of the thought; what/who it concerns is expressed via the junction tables below, not via `type` or `metadata`.

  - **Thought junction tables** (composite primary key on both columns, both FKs `ON DELETE CASCADE`; no own timestamps):
    - `thought_people (thought_id → thoughts.id, person_id → people.id)`
    - `thought_tasks (thought_id → thoughts.id, task_id → tasks.id)`
    - `thought_facts (thought_id → thoughts.id, fact_id → facts.id)`
    - `thought_documents (thought_id → thoughts.id, document_id → documents.id)`
    - The service layer rejects links where the two linked rows have different `owner_id`s — SQLite FKs can't express this.

  - **Fact derivation junction tables** (composite primary key on both columns, both FKs `ON DELETE CASCADE`; no own timestamps):
    - `fact_source_thoughts (fact_id → facts.id, thought_id → thoughts.id)`
    - `fact_source_facts (fact_id → facts.id, source_fact_id → facts.id)`
    - `fact_source_documents (fact_id → facts.id, document_id → documents.id)`
    - `fact_source_document_chunks (fact_id → facts.id, document_chunk_id → document_chunks.id)`
    - These express that a fact/deduction was derived from one or more existing memories or documents in brainfog, distinct from the free-text `citations` array. The service layer rejects derivation links where linked rows have different `owner_id`s and rejects `fact_source_facts` self-links.

  - **Indexes**: `thoughts(owner_id, created_at desc)`, `thoughts(owner_id, project_id)`, `facts(owner_id, project_id)`, `facts(owner_id, status)`, `facts(supersedes_fact_id)`, `facts(superseded_by_fact_id)`, `tasks(owner_id, status)`, `tasks(owner_id, project_id)`, `tasks(owner_id, priority desc)`, `people(owner_id, name)`, `documents(owner_id, project_id)`, `time_series_points(owner_id, series_key, observed_at desc)`, `time_series_points(owner_id, project_id, observed_at desc)`, `time_series_points(owner_id, subject_type, subject_id, observed_at desc)`, plus reverse-lookup indexes on the junction tables' second column (`thought_people(person_id)`, `thought_tasks(task_id)`, `thought_facts(fact_id)`, `thought_documents(document_id)`, `fact_source_thoughts(thought_id)`, `fact_source_facts(source_fact_id)`, `fact_source_documents(document_id)`, `fact_source_document_chunks(document_chunk_id)`) for "what references X" queries.

  - **Vectorize index** (single index from the platform baseline, dimension 1024 to match `@cf/qwen/qwen3-embedding-0.6b` per ADR-010):
    - Vector ID format: `<id>`, exactly matching the D1 row ID for the embedded `thoughts`, `facts`, or `document_chunks` row. The row ID's suffix makes it recognisable in logs, while the metadata `kind` remains the authoritative type for filtering/query behavior.
    - Vector metadata payload: `{ kind, owner_id, project_id }` (`project_id` omitted when the source row's `project_id` is null; `document_chunk` vectors use the parent `documents.owner_id`/`project_id`).
    - Write path: on insert/update of a `thoughts` or `facts` row, or a `document_chunks` row, embed its text (`content`/`statement`/`content` respectively) via Workers AI and upsert to Vectorize with this ID and metadata.
    - Delete path: deleting a `thoughts` or `facts` row deletes its vector by ID; deleting a `documents` row cascades to its `document_chunks` rows, each of whose vectors is also deleted.
    - Rebuild (invariant 3): iterate `thoughts`, `facts`, and `document_chunks` in D1 and re-run the embed+upsert step — the index can be dropped and rebuilt with no data loss.

  - **R2** (ADR-008): one object per document holding its full content, referenced by `documents.r2_key`. `document_chunks.content` is derived from this object and re-generated whenever the document is updated.

- **Dependencies**:
  - New Cloudflare binding: an R2 bucket (ADR-008), declared in the Worker's Wrangler config alongside the D1, Vectorize, and Workers AI bindings from the platform baseline.
  - No new top-level npm dependencies beyond the platform baseline's (`hono`, `agents`, `drizzle-orm`, etc.). A simple chunking function can be written in-repo; if document chunking later needs a tokenizer/text-splitting library, that is a new dependency subject to `AGENTS.md`'s "ASK" rule at implementation time.

- **Constraints**:
  - D1 remains canonical for all rows and metadata (`ARCHITECTURE.md` invariant 2, ADR-002); Vectorize remains a derived, rebuildable index (invariant 3, ADR-005), now spanning `thoughts`, `facts`, and `document_chunks` via the row-ID-as-vector-ID scheme above.
  - R2 is canonical for full document content (ADR-008); `document_chunks` is a derived, re-generatable projection of that content for recall.
  - Every non-junction table except `document_chunks` carries `owner_id`, `source`, `created_at`, `updated_at` (invariant 4); `document_chunks` derives ownership/provenance from its parent `documents` row and carries `created_at`; `thoughts`, `tasks`, `facts`, `documents`, and `time_series_points` additionally carry a nullable `project_id`; `people` and `projects` do not.
  - All `/mcp` tools and `/api/v1/*` routes in this spec sit behind the platform baseline's bearer-token auth (invariant 6, ADR-004); `owner_id` is always derived from the authenticated token, never client-supplied.
  - Embedding model and dimension are fixed at `@cf/qwen/qwen3-embedding-0.6b` / 1024 (ADR-010) — the Vectorize index must be created with dimension 1024. This differs from OB1's 1536-dimension OpenAI embeddings; OB1's schema is a reference for shape, not for embedding configuration.

## Contract

### Definition Of Done

- [x] Drizzle schema (`packages/db`) defines `projects`, `people`, `tasks`, `facts`, `documents`, `document_chunks`, `thoughts`, `time_series_points`, `thought_people`, `thought_tasks`, `thought_facts`, `thought_documents`, `fact_source_thoughts`, `fact_source_facts`, `fact_source_documents`, and `fact_source_document_chunks`, with a migration that creates all of them on top of the platform baseline's `users`/`tokens`.
- [x] Every non-junction table except `document_chunks` has `owner_id` (fk → `users.id`), `source`, `created_at`, `updated_at`; `document_chunks` derives ownership/provenance from its parent `documents` row and has `created_at`; `thoughts`, `tasks`, `facts`, `documents`, and `time_series_points` additionally have a nullable `project_id` (fk → `projects.id`); `updated_at` is refreshed on every update where present.
- [x] `facts.confidence` and `tasks.priority` are constrained to `0.0`-`1.0`; `facts.status` is constrained to `current | superseded | proven_wrong`; `tasks.status` is constrained to `open | in_progress | done | cancelled`; `thoughts.type` is constrained to `observation | idea | reference | person_note`.
- [x] `facts.supersedes_fact_id` and `facts.superseded_by_fact_id` are nullable self-references; service logic rejects self-references and keeps reciprocal supersession pointers consistent when a fact supersedes another fact.
- [x] `tasks.recurrence` accepts validated recurrence JSON for daily/weekly/monthly/yearly schedules, rejects invalid intervals/days/date ranges, and remains nullable for one-off tasks.
- [x] `time_series_points` stores generic timestamped observations with `series_key`, optional subject reference, optional numeric `value`, optional `unit`, and JSON `metadata`, scoped by owner and optionally by project.
- [x] An R2 bucket is declared (ADR-008) and bound to the Worker; `documents.r2_key` references the stored content, and `document_chunks` rows exist per document.
- [x] App-generated row IDs follow `bf<20 lowercase Crockford Base32 chars><type suffix>` with the suffixes defined in this spec.
- [x] The Vectorize index is created with dimension 1024; vector IDs exactly match the D1 row IDs for `thoughts`, `facts`, and `document_chunks`, with metadata `{ kind, owner_id, project_id }`.
- [x] `remember` creates a `thoughts` row, embeds and upserts it to Vectorize, and applies any `links` to people/tasks/facts/documents via the junction tables.
- [x] `record_fact` creates a `facts` row with zero or more `citations`, optional derivation links to thoughts/facts/documents/document_chunks, optional supersession of an existing fact, and embeds/upserts it to Vectorize.
- [x] `update_fact` updates fact fields and lifecycle status, re-embeds when `statement` changes, and preserves vectors for `superseded`/`proven_wrong` facts rather than deleting history.
- [x] `add_document` writes content to R2, creates a `documents` row, and creates+embeds `document_chunks`; `update_document` rewrites the R2 object and re-chunks/re-embeds, removing stale chunks and their vectors.
- [x] `recall` embeds the query, searches Vectorize scoped to the caller's `owner_id` (optionally filtered by `project_id`/`kinds`), and returns matching rows tagged with their `kind` (document_chunk results include the parent document's `id`/`title`).
- [x] Deleting a `thoughts` or `facts` row removes its Vectorize vector; deleting a `documents` row cascades to `document_chunks` and removes all their vectors.
- [x] `create_task`/`update_task`/`list_tasks` (including `priority` and `recurrence`), `upsert_person`/`list_people` (including `contact_info`), `create_project`/`list_projects`, and `record_time_series_point`/`list_time_series_points` work over their tables, scoped to the caller's `owner_id`.
- [x] `link` adds rows to the relevant junction table(s) for an existing thought, rejecting links to rows owned by a different user.
- [x] Derivation junction writes reject links to rows owned by a different user and reject `fact_source_facts` self-links.
- [x] `/api/v1/*` list/create routes exist for `projects`, `people`, `tasks`, `facts`, `thoughts`, `documents`, and `time-series-points` (with `GET /api/v1/documents/:id/content` serving the R2 object), plus `GET /api/v1/recall`.
- [x] `pnpm test` includes Vitest/Miniflare coverage for: embedding+Vectorize upsert on `remember`/`record_fact`/`add_document`; `recall` returning mixed-kind results scoped by owner; junction-table links created by `remember` and `link`; fact derivation links and supersession lifecycle; recurrence validation on tasks; time-series point append/list behavior; Vectorize/R2 cleanup on delete and on `update_document`.

Completion evidence: PBI-002 implementation added the Drizzle schema/migration, owner-scoped memory service, authenticated MCP tools, REST routes, R2 document storage, Workers AI/Vectorize side effects, and Vitest/Miniflare coverage. Verified with `pnpm check && pnpm typecheck && pnpm test`, `pnpm db:migrate`, and `pnpm build` on 2026-06-13; all passed.

PBI-004 (ADR-010, 2026-06-14) switched the embedding model to `@cf/qwen/qwen3-embedding-0.6b` and the Vectorize index dimension to 1024: `apps/worker/src/memory.ts` and `apps/worker/test/memory.test.ts` updated and verified with `pnpm check && pnpm typecheck && pnpm test` (31/31 passed) and `pnpm build`. The deployed `brainfog-vectors` index was deleted and recreated at dimension 1024 (cosine) with `owner_id`/`kind`/`project_id` metadata indexes, and all memory-model D1 rows were cleared (test data only; `users` and `tokens` preserved). The Worker was deployed (version `71f9fde0-b164-42d1-9b89-85c1d28fb7d8`) and verified end-to-end via the live MCP endpoint: `ping`, `remember`, `record_fact`, and `recall` (semantic scores 0.6897 and 0.8572 on the new 1024-dim index; `kind` metadata filtering returned results immediately, `project_id` filtering fell back to D1 while its metadata index finished propagating). Verification records were removed from D1/Vectorize afterward per this repo's own-codebase rule (`CLAUDE.md`/`ARCHITECTURE.md`).

### Regression Guardrails

- The platform baseline's bearer-token middleware and `/api/v1/health`/`/api/v1/whoami` behavior (`specs/platform-setup/spec.md`) must continue to pass unchanged — this spec only adds tables, tools, and routes.
- The Vectorize and Workers AI bindings declared in the platform baseline (`apps/worker/wrangler.jsonc`: `VECTORIZE` binding to `brainfog-vectors`, `AI` binding) are unchanged by this spec — only the embedding model (`@cf/qwen/qwen3-embedding-0.6b`, ADR-010) and the Vectorize index's dimension (1024) change.
- All new tables and routes must enforce `owner_id` scoping — no query in this spec may return or modify another user's rows, even when given a valid ID.
- Fact derivation links and time-series subject references must not become cross-user side channels; known in-model references are validated against the caller's `owner_id` before write or read.

### Scenarios

```gherkin
Feature: Memory model

  Scenario: Remembering a thought makes it recallable by meaning
    Given an authenticated user with a valid bearer token
    When they call the "remember" tool with content "Sarah prefers async standups over live meetings"
    Then a new row is created in thoughts owned by that user
    And an embedding for the thought is upserted into Vectorize using the thought row id
    And calling "recall" with a semantically similar query returns that thought

  Scenario: Recall returns thoughts and facts ranked together
    Given a thought and a fact with related content exist for the same user
    When they call "recall" with a query relevant to both
    Then the results include both the thought and the fact
    And each result is tagged with its kind, "thought" or "fact"

  Scenario: Recording a fact with multiple citations and a confidence score
    Given an authenticated user with a valid bearer token
    When they call "record_fact" with statement "Cloudflare D1 has no native vector type", citations ["developers.cloudflare.com", "github.com/asg017/sqlite-vec"], and confidence 0.95
    Then a new row is created in facts with that statement, both citations, and that confidence
    And an embedding for the fact is upserted into Vectorize using the fact row id

  Scenario: Recording a derived fact links it to source memories
    Given an authenticated user has an existing thought, fact, document, and document chunk
    When they call "record_fact" with a derived_from payload naming those source ids
    Then a new row is created in facts owned by that user
    And rows are created in fact_source_thoughts, fact_source_facts, fact_source_documents, and fact_source_document_chunks
    And links to rows owned by another user are rejected

  Scenario: Superseding a fact preserves the lifecycle of both facts
    Given an authenticated user has an existing current fact
    When they record a newer fact that supersedes the existing fact
    Then the newer fact has status "current" and supersedes_fact_id set to the older fact
    And the older fact has status "superseded" and superseded_by_fact_id set to the newer fact
    And a fact cannot supersede itself

  Scenario: Linking a thought to a person, a task, and a project
    Given a person and a task already exist for the same user, and a project exists for that user
    When they call "remember" with content referencing all three and a links payload naming the person and task ids and the project id
    Then the new thought is linked to the person via thought_people
    And linked to the task via thought_tasks
    And its project_id is set to the given project

  Scenario: Creating a recurring task
    Given an authenticated user with a valid bearer token
    When they call "create_task" with title "Take supplement" and recurrence frequency "daily", interval 1, and timezone "Africa/Johannesburg"
    Then a new task is created with the recurrence JSON stored
    And invalid recurrence intervals or invalid days of week are rejected

  Scenario: Recording generic time-series points
    Given an authenticated user with a valid bearer token
    When they call "record_time_series_point" with series_key "sleep.hours", value 7.5, unit "h", and an observed_at timestamp
    Then a new time_series_points row is created owned by that user
    And calling "list_time_series_points" for series_key "sleep.hours" and a matching time range returns that point
    And points owned by another user are not returned

  Scenario: Adding a document chunks and embeds its content
    Given an authenticated user with a valid bearer token
    When they call "add_document" with a title and Markdown content
    Then the content is stored in R2 at the document's r2_key
    And one or more document_chunks rows are created for that document
    And each chunk has an embedding upserted into Vectorize using the chunk row id
    And calling "recall" with a query matching a chunk's content returns that document together with the matching chunk

  Scenario: Deleting a thought removes its embedding
    Given a thought with an existing Vectorize entry
    When the thought is deleted
    Then the thoughts row no longer exists in D1
    And the corresponding vector id no longer exists in Vectorize
```
