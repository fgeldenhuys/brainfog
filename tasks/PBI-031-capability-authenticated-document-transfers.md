# PBI-031: Capability-Authenticated Document Transfers

## Directive

Replace the current MCP document transfer instruction flow with short-lived, single-use, owner-scoped transfer capabilities so agents can upload and download document bytes through brainfog HTTP endpoints without reusing or exposing their long-lived bearer token in the transfer command.

## Scope

- Spec: `specs/memory-model/spec.md`
- Covers DoD items: follow-up hardening for R2-backed document upload/download behavior, MCP `create_document_upload_link` / `create_document_download_link` transfer tools, direct byte transfer through Worker endpoints, document provenance, versioned update semantics, PDF extraction/indexing semantics, and exact-byte R2 download semantics.
- Out of scope:
  - Raw R2 presigned URLs or direct client-to-R2 access.
  - Changing document storage away from R2 or making Vectorize canonical.
  - Changing the long-lived bearer-token issuance model.
  - Removing existing bearer-authenticated REST upload/download paths used by web/API callers.
  - Adding resumable, multipart, or chunked upload protocols.
  - Adding new document indexing behavior beyond the existing text/PDF/indexing-mode rules.
  - Exposing document bytes inline through MCP tool responses.

## Dependencies

- ADR-004: per-user bearer tokens remain the primary authentication model for `/mcp` and `/api/v1/*` requests.
- ADR-008: R2 remains canonical for full document bytes; D1 remains canonical for document metadata.
- ADR-013: direct document transfer flows may use short-lived, owner-scoped upload/download capabilities while keeping file bytes out of MCP payloads.
- PBI-022: MCP document file transfer and direct Worker upload/download routes.
- PBI-027: binary upload update/versioning path with `write_mode` support.
- PBI-029: brainfog-owned document version numbering and explicit overwrite-vs-version semantics.
- PBI-030: PDF extraction/indexing and explicit `indexing_mode` behavior.

## Context

The existing MCP transfer tools avoid inline file bytes, but their returned instructions still require the caller to supply the user's existing bearer token when running `curl` or an equivalent HTTP transfer. That creates an avoidable secret-handling problem: the long-lived bearer token can appear in shell history, task logs, MCP transcripts, or agent output even though the authenticated MCP tool call already proved the user's identity.

The safer flow is a capability handshake:

1. The agent authenticates normally to `/mcp` with the user's existing token.
2. The MCP tool validates ownership and requested operation details.
3. brainfog mints a short-lived, single-use transfer capability scoped to that exact operation.
4. The tool returns a Worker URL plus transfer instructions that require only the capability token, not the user's bearer token.
5. The Worker transfer endpoint verifies the capability, performs the upload/download, marks the capability consumed, and preserves the same document service semantics as the existing bearer-authenticated path.

Capabilities are not R2 credentials. Bytes must continue to flow through the Cloudflare Worker so brainfog can enforce owner scoping, max size, D1/R2 provenance, versioning, PDF extraction, chunk regeneration, Vectorize updates, safe response headers, and audit-friendly behavior at one boundary.

## Intent Preservation

1. **MCP tool creation remains bearer-authenticated.** The capability is minted only after an authenticated MCP call resolves to a D1 user and validates all requested operation details.
2. **The transfer endpoint may use only the capability.** Upload/download HTTP commands returned by MCP must not require the caller's long-lived bearer token. Existing bearer-auth REST routes may remain for web/API compatibility.
3. **Capabilities are short-lived and single-use.** A capability must expire quickly, be marked consumed on successful use, and fail closed after expiry or reuse.
4. **Capabilities bind operation details.** The server-side capability record or signed payload must bind at least: operation (`create`, `update`, `download`), owner id, `project_id` or `document_id` as applicable, `title`, `filename`, `mime_type`, `write_mode`, `indexing_mode`, maximum accepted size, and expiry. A transfer request must not override bound values.
5. **Capabilities are owner-scoped.** Create capabilities can only target owned projects; update/download capabilities can only target caller-owned documents. Shared read behavior must not become write authority.
6. **No raw R2 access.** Returned URLs must point to Worker routes, not R2 presigned URLs. Raw `r2_key` values remain internal.
7. **No secret or byte leakage.** Bearer tokens, capability token plaintext, raw R2 keys, upload/download bytes, extracted PDF text dumps, and full transfer URLs containing secrets must not be logged or returned through MCP beyond the one intended tool response.
8. **D1/R2 provenance is unchanged.** Uploads and updates must continue to derive `owner_id`, `source`, timestamps, R2 key, size, current version number, and historical version rows server-side.
9. **Indexing semantics are unchanged.** Text uploads, opaque binary uploads, PDF extraction, `indexing_mode=auto|skip`, manual PDF text indexing, chunk deletion/regeneration, and Vectorize upserts/deletes must behave exactly as the current service layer defines.
10. **Failure is atomic where possible.** Expired, reused, oversized, wrong-method, wrong-operation, wrong-document, wrong-MIME, invalid-UTF-8, and failed-PDF-extraction transfers must not leave partial D1/R2 state beyond any explicitly existing safe cleanup behavior.

