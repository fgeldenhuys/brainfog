# PBI-023: Versioned Documents

## Directive

Implement caller-controlled document versioning so document writes can either overwrite the current version or create a dated historical version, and expose MCP/REST read paths for version metadata and previous-version retrieval.

## Scope

- **Spec:** `specs/memory-model/spec.md`
- **Covers DoD items:** Follow-up extension of the existing R2-backed document capability: `documents.r2_key` is canonical for current content, `document_chunks` and Vectorize entries are derived from current content, `update_document` rewrites content today, and document REST/MCP paths are authenticated and owner-scoped.
- **Out of scope:**
  - Automatic versioning of every document write without caller choice.
  - Branching/version graph semantics, merge/conflict resolution, or collaborative editing.
  - Diff generation or patch application between versions.
  - Changing R2 away from being canonical for full document bytes.
  - Making historical versions independently recallable by default.
  - Adding a browser UI for browsing document versions.
  - Changing bearer-token auth, token issuance, or owner scoping.
  - Accepting `owner_id`, `source`, `r2_key`, or trusted timestamps from clients.

## Dependencies

- ADR-008: R2 is canonical for full document content.
- Existing memory-model document schema, service helpers, REST routes, MCP tools, R2 binding, chunking, embedding, and owner-scoped bearer-token auth.
- PBI-022 direct document file transfer, because upload/download paths must preserve the same versioning semantics as inline `add_document`/`update_document` where applicable.
- `specs/sharing/spec.md` and ADR-011 for shared read behavior: sharing may widen reads, but cross-owner mutation remains forbidden.

## Context

Today `update_document(id, content)` always replaces the R2 object at `documents.r2_key`, deletes/recreates `document_chunks`, refreshes Vectorize entries, and updates `documents.updated_at`. This is correct for mutable working documents, but it loses prior content when a caller intended to preserve history.

The requested behavior is not automatic versioning on every update. The caller must choose the write mode explicitly: overwrite the current version in place, or create a new version and make it current. That choice must be visible in the MCP tool schema so agents cannot accidentally rely on implicit history.

Versions need dates associated with them. Use service-generated timestamps for version creation/update metadata. If the implementation accepts an optional caller-provided label or note, it must not treat caller-supplied timestamps as authoritative provenance.

The existing document model uses R2 for full content, D1 for metadata, and `document_chunks`/Vectorize as derived projections of the current document content. Historical content should follow the same D1/R2 source-of-truth split: D1 stores version metadata, R2 stores full historical bytes/text, and chunks for recall remain derived from the current version unless the spec is intentionally expanded later.

## Intent Preservation

1. **Caller controls versioning.** `update_document` and any direct-upload update path must expose an explicit mode such as `write_mode: "overwrite_current" | "create_version"`; do not silently create versions for all updates.
2. **Dates are service-owned.** Version rows must carry service-generated `created_at` or equivalent version dates. Caller-supplied dates may be stored only as non-authoritative metadata if needed.
3. **Current content remains simple.** `documents.r2_key` should continue to resolve the current document content, and existing recall/chunk paths should reflect only the current version unless a later spec explicitly indexes historical versions.
4. **R2 remains canonical for bytes.** Historical version content must be stored in R2, not only in D1 text blobs.
5. **D1 remains canonical for metadata.** Version numbers, current-version pointers, timestamps, size, MIME type, and ownership live in D1 and can rebuild derived indexes.
6. **Owner scoping is non-negotiable.** A caller may create, overwrite, list, or retrieve versions only for documents they own, except shared reads where existing sharing rules explicitly allow reading another user's document.
7. **Previous-version retrieval must not mutate state.** Reading historical content must not change current chunks, Vectorize entries, `documents.r2_key`, or `updated_at`.
8. **Overwrite means no new history.** When the caller chooses overwrite mode, do not create a document-version row as a side effect.
9. **New version means current changes.** When the caller chooses create-version mode, preserve enough metadata/content to retrieve the previous current version later and make the new content the current document version.
10. **No secret or content leakage.** Version metadata responses must not expose raw R2 keys as authority, bearer tokens, transfer secrets, or historical content unless the caller asks for a specific content/download endpoint.

## Implementation Plan

### 1. Confirm The Contract Boundary

- Inspect `specs/memory-model/spec.md`, `apps/worker/src/memory.ts`, `apps/worker/src/mcp/index.ts`, `apps/worker/src/routes/api.ts`, `packages/db/src/schema.ts`, and existing document tests.
- If the implementation needs to change the `specs/memory-model/spec.md` Contract section, pause and ask before editing it. This PBI intentionally describes the desired extension without rewriting the spec contract itself.
- Keep the implementation narrow: version only documents, not facts, thoughts, pages, or connector documents.

