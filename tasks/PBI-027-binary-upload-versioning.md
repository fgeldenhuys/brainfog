# PBI-027: Binary Upload Versioning

## Directive

Add versioning support to the binary document upload path so callers can update existing documents (not just create new ones) and choose between overwriting the current version and preserving the outgoing content as a dated historical version.

## Scope

- **Spec:** `specs/memory-model/spec.md`
- **Covers DoD items:** Follow-up extension of the existing R2-backed document capability: `documents.r2_key` is canonical for current content, `document_versions` stores historical versions (PBI-023), `createDocumentUploadLink`/`createDocumentFromBytes` handle creation from raw bytes (PBI-022), and `updateDocument` handles versioned text updates.
- **Out of scope:**
  - Changing the existing `POST /documents/direct-upload` create-only behavior or its callers.
  - Changing the existing `update_document` MCP tool signature or service function.
  - Adding auto-versioning or version-on-delete.
  - Adding a browser UI for binary upload or version management.
  - Changing bearer-token auth, owner scoping, or sharing semantics.
  - Adding resumable or multipart uploads.

## Dependencies

- ADR-008: R2 is canonical for full document content.
- ADR-013: Opaque document file transfers may store exact bytes in R2 without semantic chunks or embeddings.
- PBI-022: Direct document file transfer (MCP `create_document_upload_link`, REST `POST /documents/direct-upload`, service `createDocumentFromBytes`).
- PBI-023: Versioned documents (D1 `document_versions` table, `write_mode` on `updateDocument`, REST/MCP version list/retrieval paths).
- Existing `updateDocument` service function with `write_mode` support and historical R2 key naming pattern (`${userId}/${docId}/versions/${versionNumber}-${versionId}`).

## Context

Today two document write paths exist:

1. **Text path** (`update_document` MCP tool / `PATCH /documents/:id` REST / `updateDocument` service): accepts `string` content with an explicit `write_mode` (`"overwrite_current"` or `"create_version"`). When `create_version` is chosen, the previous current R2 object is copied to a historical key and a `document_versions` row is inserted.

2. **Binary path** (`create_document_upload_link` MCP tool / `POST /documents/direct-upload` REST / `createDocumentFromBytes` service): accepts raw `ArrayBuffer` bytes via HTTP POST, always creates a brand-new document. There is no update path for binary/opaque documents at all.

This means a user cannot update an existing binary document — such as re-uploading an opencode config backup as a new version — without manually deleting and recreating the document, which loses provenance and version history. The schema and infrastructure exist (`documents.currentVersionNumber`, `document_versions` table, R2 historical keys, `getDocumentVersionBytes`, version list/retrieval endpoints), but no code wires them together for the binary upload path.

The implementor should read `updateDocument` in `apps/worker/src/memory.ts` for the versioning pattern (historical R2 copy → `document_versions` insert → current content replace → `currentVersionNumber` increment), and replicate a byte-oriented version in the new `updateDocumentFromBytes`.

## Intent Preservation

1. **No file bytes in MCP arguments.** The updated `create_document_upload_link` MCP tool must never accept or return inline file bytes; the HTTP transfer carries the bytes.
2. **Update links remain authenticated and owner-scoped.** Every update via `create_document_upload_link` + `document_id` must verify ownership of the targeted document before returning upload instructions, and the direct-upload endpoint must re-verify ownership when bytes arrive.
3. **Caller controls versioning.** `write_mode` must default to `"overwrite_current"` for backward compatibility and must be explicitly selected; never silently create versions.
4. **`overwrite_current` creates no history.** When the caller chooses overwrite, no `document_versions` row or historical R2 copy is created.
5. **`create_version` preserves outgoing bytes in R2 before replacing current content.** Historical bytes live in R2 at a versioned key; D1 stores only metadata and the historical `r2_key`. Do not store version bytes inline in D1.
6. **Current chunks/Vectorize entries represent only current content.** When a document's current content (text-like or opaque) changes, delete all existing `document_chunks` and their Vectorize vectors, then regenerate only from the new current bytes.
7. **Existing create-only `POST /documents/direct-upload` behavior is preserved.** Adding update support must not change the create path's schema, validation, or response shape.
8. **No metadata mutation on update.** `PATCH /documents/:id/direct-upload` does not accept `title`, `project_id`, or any fields other than `mime_type`, `filename`, and `write_mode`. Document rename or project move is out of scope.
9. **No client-supplied provenance.** `owner_id`, `source`, `r2_key`, and timestamps are always service-derived; reject them if supplied.
10. **No secret or R2 key leakage.** Upload URLs, bearer tokens, and raw R2 keys must not appear in MCP responses, logs, version metadata, or recall paths.