## Implementation Plan

### 1. Confirm Current Transfer Boundaries

- Inspect the current document transfer code before changing it:
  - `apps/worker/src/mcp/index.ts` for `create_document_upload_link` and `create_document_download_link` tool schemas/responses.
  - `apps/worker/src/routes/api.ts` for direct upload/download endpoints and bearer-auth middleware boundaries.
  - `apps/worker/src/memory.ts` for `createDocumentUploadLink`, `createDocumentDownloadLink`, `createDocumentFromBytes`, `updateDocumentFromBytes`, download helpers, versioning, and PDF/indexing paths.
  - `packages/db` schema/migrations for whether a reusable token/capability table pattern already exists.
- If this work requires changing `specs/memory-model/spec.md`'s Contract section, pause and ask before editing it.
- Keep the implementation additive to existing bearer-auth REST behavior unless tests prove the old path is unsafe or dead.

### 2. Add A Transfer Capability Model

- Add a narrow capability representation, preferably D1-backed with plaintext token returned only once and a hashed token stored server-side. Reuse existing token-hashing/page-access-link patterns where appropriate.
- Store the minimum state needed to enforce the transfer:
  - `id` with the project ID convention if a persisted row is introduced.
  - `owner_id`.
  - `operation`: `create`, `update`, or `download`.
  - `project_id` for create, nullable when absent.
  - `document_id` for update/download.
  - Bound metadata: `title`, `filename`, `mime_type`, `write_mode`, `indexing_mode`, and `max_size_bytes` as applicable.
  - Expiry timestamp, consumed timestamp, created timestamp, and source/provenance fields sufficient to audit the capability minting event.
- Default expiry should be short (assume 10-15 minutes unless an existing convention is present); tests should avoid depending on wall-clock flakiness.
- The plaintext capability must be high entropy, not derived from row IDs or bearer tokens, and never persisted in plaintext.
- Capability verification must be constant-behavior from the caller's perspective: unknown, expired, consumed, wrong owner, or mismatched operation all return safe 401/403/410-style failures without leaking which condition matched.

### 3. Mint Capabilities From MCP Tools

- Update `create_document_upload_link` so the authenticated MCP call validates all inputs and returns a capability-authenticated Worker upload URL.
- Preserve the current create/update input semantics:
  - Create mode: `title` is required; optional `project_id`, `filename`, `mime_type`, `indexing_mode`, and size hint/limit are bound into the capability.
  - Update mode: `document_id` is required; the target document must be owned by the caller; `write_mode` defaults as currently defined; allowed `mime_type`, `filename`, `indexing_mode`, and max-size details are bound into the capability.
  - Invalid provenance fields (`owner_id`, `source`, `r2_key`, timestamps) are rejected if they can appear in the input surface.
- Update `create_document_download_link` so it validates document ownership and returns a capability-authenticated Worker download URL bound to that `document_id` and optional filename hint.
- Tool responses should include method, URL, expiry, max size for uploads, expected content type/header guidance, and a concise command example that does not include any bearer token.
- Tool responses must not include raw R2 keys, document bytes, extracted text, or any reusable secret beyond the one transfer capability embedded in or supplied with the transfer URL/instructions.

### 4. Add Capability-Authenticated Worker Transfer Routes

- Add Worker routes for capability-authenticated transfers, either under the existing document route namespace or a clearly named transfer namespace.
- These routes must verify the capability before reading or writing document bytes:
  - Upload/create: accept raw bytes, enforce bound method/operation, MIME type, max size, title, project ownership, and `indexing_mode`; delegate to the existing document byte-create service.
  - Upload/update: accept raw bytes, enforce bound method/operation, `document_id`, MIME type, max size, `write_mode`, and `indexing_mode`; delegate to the existing byte-update/versioning service.
  - Download: stream/return the existing R2 object for the bound owned document with safe `content-type` and `content-disposition` headers.
