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
- App-generated row IDs must follow the memory-model spec's lowercase typed brainfog ID format: `bf<20 lowercase Crockford Base32 chars><type suffix>`.
- Vector IDs must exactly match the embedded D1 row ID for `thoughts`, `facts`, and `document_chunks`; keep `kind` in Vectorize metadata for filtering and result resolution. The Vectorize index dimension remains 768 for `@cf/baai/bge-base-en-v1.5`.
- R2 stores full document content. `document_chunks` are derived and rebuildable from R2 content.
- Fact derivation links and time-series subject references must reject cross-user references.
- Superseded or proven-wrong facts remain stored and recallable with lifecycle metadata; status changes must not silently delete history.
- Recurring task support is validation/storage of recurrence data, not a background scheduler.

## Verification

- `pnpm check && pnpm typecheck && pnpm test` pass.
- `pnpm db:migrate` applies the memory-model migration cleanly against local D1 on top of the PBI-001 `users`/`tokens` migration.
- `pnpm build` passes after adding R2/document/embedding code paths.
- Worker tests cover:
  - `remember` creates a thought with a typed brainfog ID, records provenance, upserts that row ID into Vectorize, and makes the thought recallable by meaning.
  - `record_fact` creates a fact with a typed brainfog ID, citations/confidence, optional derivation links, optional supersession, and upserts that row ID into Vectorize.
  - `update_fact` re-embeds when `statement` changes and preserves vectors/history for `superseded` and `proven_wrong` facts.
  - `add_document` writes content to R2, creates document chunks with typed brainfog IDs, embeds each chunk using its row ID as the vector ID, and `update_document` removes stale chunks/vectors before re-chunking.
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

## Ship-PBI Log

### Iteration 1 Critic Report

Verdict: Blocked.

Blocking findings:

1. Vector ID convention conflicts with `ARCHITECTURE.md`: architecture says `<kind>:<D1 row id>`, while the PBI/spec and implementation use bare D1 row IDs.
2. Required MCP memory tools are not implemented; MCP still exposes only placeholder `ping`.
3. `updateFact` can create cross-user fact supersession references because it does not owner-validate referenced facts.
4. `recall` trusts Vectorize `project_id` metadata and does not re-check D1 project scope during final row resolution.
5. Test coverage is missing MCP coverage, cross-user derivation rejection, `update_task` recurrence validation, `update_document` stale-vector deletion, and mixed/project-filtered recall coverage.

Verification reported by critic:

- `pnpm check && pnpm typecheck && pnpm test` passed, with Vitest close-timeout warning after successful tests.
- `pnpm build` passed.
- `pnpm db:migrate` passed.

Should-consider:

- `deleteThought` / `deleteFact` return `{ ok: true }` when no owned row is deleted.
- Ensure untracked in-scope files are included before final closeout.

### Iteration 2 Critic Report

Verdict: Blocked.

Cleared from iteration 1:

- MCP memory tools, owner validation in `updateFact`, recall project re-validation, and missing test coverage gaps were fixed.
- Vectorize ID convention was resolved as stale architecture wording; vector IDs remain exact D1 row IDs with `kind` in metadata.

Blocking findings:

1. Cross-user delete can remove another user's Vectorize entry: `deleteThought` and `deleteFact` perform owner-scoped D1 deletes but unconditionally call `deleteVectors(ctx, [id])`. Required fix: only delete vectors after confirming an owned row exists/deleted; preferably 404 when absent, matching `deleteDocument`.
2. Rejected cross-user link/derivation writes can leave partial parent rows behind: `remember` inserts a thought before validating links, and `recordFact` inserts a fact before validating derivations. Required fix: validate references before parent insert or use transaction/rollback-safe flow, with regression coverage that failed cross-user writes do not create parent rows or partial junction rows.

Verification reported by critic:

- `pnpm check && pnpm typecheck && pnpm test` passed.
- `pnpm build` passed.
- `pnpm db:migrate` passed.

### Manual Retry After Iteration Budget

Requested by user: retry the final fix directly in-session without a subagent.

Fixes applied:

- `updateFact` now treats omitted supersession fields differently from explicit `null`, so `supersedes_fact_id` and `superseded_by_fact_id` can be cleared.
- `updateFact` now maintains reciprocal supersession pointers in both directions when setting, changing, or clearing `supersedes_fact_id` / `superseded_by_fact_id`.
- Regression coverage was added for changing and clearing `supersedes_fact_id`, and for setting and clearing `superseded_by_fact_id` from the opposite side.
- Intended untracked PBI implementation files were marked intent-to-add so `git diff main -- .` includes them for review visibility.

Verification:

- `pnpm --filter @brainfog/worker test -- memory.test.ts` passed with 22 tests.
- `pnpm check && pnpm typecheck && pnpm test` passed with 22 tests.
- `pnpm db:migrate && pnpm build` passed.

Should-consider:

- `deleteThought` / `deleteFact` returning `{ ok: true }` for not-owned IDs is misleading; returning `404` aligns with `deleteDocument`.
- Ensure untracked in-scope files are included before final closeout.

### Iteration 3 Critic Report

Verdict: Blocked.

Cleared from iteration 2:

- Owner-scoped delete now 404s before deleting vectors.
- Cross-user rejected `remember` / `record_fact` writes validate references before parent insertion and have regression coverage.

Blocking findings:

1. `recall(kinds=...)` does not apply the required Vectorize `kind` filter before `topK`; it currently omits `kind` from the Vectorize query filter and filters returned matches afterward, which can drop valid requested-kind results.
2. `update_task` accepts `project_id` at the REST/MCP surface but silently ignores it; the service should either implement project updates with owner validation or remove the field through spec review. The accepted fix is to implement project updates with `ensureProject` owner validation, including null-clearing behavior.

Verification reported by critic:

- `pnpm check && pnpm typecheck && pnpm test` passed.
- `pnpm build` passed.
- `pnpm db:migrate` passed.

## Completion Evidence

Status: complete.

Implemented:

- D1/Drizzle memory model schema and migration for projects, people, tasks, facts, documents, document chunks, thoughts, time-series points, thought links, and fact derivation links.
- Owner-scoped memory service preserving provenance (`owner_id`, `source`, timestamps, and supported `project_id`) with D1 as canonical storage.
- R2-backed document storage with derived/rebuildable `document_chunks`.
- Workers AI embedding and Vectorize upsert/delete paths for thoughts, facts, and document chunks, using exact D1 row IDs as vector IDs and `kind` metadata.
- Authenticated MCP tools and REST routes mirroring the same service layer.
- Vitest/Miniflare coverage for typed IDs, owner scoping, provenance, recall, links, fact lifecycle/derivations, recurrence validation, time-series operations, R2/document chunking, and Vectorize cleanup.

Verification run before closeout:

- `pnpm --filter @brainfog/worker test -- memory.test.ts` passed with 22 tests.
- `pnpm check && pnpm typecheck && pnpm test` passed with 22 tests.
- `pnpm db:migrate` passed against local and remote D1 with no pending migrations after application.
- `pnpm build` passed (`wrangler deploy --dry-run`).

Notes:

- Existing non-failing warnings remain: Biome config schema/deprecation infos, Miniflare local AI/Vectorize warnings, SDK sourcemap warnings, and Vitest close-timeout notice after successful tests.
- No new top-level dependency was added.
- No auth/token model change was made.
- `.dev.vars.example` documents required secret names only and contains no secret values.