## Implementation Plan

### 1. Confirm The Contract Boundary

- Inspect `apps/worker/src/memory.ts` for `updateDocument`, `createDocumentFromBytes`, `createDocumentUploadLink`, and `getDocumentVersionBytes`.
- Inspect `apps/worker/src/routes/api.ts` for the existing `POST /documents/direct-upload` handler and any `PATCH /documents/:id` handler.
- Inspect `apps/worker/src/mcp/index.ts` for `create_document_upload_link` and `update_document` tool definitions.
- If the implementation requires changing the `specs/memory-model/spec.md` Contract section, pause and ask before editing it.

### 2. Add `updateDocumentFromBytes` Service Function

- Add a service function `updateDocumentFromBytes(ctx, id, bytes, write_mode?, mime_type?, filename?)` in `apps/worker/src/memory.ts`.
- Input shape mirrors `createDocumentFromBytes` but adds `id` and optional `write_mode` (defaulting to `"overwrite_current"`, same as `updateDocument`).
- Accept `ArrayBuffer` bytes and optional MIME type/filename metadata.
- When `write_mode === "create_version"`, follow `updateDocument`'s pattern:
  - Fetch the current R2 object at `documents.r2_key`.
  - Copy its bytes to a historical key using the existing naming convention (`${userId}/${docId}/versions/${versionNumber}-${versionId}`).
  - Insert a `document_versions` row with the historical `r2_key`, provenance, version number, size, and MIME type.
  - Increment `documents.currentVersionNumber`.
- When `write_mode === "overwrite_current"`, skip historical preservation entirely.
- In both cases: write the new bytes to the existing `documents.r2_key`, update `sizeBytes`, `mimeType` (if provided), and `updatedAt`.
- **Always delete existing `document_chunks` and their Vectorize vectors before regenerating** — matching `updateDocument`'s behavior. This handles MIME-class changes (text→binary and binary→text) correctly.
- For text-like MIME types: decode bytes as UTF-8 (reject invalid UTF-8 with 400) and regenerate chunks/vectors for current content.
- For opaque binary MIME types: store bytes but do not create semantic chunks or embeddings.
- Mark downstream dependencies stale when current content changes (same behavior as `updateDocument`).

### 3. Add REST Endpoint For Binary Update

- Add a `PATCH /documents/:id/direct-upload` route in `apps/worker/src/routes/api.ts`.
- Accept only `filename`, `mime_type`, and `write_mode` as query/header metadata. **Reject `title` and `project_id` with 400** — document rename or project move is out of scope.
- Read raw bytes from request body via `c.req.arrayBuffer()`.
- Delegate to `updateDocumentFromBytes`.
- Return the updated document row and cascaded project relationships.
- Reject invalid `write_mode` values with 400.

### 4. Update `createDocumentUploadLink` For Update Path

- Extend the MCP tool `create_document_upload_link` to accept an optional `document_id` parameter.
- Use conditional input validation:
  - **Create mode** (`document_id` absent): `title` is required (unchanged existing behavior).
  - **Update mode** (`document_id` present): `title` is rejected if supplied (the target document already has a title). `write_mode` is optional (`"overwrite_current"` default).
  - Any combination that violates these rules returns 400.
- When `document_id` is provided:
  - Verify the caller owns the targeted document (reuse existing `getOwnedDocument`).
  - Return a `PATCH` URL to `/api/v1/documents/${documentId}/direct-upload` instead of a `POST` URL to the create-only path.
  - Include `write_mode` as an optional query parameter in the returned URL documentation.
- When `document_id` is omitted, preserve existing create-only behavior: `title` required, `POST` URL returned.
- Update the MCP tool description to note that providing a `document_id` targets an existing document for update, optionally with versioning.
- Do not accept `owner_id`, `source`, `r2_key`, or `created_at` from the client.

### 5. Tests