- Mark a capability consumed only after the transfer has passed validation and the document operation/download is successful. If the current implementation needs consume-before-use to prevent races, it must be paired with rollback or clear retry behavior and tests.
- Do not bypass existing service-layer document functions for D1/R2 writes, chunk cleanup, PDF extraction, Vectorize writes/deletes, version creation, dependency staleness, or provenance.
- Keep existing bearer-authenticated REST routes available for browser/API clients. If implementation shares route handlers, ensure bearer auth and capability auth are explicit alternatives, not an accidental anonymous bypass.

### 5. Logging, Errors, And Response Hygiene

- Audit transfer-related logs and errors so they redact:
  - `Authorization` headers.
  - Capability tokens and full URLs containing capability tokens.
  - Raw R2 keys.
  - File bytes and extracted PDF text.
- Error responses should be actionable but not secret-revealing: e.g. “transfer capability expired or invalid”, “upload exceeds maximum size”, “PDF text extraction failed; retry with indexing_mode=skip if you want to store without indexing”.
- Download responses should set safe headers and should not expose internal storage details.

### 6. Tests

- Add Worker/Vitest coverage for capability minting and use:
  - MCP upload-link creation requires an authenticated MCP call and rejects invalid project/document ownership.
  - MCP download-link creation requires document ownership.
  - Returned MCP upload/download instructions do not require or include a bearer token.
  - Capability upload create succeeds with only the capability token and creates the expected D1 document/R2 object.
  - Capability upload update succeeds with only the capability token and honors `write_mode` versioning.
  - Capability download succeeds with only the capability token and returns exact bytes with safe headers.
  - Existing bearer-auth REST upload/download still works for compatibility.
  - Capability reuse fails after a successful transfer.
  - Expired capabilities fail closed.
  - Capability attempts with mismatched operation, method, document id, MIME type, or oversized body fail without mutation.
  - Cross-owner attempts fail even if the attacker knows a document id.
  - Text, opaque binary, and PDF `indexing_mode=auto|skip` paths retain existing chunking/embedding/PDF-extraction behavior.
  - Logs or captured responses used in tests do not contain bearer tokens, raw R2 keys, or document bytes where the system controls output.

## Verification

- `pnpm check`
- `pnpm typecheck`
- `pnpm test`
- `pnpm build` if Worker routes, schema/migrations, or bindings change.

Expected evidence:

- Targeted Worker tests show MCP-minted upload/download URLs work with capability auth and without the user's long-lived bearer token.
- Targeted Worker tests show expired and reused capabilities fail closed.
- Targeted Worker tests show capability-bound operation details cannot be overridden by request headers, query params, or body metadata.
- Targeted Worker tests show existing bearer-auth REST transfer paths remain compatible.
- Document service tests still prove R2 storage, versioning, PDF extraction/indexing, chunk regeneration, Vectorize updates, and exact-byte download behavior.

## Refinement Protocol

- If the existing spec language conflicts with capability-authenticated transfer execution, pause and ask before changing the spec Contract.
- If a persisted capability table is needed, add a Drizzle migration and keep it narrowly scoped to document transfer capabilities; do not generalize into a broad authorization framework in this PBI.
- If Cloudflare Worker/runtime limits make strict streaming size enforcement difficult, implement the safest bounded behavior available and document the exact limit and failure mode in tests.
- If preventing replay requires consume-before-use rather than consume-after-success, preserve single-use safety and make retry semantics explicit in close-out evidence.
- If an implementor is tempted to use raw R2 presigned URLs, stop: this PBI requires transfers through the Worker.

## Close-Out Checklist

- [ ] MCP `create_document_upload_link` mints a short-lived, single-use, owner-scoped capability and returns upload instructions that do not require a bearer token.
- [ ] MCP `create_document_download_link` mints a short-lived, single-use, owner-scoped capability and returns download instructions that do not require a bearer token.
- [ ] Capability records/tokens bind operation, owner, project/document identity, title/filename/MIME metadata, `write_mode`, `indexing_mode`, max size, and expiry as applicable.
- [ ] Capability-authenticated Worker upload/download endpoints enforce bound details and never expose raw R2 URLs.
- [ ] Existing bearer-authenticated REST upload/download paths remain available for web/API compatibility.
- [ ] D1/R2 provenance, document versioning, PDF extraction/indexing, chunk cleanup, and Vectorize semantics are preserved.
- [ ] Expired, reused, cross-owner, mismatched-operation, and oversized transfers fail closed.
- [ ] Logs, MCP responses, and API responses do not expose bearer tokens, raw R2 keys, document bytes, or capability token plaintext beyond the intended one-time transfer instruction.
- [ ] `pnpm check`, `pnpm typecheck`, and `pnpm test` pass.
- [ ] `pnpm build` passes if Worker routes, schema/migrations, or bindings changed.
