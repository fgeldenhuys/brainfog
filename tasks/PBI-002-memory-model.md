# PBI-002: Memory Model

## Directive

Implement brainfog's core memory model on top of the platform baseline: D1/Drizzle schema and migrations for projects, people, tasks, facts, documents, document chunks, thoughts, generic time-series points, thought links, and fact derivation links; R2-backed document storage; Vectorize/Workers AI embeddings for thoughts, facts, and document chunks; MCP tools; REST routes; and tests proving owner-scoped recall and provenance-preserving writes.

## Scope

- Spec: `specs/memory-model/spec.md`
- Covers DoD items: all items in `specs/memory-model/spec.md`'s Definition Of Done.
- Out of scope:
  - Public signup, anonymous access, or any auth/token model change.
  - Domain-specific health, supplement, medical, commerce, or scheduling models beyond the generic tables already specified.
  - Rich media or binary attachment storage beyond Markdown/text documents in R2.
  - Document version history.
  - Replacing per-project ASDLC specs, ADRs, or PBIs with brainfog records.

## Dependencies

- PBI-001 must be implemented first: this PBI assumes the pnpm workspace, Cloudflare Worker, shared bearer-token middleware, D1/Drizzle setup, Vectorize/Workers AI bindings, MCP scaffold, REST scaffold, and test toolchain already exist.
- ADR-001 through ADR-008 are Accepted and binding.
- No new top-level npm dependency is authorized by this PBI. If implementation needs a tokenizer, text splitter, recurrence library, or other dependency, pause and follow `AGENTS.md`'s ASK rule.

## Context

The platform baseline intentionally created only `users` and `tokens` plus route/tool scaffolding. This PBI adds the first real memory surface. D1 remains canonical for all structured rows; R2 is canonical only for full document content; Vectorize is a derived index that can be rebuilt from D1/R2-derived chunk rows.

The spec includes generic time-series tracking and fact lifecycle/derivation support. These features are infrastructure for durable memory, not permission to store new sensitive categories by default. If implementation or seed data introduces personal/sensitive examples, pause and ask first per `AGENTS.md`.

## Intent Preservation

- All MCP tools under `/mcp` and all REST routes under `/api/v1/*` must use the platform baseline's shared bearer-token middleware. Do not add an unauthenticated memory route.
- `owner_id` is always derived from the authenticated token. Clients must never supply or override it.
- Every memory write must record provenance: `owner_id`, `source`, timestamps, and `project_id` where the target table supports it.
- D1 is the source of truth. Vectorize writes happen after D1 writes and may lag; recall must read final row data from D1 after vector search.
- Vector IDs must follow `<kind>:<id>` for `thought`, `fact`, and `document_chunk`; the Vectorize index dimension remains 768 for `@cf/baai/bge-base-en-v1.5`.
- R2 stores full document content. `document_chunks` are derived and rebuildable from R2 content.
- Fact derivation links and time-series subject references must reject cross-user references.
- Superseded or proven-wrong facts remain stored and recallable with lifecycle metadata; status changes must not silently delete history.
- Recurring task support is validation/storage of recurrence data, not a background scheduler.

## Verification

- `pnpm check && pnpm typecheck && pnpm test` pass.
- `pnpm db:migrate` applies the memory-model migration cleanly against local D1 on top of the PBI-001 `users`/`tokens` migration.
- `pnpm build` passes after adding R2/document/embedding code paths.
- Worker tests cover:
  - `remember` creates a thought, records provenance, upserts `thought:<id>` into Vectorize, and makes the thought recallable by meaning.
  - `record_fact` creates a fact with citations/confidence, optional derivation links, optional supersession, and upserts `fact:<id>` into Vectorize.
  - `update_fact` re-embeds when `statement` changes and preserves vectors/history for `superseded` and `proven_wrong` facts.
  - `add_document` writes content to R2, creates document chunks, embeds each chunk as `document_chunk:<id>`, and `update_document` removes stale chunks/vectors before re-chunking.
  - `recall` returns mixed `thought`, `fact`, and `document_chunk` results scoped to the authenticated `owner_id` and optional `project_id`/`kinds` filters.
  - `create_task`/`update_task` validate recurrence JSON and reject invalid recurrence intervals, days, or date ranges.
  - `record_time_series_point` and `list_time_series_points` append/list points by owner, series, subject, project, and time range.
  - `link` and all fact derivation junction writes reject rows owned by another user.
  - Deleting thoughts/facts/documents cleans up corresponding Vectorize entries, with document deletion cascading through chunks.
- REST tests or integration coverage prove the `/api/v1/*` routes mirror the MCP service layer and enforce the same owner scoping.

## Refinement Protocol

- If D1, Vectorize, R2, or Workers AI behavior makes any Contract item in `specs/memory-model/spec.md` infeasible, pause and update the spec through review rather than silently changing implementation behavior.
- If document chunking cannot be implemented adequately with in-repo code, ask before adding a dependency.
- If implementing generic time-series or fact derivation reveals a need for polymorphic hard foreign keys, prefer service-layer validation as specified unless the spec is explicitly changed.
- If implementing the web UI would expand substantially beyond minimal list/create/read surfaces, keep the UI minimal and defer richer UX to a later PBI.
