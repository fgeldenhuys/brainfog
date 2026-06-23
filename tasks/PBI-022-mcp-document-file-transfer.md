# PBI-022: MCP Document File Transfer

## Directive

Add MCP support for direct document file transfer so agents can back up and restore large or binary documents without passing file contents through inline MCP tool arguments or model context.

## Scope

- **Spec:** `specs/memory-model/spec.md`
- **Covers DoD items:** Follow-up extension of the existing R2-backed document capability: `add_document` writes full content to R2, `documents.r2_key` is canonical, `document_chunks` are derived for recall, and authenticated REST routes can serve document content.
- **Out of scope:**
  - Changing document storage away from R2 or making Vectorize canonical.
  - Adding a new Cloudflare product or external storage provider.
  - Adding resumable multipart uploads.
  - Adding a browser UI for file upload/download.
  - Indexing opaque binary archives into semantic chunks.
  - Accepting `owner_id`, `source`, or `r2_key` from clients.
  - Changing the bearer-token auth model or token issuance process.

## Dependencies

- ADR-008: R2 is canonical for full document content.
- ADR-013: Opaque document file transfers may store exact bytes in R2 without semantic chunks or embeddings.
- Existing memory-model document service, REST routes, MCP tool registration, and owner-scoped bearer-token auth.
- Existing page access-link/token-hashing patterns may be reused if short-lived direct transfer tokens are needed.

## Context

Today `add_document(title, content, ...)` is useful for normal text documents, but it forces the whole document body into the MCP tool payload. That is wasteful and risky for generated archives such as an `.opencode` config backup: the archive must be base64-encoded, consumes model/tool-call tokens, and can be truncated or exposed in conversation context. ADR-013 explicitly permits these opaque backup/restore objects to live in R2 as exact bytes without semantic chunks or embeddings.

A remote MCP server also cannot safely interpret a client-local file path like `/Users/.../backup.zip` and read it directly; that path exists on the MCP client machine, not inside the Cloudflare Worker. Direct file transfer must therefore use a protocol where the MCP tool creates a bounded, authenticated transfer capability, and the client uploads or downloads bytes over HTTP outside the model context.

The desired user flow is:

1. Agent creates a local archive, such as `backup.zip`.
2. Agent calls an MCP tool to create a direct upload target for a document title, MIME type, filename, and optional project.
3. Agent uploads the file bytes to the returned URL with `curl` or equivalent, without base64 and without putting the bytes in the MCP payload.
4. brainfog creates or finalizes a `documents` row, stores the original bytes in R2, records provenance, and chunks/indexes only when the uploaded content is text-like.
5. Agent can later call an MCP tool to create a direct download URL for a caller-owned document and write the original R2 object back to disk.

## Intent Preservation

1. **No file bytes in MCP arguments.** The new MCP tools must avoid inline base64/string content for large files; direct HTTP transfer carries the bytes.
2. **Auth remains mandatory.** All transfer creation and transfer execution must be authenticated or protected by short-lived, single-use, owner-scoped capabilities derived from authenticated MCP calls.
3. **D1/R2 provenance remains intact.** Every created document must have `owner_id`, `source`, timestamps, `r2_key`, `mime_type`, and `size_bytes` derived by the service, not client-supplied authority.
4. **R2 remains canonical.** Uploaded bytes live in R2; D1 stores metadata; `document_chunks` and Vectorize entries are derived and rebuildable.
5. **Text indexing is conditional.** Text-like uploads may be decoded, chunked, and embedded. Opaque binary uploads such as `.zip` must still become documents but should not create meaningless semantic chunks unless an explicit text extraction feature is added later.
6. **Owner scoping is non-negotiable.** Users can upload, finalize, and download only their own documents. Shared read behavior, if applicable, must follow existing sharing rules and must not allow cross-owner mutation.
7. **No secret leakage in logs or responses.** Transfer tokens, bearer tokens, upload URLs, and document bytes must not be logged or returned through recall/chunk paths.

## Implementation Plan

### 1. Confirm The Contract Boundary

- Inspect `apps/worker/src/mcp/index.ts`, `apps/worker/src/routes/api.ts`, and `apps/worker/src/memory.ts` for current document tool/route/service shape.
- If implementation requires changing the `specs/memory-model/spec.md` Contract section, pause and ask before editing it.
- Prefer a narrow follow-up implementation that reuses existing document service functions where possible.

### 2. Add Direct Transfer Service Helpers

