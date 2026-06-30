# PBI-030: PDF Text Extraction and Indexing

## Directive

Add server-side PDF support so text-extractable PDFs are extracted, chunked, embedded, and recallable. If a PDF cannot be text-extracted on initial upload, fail the upload with a clear warning that the PDF is not being indexed unless the caller explicitly opts out of indexing. Also support a companion manual text path so an agent can OCR an image PDF locally and supply the extracted text for indexing while keeping the PDF bytes intact.

## Scope

- Spec: `specs/memory-model/spec.md`
- Covers DoD items: document upload/update behavior, `document_chunks` generation, Vectorize upserts for document text, and recall visibility for indexed documents.
- Out of scope:
  - OCR or scanned/image-only PDF support.
  - Generic rich-media extraction beyond PDFs.
  - UI polish or PDF preview rendering.
  - Changing auth, sharing, provenance, or storage primitives.
- Indexing other binary document types by default.
  - Automatic OCR.

## Dependencies

- ADR-008: R2 remains canonical for full document bytes.
- ADR-013: opaque document bytes may be stored without semantic chunks or embeddings.
- PBI-022: direct document file transfer.
- PBI-027: binary upload versioning.
- A browser-compatible PDF parser/extractor is likely needed; treat any new top-level dependency as subject to approval per `AGENTS.md`.
- A small wording update to `specs/memory-model/spec.md` may be needed before implementation so PDF extractability and the explicit no-index override are contractually clear.

## Context

Current document ingestion only indexes MIME types considered text-like. PDFs currently follow the opaque/binary path, so they store and download correctly but produce no semantic chunks or vectors.

The existing write path already has the right interception points:

- `createDocumentFromBytes()` / `updateDocumentFromBytes()` for direct byte uploads.
- `updateDocument()` for string-based updates.
- `chunksFor()` for document chunking.
- A companion document-text indexing path for manually supplied OCR/extracted text on existing PDFs.

For this PBI, PDF handling should be fail-closed by default: if a PDF cannot be text-extracted, the initial upload must not silently store an unindexed document. The caller must make that decision explicitly via an override flag.

Chunking should become structure-aware. Prefer paragraph boundaries, then sentence boundaries, and only fall back to hard length splits when a single segment is too large.

## Intent Preservation

1. No OCR in this PBI.
2. Extractable PDFs are indexed by default.
3. Non-extractable PDFs must fail initial upload unless an explicit no-index override is supplied.
4. The override must be explicit in the API/tool contract, not inferred.
5. Indexed PDFs must use the same D1 -> Workers AI -> Vectorize pipeline as existing text documents.
6. Chunking must preserve structure when possible; avoid blind byte/character slicing as the primary strategy.
7. Stale chunks and vectors must be removed when a document changes indexing mode.
8. No raw file bytes, extracted text dumps, or secrets should leak through MCP responses or logs.

## Implementation Plan

### 1. Add PDF extraction and detection helpers

- Add a small PDF detection helper, e.g. `isPdfMimeType()`.
- Add a server-side PDF text extraction helper for Worker runtime use.
- Extract text before any D1/R2 mutation when indexing is enabled.
- If extraction fails or yields no usable text, throw a `400` with a message that the PDF is not being indexed and must be re-uploaded with the explicit no-index override.

### 2. Add an explicit indexing override

- Extend the byte-upload surfaces with an explicit PDF indexing flag, e.g. `indexing_mode: "auto" | "skip"`.
- Add a companion text-indexing route/tool for existing PDFs, e.g. `index_document_text`, that accepts the OCR/extracted text separately from the PDF bytes.
- Wire the flag through:
  - REST direct-upload create/update routes.
  - MCP upload-link generation.
  - Any service-layer byte-upload helpers.
- Default to `auto`.
- When `skip` is selected, store the PDF bytes but do not attempt extraction, chunking, or embedding.
- When manual text is supplied for a PDF through the companion path, index that text instead of attempting extraction and keep the PDF bytes as the stored document content.

### 3. Replace blind chunk slicing with structure-aware chunking

- Replace `chunksFor()` with a helper that prefers:
  - paragraph breaks,
  - sentence boundaries,
  - then hard splits only for oversized segments.
- Use the same chunker for extracted PDF text and existing text-like document content.
- Keep chunk sizes bounded and deterministic so Vectorize behavior remains stable.

### 4. Integrate PDF handling into document writes

- For PDF uploads with `indexing_mode=auto`:
  - extract text,
  - chunk it structurally,
  - store the PDF bytes in R2,
  - create `document_chunks`, and
  - embed/upsert the chunks into Vectorize.
- For PDF uploads with `indexing_mode=skip`:
  - store the PDF bytes in R2,
  - create the document row,
  - skip chunk creation and embeddings.
- Ensure update/version flows clean up stale chunks/vectors when switching between indexed and unindexed content.

### 5. Add tests

- Test that a text-extractable PDF upload is indexed and recallable.
- Test that a non-extractable PDF upload fails with the expected warning and leaves no stored state.
- Test that the explicit `indexing_mode=skip` override stores the PDF without indexing.
- Test that a supplied manual OCR text payload indexes an image PDF without requiring server-side extraction.
- Test that structure-aware chunking prefers paragraph/sentence boundaries over blind slicing.
- Test update/version behavior when a document changes indexing mode.

## Verification

- `pnpm check`
- `pnpm typecheck`
- `pnpm test`
- `pnpm build` if Worker routes, bindings, or dependencies change

Expected evidence:

- Indexed PDFs show up in recall results.
- Failed non-extractable PDF uploads do not mutate D1/R2.
- Explicit no-index PDF uploads succeed and create no chunks/vectors.
- Chunking tests show structure-aware splits.

## Refinement Protocol

If the chosen PDF parser is not Worker-compatible, or if the implementation requires a new Cloudflare product/binding, stop and ask before widening the runtime surface. If the `specs/memory-model/spec.md` wording needs to name the override flag or PDF failure behavior precisely, update the spec first and then implement.

## Ship-PBI Log

- Iteration 1: Implemented PDF extraction/indexing, manual OCR-text indexing, structure-aware chunking, and upload/link surface updates. `pnpm check` and `pnpm test` exposed a PDF fixture/xref bug in `apps/worker/test/memory.test.ts` and a TypeScript issue around DOM geometry shims.
- Iteration 2: Fixed the PDF fixture offsets, switched the pdfjs import to the legacy build, added Worker-safe geometry shims for pdfjs, and cleaned up formatting/type errors. Verified with `pnpm check`, `pnpm typecheck`, and `pnpm test`.
- Iteration 3: Closed the inline-text PDF bypass by rejecting `application/pdf` on `add_document` and `update_document`, updated the spec wording, and re-ran `pnpm check`, `pnpm typecheck`, and `pnpm test` successfully.
