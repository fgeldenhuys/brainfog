# PBI-024: Document Versions UI

## Directive

Expose caller-controlled document versioning in the default browser UI so humans can choose whether a document edit overwrites the current content or preserves the outgoing current content as a historical version, and can inspect/download document version history.

## Scope

- Spec: `specs/frontend/spec.md`
- Covers DoD items: Extends the existing checked default-UI document browser/reader work so `/app/browser/documents`, document detail pages, and document edit flows use the document version service capabilities added by PBI-023 while preserving the frontend spec's auth, owner-scoping, service-layer, no-JavaScript, and safe-rendering requirements.
- Out of scope:
  - Schema or migration changes.
  - New MCP tools or REST API routes.
  - Changing document version semantics from PBI-023.
  - Historical version recall/indexing, historical chunks, diffs, patching, branching, merge/conflict UI, or collaborative editing.
  - A direct-upload update workflow.
  - New frontend dependencies, a SPA, or a client-side build step.
  - Changing bearer-token auth, token issuance, sharing rules, or owner-scoped mutation rules.

## Dependencies

- PBI-023: Versioned Documents, which added `write_mode`, `listDocumentVersions`, historical content/download helpers, and REST/MCP version read surfaces.
- `specs/memory-model/spec.md` document service invariants: R2 is canonical for document bytes, D1 is canonical for metadata, and `document_chunks`/Vectorize represent current content only.
- ADR-007/frontend default UI approach and `specs/frontend/spec.md`: server-rendered Hono JSX, authenticated UI, service-layer access, no JavaScript requirement.
- ADR-008: R2 stores full document content.
- `specs/sharing/spec.md` and ADR-011 for read widening: shared reads may allow seeing another user's document/version metadata/content, but writes remain owner-only.

## Context

PBI-023 intentionally left browser UI browsing for document versions out of scope. The service and API layers now support explicit write modes:

- `overwrite_current`: replace current content, refresh current chunks/vectors, and create no historical version row.
- `create_version`: preserve the outgoing current content in R2/D1 history before replacing current content and refreshing current chunks/vectors.

The current browser edit form at `/app/browser/documents/:id/edit` calls `updateDocument(ctx, id, content)` without a write mode, so browser edits default to overwrite behavior and give the user no visible choice. Document detail pages also do not show `current_version_number` or version history, and the document reader has no version-history links.

This PBI should keep the UI small and boring: normal HTML form controls and links, rendered server-side, backed by the existing memory service. It should not duplicate authorization logic or expose raw R2 keys.

## Intent Preservation

1. **Caller choice must be explicit in the edit UI.** Document edits from the browser must submit a write mode of either `overwrite_current` or `create_version`; do not silently auto-version all edits.
2. **Default behavior remains non-surprising.** The default selected browser edit mode should preserve existing behavior (`overwrite_current`) unless the user explicitly chooses to preserve a version.
3. **No raw storage authority leaks.** Version history pages, detail pages, and links must not expose raw R2 keys, bearer tokens, transfer secrets, or inline binary/base64 bytes.
4. **Historical reads do not mutate current state.** Viewing or downloading a historical version must not update `documents.updated_at`, current chunks, Vectorize, or current content.
5. **Service layer only.** UI routes must call existing memory service helpers; do not query D1/R2 directly from UI code to bypass owner/shared-read checks.
6. **Write scoping is owner-only.** The UI must not allow cross-owner version creation/overwrite. If a shared readable document appears in UI routes, read-only history links may work according to service checks, but edit links must still fail through service authorization.
7. **Current-only recall stays intact.** UI copy should not imply historical versions are recallable unless a later PBI implements historical indexing.
8. **HTML without JavaScript.** Version choice, version listing, historical content view, and downloads must work as ordinary forms/links.

## Implementation Plan

### 1. Confirm Current UI And Service Surface

- Read `AGENTS.md`, `ARCHITECTURE.md`, `specs/frontend/spec.md`, this PBI, and the relevant PBI-023 service functions in `apps/worker/src/memory.ts` before editing.
- Inspect `apps/worker/src/ui/browser.tsx` and `apps/worker/src/ui/index.tsx` for document edit/detail/reader routes.
- Confirm the exact exported helpers and return shapes for `listDocumentVersions`, `getDocumentVersionContent`, and `getDocumentVersionBytes`.
- Stop and ask before changing `specs/frontend/spec.md` Contract, adding dependencies, or changing REST/MCP behavior.

### 2. Add Write Mode To Browser Document Edit

- File scope: `apps/worker/src/ui/browser.tsx`.
- Update the document edit form to include a clearly labelled write-mode control, preferably radio buttons:
  - `overwrite_current`: replace current content without preserving history.
  - `create_version`: preserve the current content as a historical version before saving.
- Default the selected value to `overwrite_current`.
- Update the POST edit handler for `documents` to pass the submitted write mode into `updateDocument`.
- Validate defensively at the UI handler boundary by only passing `overwrite_current` or `create_version`; invalid/missing values should fall back to `overwrite_current` or raise a `MemoryError(400)` consistently with existing form validation. Prefer raising for invalid explicit values if simple.
- Acceptance criteria:
  - Browser document edits can create a historical version when the form chooses `create_version`.
  - Browser document edits can still overwrite without creating history when the form chooses or defaults to `overwrite_current`.

### 3. Render Version History On Document Detail Pages