- Add owner-scoped service helpers in `apps/worker/src/memory.ts` or a small adjacent module if the document code is already too large.
- Support creating a direct upload capability with inputs such as `title`, `filename?`, `mime_type?`, `project_id?`, `size_bytes?`, `sha256?`, and `indexing_mode?`.
- Support creating a direct download capability with `document_id` and optional filename hint.
- Use short-lived, single-use tokens or signed secrets hashed in D1 if the direct transfer endpoint cannot use the original bearer token safely.
- Keep capability rows or metadata minimal, expiring, and owner-scoped.
- Do not accept `owner_id`, `source`, `r2_key`, `created_at`, or `updated_at` from the client.

### 3. Add REST Transfer Endpoints

- Add authenticated or capability-authenticated upload and download endpoints under `/api/v1/documents/*` using existing route conventions.
- Upload endpoint must accept raw request bodies, stream/write bytes to R2, and create/finalize a `documents` row.
- Download endpoint must return the original R2 object with safe `content-type` and `content-disposition` headers.
- Validate MIME type and size metadata. Reject oversized bodies if the project already has a document size limit; otherwise add a conservative service-level limit and document it in tests.
- For text-like MIME types, decode content as UTF-8, create chunks, and embed as current `add_document` does.
- For opaque binary MIME types, store the bytes and document metadata, but do not create semantic chunks unless a safe text extraction path already exists.

### 4. Add MCP Tools

- Add an MCP tool for direct upload preparation, tentatively named `create_document_upload_link` unless a better existing naming convention is found.
- Add an MCP tool for direct download preparation, tentatively named `create_document_download_link` unless a better existing naming convention is found.
- Tool responses should include the URL, HTTP method, required headers, expiry, document id when known, and a concise restore/upload command example that does not include secret material in logs.
- Tool descriptions must explicitly state that bytes are transferred over the returned URL, not through the MCP argument payload.

### 5. Tests

- Add Worker/Vitest coverage for upload-link creation requiring auth and validating project ownership.
- Test direct upload of a text file creates a document, writes R2, creates chunks, and makes recall possible.
- Test direct upload of a zip or `application/octet-stream` file writes R2 and metadata without creating meaningless chunks or Vectorize entries.
- Test direct download returns the exact uploaded bytes and safe headers for the owning user.
- Test another user cannot upload into, finalize, or download a document/capability owned by someone else.
- Test expired or already-used transfer capabilities fail closed if capability tokens are implemented.
- Test MCP tool registration and schemas for both new tools.

## Verification

- `pnpm check && pnpm typecheck && pnpm test` pass.
- `pnpm build` passes if Worker route handling or bindings change.
- Targeted Worker tests demonstrate:
  - Text direct upload stores R2 content, creates `documents`/`document_chunks`, embeds chunks, and supports recall.
  - Binary direct upload stores and downloads exact bytes without embedding opaque content.
  - Direct download returns byte-for-byte original R2 content for an owned document.
  - Cross-owner and expired/single-use transfer attempts are rejected.
  - New MCP tools are available and return transfer instructions without inline file content.

## Refinement Protocol

- If MCP cannot represent the desired direct transfer flow with two tools cleanly, implement the smallest safe MCP-plus-REST handshake and document the actual tool names in this PBI before coding.
- If the work requires a new table for transfer capabilities, add a Drizzle migration and tests; keep the schema owner-scoped, expiring, and minimal.
- If the work requires changing the memory-model Contract or ADR-008, pause and ask before editing those sections.
- If binary indexing or archive inspection becomes desirable, split that into a separate extraction/indexing PBI rather than expanding this one.
- If signed upload/download URLs would expose long-lived bearer tokens or secrets, use short-lived one-time capability tokens instead.

## Close-Out Checklist

- [x] MCP exposes direct upload preparation for documents without inline file bytes.
- [x] MCP exposes direct download preparation for existing documents without returning file bytes inline.
- [x] REST transfer endpoints write/read R2 objects safely and preserve owner scoping.
- [x] Text uploads continue to chunk/embed; opaque binary uploads do not create meaningless chunks.
- [x] Tests cover auth, owner scoping, expiry/single-use behavior where applicable, text upload, binary upload, and exact-byte download.
- [x] `pnpm check && pnpm typecheck && pnpm test` pass.
- [x] `pnpm build` passes if Worker route handling changed.

Close-out evidence (2026-06-23): implemented bearer-authenticated direct REST upload/download endpoints backed by R2, service helpers for exact-byte document storage/download, conditional UTF-8 chunking for text-like uploads, and MCP instruction tools that return no file bytes or bearer-token values. Verification passed with `pnpm check`, `pnpm typecheck && pnpm test && pnpm build` (Vitest reported the existing post-run close-timeout warning after all 233 tests passed).