### 2. Add Document Version Metadata

- Add a Drizzle table, tentatively `document_versions`, with app-generated typed IDs if a new suffix is available or a documented typed suffix added deliberately.
- Minimum fields:
  - `id` primary key.
  - `document_id` foreign key to `documents.id` with `ON DELETE CASCADE`.
  - `owner_id` foreign key to `users.id` for fast owner scoping and provenance.
  - `source` for write provenance.
  - `version_number` integer, monotonically increasing per document.
  - `r2_key` for the historical version object.
  - `mime_type` and `size_bytes` for retrieval headers and metadata.
  - `created_at` as the version date.
  - Optional `label` or `note` only if it is useful and validated; do not expand into rich version metadata unless needed.
- Add indexes for `document_versions(document_id, version_number desc)`, `document_versions(owner_id, created_at desc)`, and any lookup needed for `document_id + id` or `document_id + version_number`.
- Add a migration that preserves all existing documents without backfilling fake historical versions unless needed for a stable current-version-number model.

### 3. Define Current vs Historical Semantics

- Treat `documents.r2_key` as the current version's R2 object.
- Decide and document in code whether `documents` needs `current_version_number` or whether it is derived from `max(document_versions.version_number) + 1` / metadata. Prefer the smallest robust schema that supports deterministic numbering.
- When creating a new document through `add_document` or direct upload, initialize it as current version 1 without requiring a historical `document_versions` row unless the chosen schema requires a row for current metadata.
- When updating with `write_mode: "overwrite_current"`, keep existing behavior: replace current R2 content, replace current chunks/vectors, update size and `updated_at`, and create no version row.
- When updating with `write_mode: "create_version"`, before replacing current content, persist the previous current content and metadata as a `document_versions` row if it has not already been preserved for the outgoing version; then write the new content to the current R2 key, refresh chunks/vectors, update size and `updated_at`, and advance version metadata.
- Ensure repeated `create_version` calls produce stable, increasing version numbers and allow retrieving each previous current version by ID and/or version number.

### 4. Extend Text Update Paths

- Update `updateDocument` input handling to accept an explicit write mode. Suggested shape: `update_document(id, content, write_mode?, derived_from?)`, where `write_mode` defaults only if the current API already needs backward compatibility. If defaulting is necessary, choose `overwrite_current` to preserve existing behavior.
- Validate `write_mode` in service logic and MCP schemas; reject unknown values with 400.
- Keep derivation/stale-edge behavior aligned with current content changes. `create_version` should mark downstream dependencies stale because current content changed; retrieving historical content should not.
- Update REST `PATCH /api/v1/documents/:id` to accept the same write mode.

### 5. Extend Direct File Transfer Paths

- Add write-mode support to any direct-upload path that updates an existing document. If no direct-upload update endpoint exists yet, do not invent a broad upload workflow; just ensure new versioning helpers are reusable and note the gap in tests or close-out.
- If direct upload remains create-only, `create_document_upload_link` does not need versioning mode. If an upload link can target an existing document, its MCP schema and REST endpoint must require or expose the same caller-controlled overwrite/create-version choice.
- Preserve binary behavior from PBI-022: text-like current versions are chunked/embedded; opaque binary current versions are stored but not semantically chunked.

### 6. Add Version Read APIs

- Add service helpers to list version metadata for a caller-owned document, returning current version metadata plus historical version rows in a stable order.
- Add service helpers to retrieve historical version content by `document_id` plus `version_id` or `version_number`.
- Add REST routes such as:
  - `GET /api/v1/documents/:id/versions` for metadata.
  - `GET /api/v1/documents/:id/versions/:versionId/content` for text content where MIME type is text-like.
  - `GET /api/v1/documents/:id/versions/:versionId/download` for exact bytes and safe download headers.
- Do not return raw historical content in metadata list responses.
- Historical reads should allow existing shared read behavior only if the parent document is readable under the sharing spec; they must never allow cross-owner writes.

### 7. Add MCP Tools

- Extend `update_document` schema and description to include the caller-selected write mode. The description must make clear that `overwrite_current` does not preserve history and `create_version` preserves the outgoing current content before replacing it.
- Add an MCP tool tentatively named `list_document_versions` with input `{ document_id }`, returning dated version metadata including current version info.
- Add an MCP tool tentatively named `get_document_version` with input `{ document_id, version_id? | version_number? }`, returning previous text content only for text-like historical versions and metadata for the selected version.
- If exact-byte historical downloads are needed through MCP, prefer returning authenticated REST download instructions like PBI-022 rather than inline binary/base64 bytes.
- Ensure MCP output does not expose bearer-token values, raw R2 keys, or binary file bytes.