- File scope: `apps/worker/src/ui/browser.tsx`.
- Import and call `listDocumentVersions` only for `kind === "documents"` detail pages.
- Render a compact "Versions" section on `/app/browser/documents/:id` showing current version metadata and historical rows in stable order.
- Include at least version number, current/historical status, MIME type, size when available, created date for historical versions/current metadata date where available, and links to view/download each version where appropriate.
- Use existing `fmtDate` and safe render helpers; do not show `r2_key`.
- Keep the existing `Open Reader` and `Raw` actions.
- Acceptance criteria:
  - Detail pages show current version number and historical version rows after a versioned edit.
  - No raw R2 keys or secret material appears in rendered output.

### 4. Add Historical Version View/Download UI Routes

- File scope: `apps/worker/src/ui/index.tsx` and, only if cleaner, `apps/worker/src/ui/browser.tsx` for link generation.
- Add authenticated UI routes under `/app/documents/:id/versions/:version/content` and `/app/documents/:id/versions/:version/download`, or equivalent paths that do not conflict with existing `/app/documents/:id` and `/app/documents/:id/raw`.
- For text-like historical content, render a simple authenticated page with document/version metadata and escaped/Markdown-rendered content following the same safety rules as the current document reader.
- For opaque/binary historical content, the content view may show metadata and a download link rather than trying to render bytes.
- The download route should return exact bytes via `getDocumentVersionBytes` with conservative `Content-Disposition`, `Content-Type`, and `Cache-Control: no-store` headers, matching the existing raw/download safety style.
- Acceptance criteria:
  - A user can click from document detail to view a text historical version.
  - A user can download a historical version without inline base64/binary rendering.
  - Historical reads are authenticated and go through service helpers.

### 5. Tests

- File scope: likely `apps/worker/test/ui.test.ts` or the existing Worker-runtime UI test file for default UI behavior; keep test additions minimal and aligned with existing patterns.
- Add or update tests covering:
  - The document edit form includes write-mode choices.
  - Posting a document edit with `write_mode=create_version` creates visible version history and current content changes.
  - Posting a document edit with `write_mode=overwrite_current` does not create a historical version row.
  - Historical version content/download routes require authentication and return historical content/bytes without changing current content.
  - The rendered version history does not include raw R2 keys.
- If Playwright coverage is already simple to extend, add an e2e smoke only if low-cost; otherwise Worker-runtime UI tests are sufficient for this PBI.

### 6. Close-Out Updates

- Append completion evidence and Ship-PBI iteration notes to this PBI.
- Do not edit `specs/frontend/spec.md` checkboxes unless the implementation materially changes the spec completion evidence and the change is clearly appropriate. If uncertain, leave the spec unchanged and record evidence here.

## Verification

- `pnpm check && pnpm typecheck && pnpm test` pass.
- `pnpm build` passes if UI route handling changed enough to warrant bundle validation.
- Targeted Worker/UI tests demonstrate:
  - Browser document edit exposes explicit overwrite/create-version choice.
  - `create_version` from the browser preserves the outgoing current content and makes the new content current.
  - `overwrite_current` from the browser does not create a historical version.
  - Document detail pages list current/historical version metadata without exposing raw R2 keys.
  - Historical content/download UI routes are authenticated and return the selected historical version without mutating current content.

## Close-Out Checklist

- [x] Browser document edit form exposes explicit `overwrite_current` and `create_version` choices.
- [x] Browser document edit POST validates and passes `write_mode` to `updateDocument`.
- [x] Document detail pages list current/historical version metadata without raw R2 keys.
- [x] Historical version content/download UI routes are authenticated and call service helpers.
- [x] Text/Markdown historical content follows existing reader escaping/rendering behavior.
- [x] Binary/opaque historical content is not inlined as base64; UI points to download.
- [x] Worker-runtime UI tests cover create-version, overwrite, R2 key non-leakage, auth, and current-content preservation.

Close-out evidence (2026-06-23): implemented version write-mode controls in the browser document edit form, version metadata rendering on document detail pages, and authenticated historical version content/download UI routes backed by `listDocumentVersions`, `getDocumentVersionContent`, and `getDocumentVersionBytes`. Tests were added to `apps/worker/test/ui-pages.test.ts` for explicit write-mode controls, browser `create_version`, browser `overwrite_current`, version metadata non-leakage, unauthenticated route rejection, historical content/download, and current content remaining current after historical reads. Verification passed with `pnpm check`, `pnpm typecheck`, and `pnpm test` (246/246 tests passed; existing Vitest close-timeout warning after success). `pnpm build` passed.

## Ship-PBI Log

- Iteration 1: implemented the scoped UI and Worker-runtime test changes in `apps/worker/src/ui/browser.tsx`, `apps/worker/src/ui/index.tsx`, and `apps/worker/test/ui-pages.test.ts`; fixed Biome/typecheck findings; deterministic gates passed (`pnpm check`, `pnpm typecheck`, `pnpm test`, and `pnpm build`).

## Refinement Protocol

- If the required UI behavior conflicts with PBI-023 semantics, `specs/frontend/spec.md`, `ARCHITECTURE.md`, or ADR-008, pause and ask before changing the contract.
- If implementing useful version history requires a REST/MCP/schema change, stop and split that into a separate PBI; this PBI should consume existing service helpers.
- If historical versions should become recallable/searchable from the UI, split that into a future spec/PBI; do not index historical versions here.
- If tests reveal shared-read behavior is inconsistent with the service layer, preserve service-layer behavior and record the gap rather than bypassing authorization in the UI.
