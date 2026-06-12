# ADR-008: R2 For Document Storage

## Status

Accepted — 2026-06-12

## Context

`specs/memory-model/spec.md` introduces a `documents` entity for storing Markdown content as a first-class memory type, plus `document_chunks` for chunk-level semantic recall (`ARCHITECTURE.md` invariant 4, ADR-005). `ARCHITECTURE.md` invariant 10 states that memory content is text/structured JSON only in v1, and that storing larger content "requires an ADR (likely introducing R2)". Document content is exactly that case: full Markdown documents are larger and more variable in size than the short, structured rows the rest of the memory model holds, and storing the full text directly as a D1 column would duplicate it against the chunk text already needed in `document_chunks` for recall.

## Decision

We will use Cloudflare R2 to store the full content of each document, one object per document, referenced by `documents.r2_key`. R2 is the canonical store for full document content. D1's `documents` table holds metadata only (title, `r2_key`, `mime_type`, owner, project, timestamps); D1's `document_chunks` table holds per-chunk text derived from that content, which is what gets embedded and upserted into Vectorize (`document_chunk:<id>`, per ADR-005's indexing scheme as extended in `specs/memory-model/spec.md`). Updating a document rewrites its R2 object and re-chunks/re-embeds `document_chunks`.

R2 is declared as a binding on the Worker, extending the platform baseline (ADR-001, PBI-001) alongside the existing D1, Vectorize, and Workers AI bindings.

## Consequences

**Positive**
- R2 has no egress fees and binds directly to Workers, keeping the deployment surface Cloudflare-only (ADR-001).
- R2 comfortably handles document sizes that would be awkward or wasteful as D1 `TEXT` columns, without introducing a separate object-storage vendor.
- R2's S3-compatible API remains available if external tooling ever needs direct access to document content.

**Negative**
- Adds another Cloudflare binding/product to configure, emulate locally (Miniflare supports R2), and operate.
- Document content now exists in two derived forms — the full object in R2 and the chunked text in `document_chunks` — that must be kept in sync; updating a document means rewriting the R2 object and re-chunking/re-embedding, not just updating one row.

**Neutral**
- Chunk size/overlap strategy is an implementation detail, tunable without a new ADR.
- The R2 bucket is declared once in the Worker's Wrangler config; no per-document bucket or prefix conventions are fixed by this ADR beyond `documents.r2_key` being the lookup key.

## Alternatives Considered

- **Store full document content as a `TEXT` column in D1's `documents` table:** rejected — duplicates content between `documents.content` and `document_chunks.content`, and works against D1/SQLite's strengths as a relational store for structured rows rather than large text blobs.
- **External object storage (S3, GCS, etc.):** rejected — contradicts ADR-001's Cloudflare-only deployment surface and would require managing separate credentials/vendor.
- **Defer documents to a later spec:** rejected — documents, including chunked embeddings, are part of the memory model requested for this spec.