### 8. Tests

- Add migration/schema tests or Worker tests proving `document_versions` applies cleanly and cascades on document delete.
- Test `update_document` with `write_mode: "overwrite_current"` replaces current content, refreshes chunks/vectors, and creates no version row.
- Test `update_document` with `write_mode: "create_version"` stores the previous content as a dated version, advances current content, refreshes chunks/vectors for current content only, and returns/list metadata with increasing version numbers.
- Test retrieving a previous text version returns the historical content while `getDocumentContent`, chunks, and recall still reflect the current content.
- Test binary historical version retrieval/download returns exact bytes and does not create meaningless chunks for opaque content.
- Test another user cannot create versions, overwrite, list private versions, or retrieve private historical content.
- Test shared read behavior for version metadata/content only if existing document shared reads already allow equivalent current-content access.
- Test MCP schemas for `update_document`, `list_document_versions`, and `get_document_version`.
- Test REST routes for metadata, text content, and exact-byte download where implemented.

## Verification

- `pnpm check && pnpm typecheck && pnpm test` pass.
- `pnpm db:migrate` or the repo's migration validation command applies the new migration cleanly.
- `pnpm build` passes if Worker route handling or bindings change.
- Targeted Worker tests demonstrate:
  - Caller-selected overwrite creates no historical version.
  - Caller-selected create-version preserves previous content with a service-generated date.
  - Version metadata is listable through REST and MCP.
  - A previous version can be retrieved without mutating current content, chunks, vectors, or document timestamps.
  - Current recall indexes only current content after versioned updates.
  - Owner scoping and applicable shared-read rules are enforced.

## Refinement Protocol

- If the desired behavior conflicts with `specs/memory-model/spec.md`, ADR-008, or `ARCHITECTURE.md`, pause and ask before changing the Contract or ADRs.
- If deterministic version numbering requires changing the `documents` table more than expected, keep the schema change minimal and document the invariant in this PBI before implementing.
- If historical versions should become independently recallable, split that into a separate spec/PBI; do not add historical chunk/vector indexing here.
- If direct upload update semantics are not present yet, do not expand PBI-022's transfer model solely to satisfy this PBI; implement reusable versioning primitives and leave direct-upload update as a separate PBI if needed.
- If binary historical content cannot be returned safely through MCP, provide REST download instructions instead of inline content.

## Close-Out Checklist

- [x] Document updates expose explicit overwrite vs create-version mode.
- [x] `document_versions` or equivalent D1 metadata stores dated historical versions with R2-backed content.
- [x] MCP exposes version metadata listing and previous-version retrieval.
- [x] REST exposes equivalent version metadata and previous-version content/download paths.
- [x] Current chunks and Vectorize entries represent current document content only.
- [x] Overwrite mode creates no version row; create-version mode preserves prior current content.
- [x] Owner scoping and applicable shared-read behavior are covered by tests.
- [x] `pnpm check && pnpm typecheck && pnpm test` pass.
- [x] Migration validation and `pnpm build` pass where applicable.

Close-out evidence (2026-06-23): implemented caller-controlled document versioning with `overwrite_current` and `create_version` write modes, D1-backed `document_versions` metadata, R2-backed historical bytes, REST/MCP version listing and retrieval, current-only chunk/Vectorize behavior, historical R2 cleanup on document delete, and owner/shared-read tests. Verification passed with `pnpm check && pnpm typecheck && pnpm test` (244/244 tests passed; existing Vitest close-timeout warning after success), `pnpm build`, and `pnpm exec wrangler d1 migrations apply DB --local` (no migrations to apply after implementation).

## Ship-PBI Log

- Iteration 1: implementor added document version schema, migration, service logic, REST routes, MCP tools, and tests. Deterministic gates passed (`pnpm check && pnpm typecheck && pnpm test`, 242/242 tests) and `pnpm build` passed. Critic found blocking/non-blocking issues around malformed non-string `write_mode`, undocumented new ID suffix, migration patch completeness, and missing cascade-delete coverage.
- Iteration 2: implementor fixed `write_mode` validation, reused the existing documented `d` suffix for document-version IDs, added cascade/delete and historical R2 cleanup tests, and confirmed migration SQL presence. Deterministic gates passed (`pnpm check && pnpm typecheck && pnpm test`, 244/244 tests) and `pnpm build` passed. Critic re-review found no blocking issues; only release hygiene remains to include untracked PBI/migration files in the final change set.