- Test `updateDocumentFromBytes` with `write_mode: "overwrite_current"` replaces current R2 content, updates metadata, and creates no version row.
- Test `updateDocumentFromBytes` with `write_mode: "create_version"` preserves previous bytes as a `document_versions` row, increments `currentVersionNumber`, and makes new bytes the current content.
- Test binary upload update via `PATCH /documents/:id/direct-upload` with both write modes.
- Test that the existing `POST /documents/direct-upload` create-only path is unchanged.
- Test that `create_document_upload_link` with a `document_id` returns `PATCH` instructions for an owned document.
- Test that `create_document_upload_link` without `document_id` still returns existing `POST` instructions.
- Test that another user cannot update bytes on a document they do not own.
- Test that text-like binary updates regenerate chunks/vectors for current content.
- Test that opaque binary updates (e.g. `application/zip`) do not create meaningless chunks.
- Test that a version created via binary update is retrievable through existing `GET /documents/:id/versions/:version/download` and returns exact bytes.
- Test that `list_document_versions` and `get_document_version` MCP tools work correctly for versions created via binary update.
- Test that updating a previously text-like document with opaque binary bytes deletes old `document_chunks` and Vectorize vectors.
- Test that updating a previously opaque binary document with text-like bytes creates current chunks/vectors.
- Test that text-like MIME + invalid UTF-8 returns 400 and leaves current R2 content, metadata, chunks, version rows, and `currentVersionNumber` unchanged.

## Verification

- `pnpm check && pnpm typecheck && pnpm test` pass.
- `pnpm build` passes if Worker route handling or bindings change.
- Targeted Worker tests demonstrate:
  - Binary update with `overwrite_current` replaces content without creating a version row.
  - Binary update with `create_version` preserves historical bytes as a retrievable version and increments the version counter.
  - The existing `POST /documents/direct-upload` create-only path is fully preserved.
  - Updated `create_document_upload_link` MCP tool returns correct REST instructions for both create and update paths.
  - Cross-owner binary update attempts are rejected.
  - Historical binary versions return exact bytes via existing version-download paths.

## Close-Out Checklist

- [x] `updateDocumentFromBytes` service function added with `write_mode` support (overwrite_current / create_version).
- [x] `PATCH /documents/:id/direct-upload` REST endpoint accepts binary update with write_mode, rejects title/project_id/provenance fields.
- [x] `create_document_upload_link` MCP tool extended with optional `document_id`; conditional validation (create: title required; update: document_id required, title/project_id rejected).
- [x] Write-mode support: overwrite_current creates no history; create_version preserves outgoing bytes as R2-backed `document_versions` row.
- [x] Current chunks/Vectorize entries always represent current content — stale chunks deleted on every update, MIME-class transitions handled (text→binary, binary→text).
- [x] Invalid UTF-8 for text-like binary updates rejected with 400 before any mutation.
- [x] Existing `POST /documents/direct-upload` create-only behavior and response shape preserved (no `currentVersionNumber` in create returns).
- [x] Metadata mutation protection: omitted `mime_type` in update mode does not silently default; provenance fields rejected if supplied.
- [x] Cross-owner binary update attempts rejected.
- [x] Historical binary versions retrievable via existing `GET /documents/:id/versions/:version/download`.
- [x] `pnpm check && pnpm typecheck && pnpm test` pass (294 tests, 12 files, 0 failures).

Close-out evidence (2026-06-25): implemented `updateDocumentFromBytes` service function, `PATCH /documents/:id/direct-upload` REST endpoint with provenance-field rejection, extended `create_document_upload_link` MCP tool with conditional create/update validation and write_mode, stale-chunk cleanup on MIME-class transitions, invalid-UTF-8 rejection, and create-path response-shape preservation. Three critic findings fixed in iteration 2 (create shape regression, MIME defaulting, provenance rejection). Verification passed with `pnpm check`, `pnpm typecheck`, `pnpm test` (294/294 tests passed across 12 files).

## Refinement Protocol

- If the desired behavior conflicts with `specs/memory-model/spec.md`, ADR-008, or `ARCHITECTURE.md`, pause and ask before changing the Contract or ADRs.
- If the MCP tool `create_document_upload_link` should not be extended with `document_id` (e.g. because the name becomes misleading), add a separate `update_document_upload_link` MCP tool instead.
- If the direct-upload update endpoint should use `PUT` instead of `PATCH`, use whichever fits the existing route conventions better; document the choice in close-out.
- If migrating existing R2 objects from a pre-versioning layout is needed, keep the migration narrow and additive; do not rewrite existing keys unless tests prove they are inconsistent.
