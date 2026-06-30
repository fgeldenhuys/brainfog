# PBI-032: Trusted Mode Shared Visibility

## Directive

Add a server-wide configuration flag for trusted mode. When enabled, every owner-scoped memory object is effectively readable by every authenticated user at runtime, while writes/deletes remain owner-only and persisted `shared` flags keep their existing semantics.

## Scope

- Spec: `specs/sharing/spec.md`
- Covers DoD items: runtime extension of shared read visibility for recall, REST list routes, `list_dependencies`, and `list_stale`; preservation of owner-only write/delete enforcement; preservation of persisted `shared` flags and cascade semantics.
- Out of scope:
  - Changing the auth/token model.
  - Adding npm dependencies or Cloudflare bindings.
  - Making connector credentials or other encrypted/plaintext credentials globally visible.
  - Changing persisted `shared` semantics, migrations, cascades, Vectorize metadata, or backfilling `shared = true`.
  - Public signup or anonymous access.
  - Changing spec Contract checkboxes beyond necessary implementation notes/evidence.

## Dependencies

- Existing shared visibility implementation from `specs/sharing/spec.md`.
- Existing owner-scoped service/query helpers for memory reads, dependency reads, and recall.
- No new ADR is required unless implementation discovers a contradiction with `ARCHITECTURE.md` or ADR-011.

## Context

`specs/sharing/spec.md` implements deliberate sharing through persisted per-row `shared` flags: read paths use `owner_id = caller OR shared = true`, while write/delete paths stay strictly owner-owned. This PBI adds an operator-controlled trusted deployment mode that widens read visibility at runtime only.

In trusted mode, an authenticated caller should be able to read other users' owner-scoped memory objects even when those rows have `shared = false`. The database must not be migrated or backfilled to set `shared = true`; explicit sharing remains visible as persisted state and cascades remain unchanged. Disabling trusted mode must restore the normal `owner_id = caller OR shared = true` behavior without data repair.

Search/recall should still prefer the caller's own objects: issue/order owner-scoped search first where practical, merge in other visible rows second, de-duplicate, and keep existing relevance/ranking behavior as much as possible.

## Intent Preservation

- Trusted mode is read-only visibility widening for authenticated users; it must not grant cross-owner writes, deletes, `set_shared`, credential access, token access, or admin-like powers.
- Runtime effective visibility must be computed from configuration and caller identity, not persisted by setting `shared = true`.
- Existing `shared` flags, cascade-on-share behavior, Vectorize `shared` metadata, and `set_shared(..., false)` behavior remain unchanged.
- With trusted mode disabled or unset, all current `specs/sharing/spec.md` behavior remains unchanged.
- `people` remain global as before; connector credentials and secrets remain owner/private regardless of trusted mode.
- All `/mcp`, `/api/v1/*`, and web UI paths must still require authentication.

## Implementation Plan

Likely files in scope:

- `apps/worker/src/env.ts`, `apps/worker/src/config.ts`, or equivalent Worker environment typing/config parsing.
- `apps/worker/wrangler.jsonc` and `.dev.vars.example` if they document non-secret runtime flags.
- `apps/worker/src/memory.ts` and service/query helpers that currently enforce `owner_id = caller OR shared = true`.
- MCP tool handlers and REST routes only where they call read helpers directly instead of shared service helpers.
- Recall/vector search code that currently performs owner-scoped and shared-scoped Vectorize queries.
- Dependency graph read helpers for `list_dependencies` and `list_stale`.
- Tests under `apps/worker/test/`, `apps/worker/src/**/*.test.ts`, or the existing Worker test locations for sharing/memory behavior.

Ordered steps:

1. Add a typed, non-secret server-wide flag such as `BRAINFOG_TRUSTED_MODE` parsed as a boolean. Default must be `false` for missing, empty, or unrecognized values unless the project already has a stricter config parser pattern to follow.
2. Introduce a central helper for effective read visibility, e.g. `canReadOwnerScoped(ctx, row)` / SQL predicate builder / `visibilityMode`, so trusted mode logic is not scattered across routes.
3. Update D1 list/read paths for owner-scoped memory objects to use:
   - normal mode: `owner_id = caller OR shared = true`;
   - trusted mode: authenticated rows of that owner-scoped memory type are visible, with caller-owned rows ordered first where an ordered list route exists.
4. Update recall so trusted mode searches caller-owned objects first/default, then all other visible objects. Avoid relying on Vectorize `shared` metadata as the only widening mechanism in trusted mode, because `shared` remains persisted state and must not be backfilled.
5. Update `list_dependencies` and `list_stale` effective visibility so edges are returned when their visibility would be readable under trusted mode, while edge creation and stale-marking write behavior remain owner/shared-rule constrained unless the existing spec explicitly allows otherwise.
6. Audit write/delete paths (`remember`, task/fact/document/project/time-series mutations, `set_shared`, dependency creation/deletion, credential operations) to verify they still require owner ownership or their existing stricter rule.
7. Add tests proving trusted mode enabled widens reads for private rows across users, trusted mode disabled preserves existing behavior, own rows are preferred in recall/list ordering where applicable, and non-owner writes/deletes remain rejected.
8. Document the flag in the appropriate example/config notes without committing secrets or changing Cloudflare bindings.

Acceptance criteria:

