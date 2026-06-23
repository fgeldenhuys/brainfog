# ADR-013: Opaque Document File Transfers

## Status

Accepted - 2026-06-23

## Context

ADR-008 introduced R2-backed documents so brainfog could store full Markdown document content while keeping D1 canonical for structured metadata and Vectorize rebuildable from derived `document_chunks`. That decision covered text documents intended for semantic recall.

PBI-022 adds a related but different need: agents should be able to back up and restore generated files such as `.opencode` configuration archives without passing the file bytes through MCP tool arguments or model context. Those archives may be binary, compressed, or otherwise opaque. Treating them as text would waste tokens, risk truncation, and create meaningless chunks or embeddings. Storing them outside brainfog would weaken the product goal of durable cross-session context and backup material owned by the authenticated user.

`ARCHITECTURE.md` invariant 10 previously said v1 memory content was text/structured JSON plus R2-stored Markdown documents, and that arbitrary binary attachments were out of scope without a new ADR. This ADR is that explicit expansion, bounded to document backup/restore objects stored in the existing R2 document bucket.

## Decision

We will allow brainfog `documents` to store opaque file content in R2 for direct backup and restore, using the existing `documents.r2_key` metadata model. D1 remains canonical for document metadata (`owner_id`, `project_id`, `source`, `title`, `r2_key`, `mime_type`, `size_bytes`, timestamps, and sharing state), while R2 remains canonical for the full object bytes.

Text-like documents may continue to be decoded, chunked into `document_chunks`, embedded with Workers AI, and indexed in Vectorize. Opaque or binary documents, including zip archives and `application/octet-stream`, are stored and retrievable as exact bytes but are not semantically chunked or embedded unless a later ADR introduces safe content extraction for that file type.

Direct transfer flows may use MCP tools to create short-lived, owner-scoped upload/download capabilities, with the actual bytes transferred over authenticated or capability-authenticated HTTP endpoints. The MCP tool arguments and responses must not carry the file bytes inline.

This decision does not introduce a new storage product or deployment surface: Cloudflare Workers, D1, R2, Workers AI, and Vectorize remain the only primitives involved.

## Consequences

**Positive**
- Agents can back up and restore configuration archives and other generated files without base64 inflation or model-token consumption.
- R2 remains the right storage primitive for larger byte objects, preserving the Cloudflare-only architecture.
- Semantic recall remains high-signal because opaque binary objects do not create meaningless `document_chunks` or Vectorize entries.
- Existing document ownership, provenance, sharing, and deletion semantics can be reused.

**Negative**
- `documents` now includes both semantically indexed text documents and opaque backup/restore objects, so callers must not assume every document has chunks.
- Exact-byte download increases the importance of safe `content-type`, `content-disposition`, size limits, and owner-scoped transfer authorization.
- Backup archives may contain secrets, so transfer URLs, logs, and UI surfaces must avoid exposing bytes or long-lived credentials.

**Neutral**
- Opaque documents are still memory records, but they are recallable by metadata rather than semantic chunk content.
- File-type detection is an implementation detail; MIME type and/or explicit indexing mode may be used as long as binary objects are not embedded accidentally.
- Future archive inspection, text extraction, or rich-media indexing requires a separate ADR or spec extension.

## Alternatives Considered

- **Keep binary backups outside brainfog:** rejected because the user's immediate backup/restore workflow would remain dependent on ad hoc local files or another storage system, weakening brainfog's role as durable agent memory.
- **Base64-encode opaque files into `add_document(content)`:** rejected because it consumes model/tool-call tokens, inflates payload size, risks truncation, and creates unusable semantic chunks.
- **Use a separate R2 bucket or external object store for backups:** rejected because the existing R2 document bucket and `documents` metadata model already provide ownership and provenance, while external storage would violate the Cloudflare-only deployment constraint.
- **Embed binary files by default after upload:** rejected because compressed or arbitrary binary content has no useful semantic embedding as raw bytes and would pollute recall results.
