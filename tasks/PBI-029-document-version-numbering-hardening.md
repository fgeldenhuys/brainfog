# PBI-029: Document Version Numbering Hardening

## Directive

Harden document version creation so brainfog, not the caller, always assigns the next historical version number without duplicate-number races, and make the overwrite-vs-new-version choice explicit across MCP and browser UI surfaces.

## Scope

- Spec: `specs/memory-model/spec.md`
- Covers DoD items: follow-up hardening for the existing document update/versioning work from PBI-023 and PBI-027 so caller-selected `write_mode` remains explicit, historical version numbers stay monotonic per document, and text/binary update paths share the same service-layer invariants.
- Out of scope:
  - Changing document-version read routes or historical-download semantics.
  - Adding collaborative editing, locking, or branching semantics.
  - Making historical versions independently recallable.
  - Changing auth, sharing, or token behavior.

## Dependencies

- ADR-008: R2 remains canonical for full document bytes.
- ADR-013: binary/opaque document bytes remain valid current or historical document content.
- PBI-023: versioned documents.
- PBI-027: binary upload versioning.

## Context

Brainfog already exposes explicit document write modes (`overwrite_current` and `create_version`) through text updates, binary direct-upload updates, MCP, and the browser UI. The current service implementation reads `documents.current_version_number`, writes the historical R2 copy, inserts a `document_versions` row using that number, and only then advances the document's current-version counter.

That sequence allows concurrent updates to race on the same historical version number. In practice the unique `(document_id, version_number)` constraint rejects one of the writes, but the failure leaks as a low-level database error instead of an explicit stale-version conflict. The binary update path (`updateDocumentFromBytes`) repeats the same pattern.

## Intent Preservation

1. Brainfog assigns version numbers; callers only choose `write_mode`.
2. Text and binary update paths must share the same version-number reservation behavior.
3. `overwrite_current` still creates no historical row.
4. `create_version` preserves the outgoing current content as historical content before replacing the current content.
5. On concurrent stale writes, return an explicit application-level conflict instead of leaking a raw uniqueness failure.
6. Interface wording must clearly distinguish overwriting the current version from creating a new version, and must state that the new version number is assigned automatically.

## Implementation Plan

1. Add a narrow helper in `apps/worker/src/memory.ts` that reserves the next version number using the document's current version state, and throws a `MemoryError(409, ...)` when another update has already advanced the document.
2. Update both `updateDocument` and `updateDocumentFromBytes` to use that helper when `write_mode === "create_version"`, preserving the existing R2 historical-copy behavior while avoiding duplicate-number inserts.
3. Keep the final document metadata update separate from version-number reservation; do not reintroduce caller-controlled numbering anywhere.
4. Update MCP descriptions and binary upload-link notes in `apps/worker/src/mcp/index.ts` and `apps/worker/src/memory.ts` to say callers choose between overwriting the current version and creating a new version, and that brainfog assigns the next version number automatically.
5. Update the browser edit form wording in `apps/worker/src/ui/browser.tsx` to match the same language.
6. Add Worker tests in `apps/worker/test/memory.test.ts` covering parallel text and binary `create_version` attempts so the system either serializes cleanly or returns a friendly 409 conflict, but never leaks duplicate-number/unique-constraint failures.
7. Update the UI page test in `apps/worker/test/ui-pages.test.ts` to assert the clearer wording is rendered.

## Verification

- `pnpm check`
- `pnpm typecheck`
- `pnpm test`
- Evidence:
  - memory tests show concurrent text and binary version writes do not leak raw unique-constraint failures.
  - UI tests show the browser edit form clearly distinguishes overwrite vs create-new-version behavior.

## Refinement Protocol

If implementing the race fix exposes a deeper need for true per-document locking or schema changes beyond the existing `documents.current_version_number` model, stop and ask before expanding the scope. If the existing spec/ADR language conflicts with the safer conflict-on-stale-write behavior, treat the spec/ADR as authority and pause before changing the contract.