- A single runtime flag enables trusted mode server-wide, defaults off, and requires no migration.
- In trusted mode, authenticated user B can read user A's private owner-scoped projects, tasks, facts, documents/document chunks, thoughts, time-series points, and relevant dependency/stale edges through the same read surfaces covered by `specs/sharing/spec.md`.
- In trusted mode, user B cannot update/delete user A's rows, cannot call `set_shared` on user A's rows, and cannot read user A's credentials/secrets.
- Persisted `shared` values are not changed merely by enabling trusted mode or by trusted-mode reads.
- Recall/search still includes caller-owned objects by default/first and includes other users' visible objects in trusted mode.
- With trusted mode disabled, existing sharing tests and behavior remain unchanged.

## Verification

Run and capture evidence for:

- `pnpm check`
- `pnpm typecheck`
- `pnpm test`

Expected test evidence includes focused coverage for:

- trusted mode off: private cross-owner rows are not visible unless `shared = true`;
- trusted mode on: private cross-owner owner-scoped memory rows are visible to authenticated users;
- trusted mode on: persisted `shared` flags remain unchanged after reads;
- trusted mode on: non-owner write/delete/`set_shared` attempts still fail;
- trusted mode on: recall returns caller-owned matches before other users' visible matches where scores/order are otherwise comparable;
- trusted mode on: connector credentials or credential-status endpoints do not become globally readable.

## Refinement Protocol

If implementation reveals a conflict between trusted-mode visibility and `specs/sharing/spec.md`, `ARCHITECTURE.md`, or an accepted ADR, pause and ask for an architecture decision before changing persisted sharing semantics. If a read path cannot preserve caller-owned-first ordering mechanically without degrading relevance, document the trade-off in the implementation notes and keep owner-scoped querying first where possible.

## Completion Evidence

Implemented on 2026-06-30.

PBI-032 intended changes:

- Added typed `BRAINFOG_TRUSTED_MODE` runtime flag in `apps/worker/src/env.ts`; accepted true values are `true`, `1`, and `yes`, and unset/empty/unrecognized values remain off.
- Documented the non-secret flag in `apps/worker/.dev.vars.example` without adding a Cloudflare binding, dependency, migration, or secret.
- Updated `apps/worker/src/memory.ts` read visibility paths so trusted mode widens effective read access for owner-scoped memory objects, document chunks through parent documents, recall D1 resolution/fallback, `entityExists(..., "dependency")`, `list_dependencies`, and `list_stale` project filtering.
- Updated recall Vectorize querying so the first query remains caller-owner scoped and the trusted-mode widening query filters by kind/project without relying on persisted `shared: true` metadata.
- Kept write/reference semantics owner/shared-rule constrained: `set_shared`, updates/deletes, `createDependency`, stale marking scope, and `project_id` write validation remain based on owner or persisted `shared = true` only.
- Updated `apps/worker/src/ingestion.ts` to keep connector `project_id` assignment on the existing owner/shared validation path.
- Added tests in `apps/worker/test/memory.test.ts` for trusted-mode on/off visibility, persisted `shared` staying false after reads, non-owner write/`set_shared` rejection, private `project_id` write-reference rejection, recall owner-first/all-visible vector querying, and trusted-mode dependency/stale edge read visibility without broadening dependency writes.
- Updated `apps/worker/test/ingestion-credentials.test.ts` so cross-user credential save/read/delete attempts still return `404` while trusted mode is enabled.

Preflight notes:

- `git status --short --branch` showed unrelated pre-existing PBI-031/capability document-transfer changes in the worktree, including `apps/worker/src/index.ts`, `apps/worker/src/mcp/index.ts`, `apps/worker/src/pages.ts`, `packages/db/src/schema.ts`, `packages/db/migrations/*`, `tasks/PBI-031-capability-authenticated-document-transfers.md`, and `apps/worker/src/routes/document-transfer.ts`. These were not reverted or closed as part of PBI-032.
- No `specs/sharing/spec.md` Contract checkbox was changed.

Verification commands run:

- `pnpm --filter @brainfog/worker test -- test/memory.test.ts test/ingestion-credentials.test.ts` passed; Vitest ran the worker suite and reported 12 files / 331 tests passing.
- `pnpm check && pnpm typecheck && pnpm test` passed after implementation fixes; final run reported Biome clean, TypeScript clean, and Vitest 12 files / 331 tests passing.

Observed non-blocking test warnings:

- Existing Cloudflare local binding warnings for AI/Vectorize.
- Existing OAuth CIMD compatibility warning.
- Existing PDF/canvas fallback warnings in PDF tests.
- Existing Vitest close-timeout notice after tests had already completed successfully.

Brainfog invariant coverage:

- Auth model unchanged; no `/mcp` or `/api/v1/*` auth bypass added.
- D1 remains canonical; trusted mode computes effective read visibility at runtime and does not backfill D1 or Vectorize metadata.
- Vectorize remains derived/rebuildable; trusted recall changes only query filters and D1 resolution.
- Provenance/write paths unchanged for memory writes.
- No committed secrets; `BRAINFOG_TRUSTED_MODE` is documented as non-secret config.
- Credentials remain owner-only even in trusted mode.

## Ship-PBI Log

- Iteration 1: `planned-implementor` added the trusted-mode flag and read-path changes. Direct deterministic gate initially passed, but focused review found missing PBI-specific tests. Added tests and reran the gate.
- Critic pass 1: Found blocking issues where trusted mode changed write/reference/staleness semantics: private cross-owner dependency creation, private global stale propagation, and private cross-owner `project_id` references on writes.
- Iteration 2: Restored write/reference/stale mutation behavior to existing owner/shared rules, added regression tests for those constraints, and kept trusted mode scoped to effective read visibility.
- Critic pass 2: No blocking PBI-032 issues found. Verified `pnpm check && pnpm typecheck && pnpm test` passed with 331 tests.
