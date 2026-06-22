# PBI-016: Automated Ingestion Framework

## Directive

Implement the generic automated ingestion framework that lets brainfog define connector tasks, record ingestion run history, normalize connector output into existing time-series records, and prevent duplicate writes.

## Scope

- **Spec:** `specs/ingestion/spec.md`
- **Covers DoD items:** The generic connector framework portions of the spec: connector definitions, run history, execution lifecycle, idempotency, authenticated REST/service APIs, and normalized writes into `time_series_points`.
- **Out of scope:**
  - Garmin-specific payload shapes, `python-garminconnect`, or Garmin bridge tooling. Those belong to PBI-017.
  - Native OAuth flows for third-party services.
  - A rich web UI for managing connectors.
  - Raw export storage in R2.
  - New non-Cloudflare hosted runtime or scheduler.

## Dependencies

- Existing memory model and time-series bulk insert behavior from `specs/memory-model/spec.md` must remain intact.
- PBI-012 time-series bulk insert and prefix query are complete and should be reused.
- No new top-level dependency or Cloudflare product should be added without asking. If Workflows are used, reuse the existing project pattern from PBI-015.

## Context

### Why This Work

brainfog can already store generic time-series observations, but every point is currently inserted manually or by a direct API client. Automated ingestion needs durable task metadata: what connector exists, when it ran, what window/cursor it processed, how many points were inserted or skipped, and whether the run failed.

This PBI creates that reusable foundation before implementing Garmin. Keeping the framework separate avoids baking Garmin's unofficial auth and endpoint risks into the generic design.

### Target Framework

Add D1-backed connector state and run history, probably:

- `ingestion_connectors`: `id`, `owner_id`, `project_id`, `source`, `type`, `name`, `status`, `config`, `schedule`, `cursor`, `last_run_at`, `last_success_at`, `last_error`, `created_at`, `updated_at`.
- `ingestion_runs`: `id`, `owner_id`, `connector_id`, `source`, `trigger`, `status`, `started_at`, `finished_at`, `cursor_before`, `cursor_after`, `inserted_count`, `skipped_count`, `failed_count`, `error`, `metadata`, `created_at`, `updated_at`.

Exact column names can be refined during implementation, but the model must support owner scoping, run lifecycle, cursor/checkpoint state, sanitized errors, and enough auditability to explain how a time-series point was created.

### API Shape

Recommended REST routes under `/api/v1/ingestion`:

- `GET /connectors` lists authenticated user's connectors.
- `POST /connectors` creates a connector definition.
- `PATCH /connectors/:id` updates status/config/schedule/cursor fields.
- `GET /connectors/:id/runs` lists run history.
- `POST /connectors/:id/runs` triggers a manual run for connector types that can execute inside the Worker, or records a bridge-submitted run for connector types that cannot.

MCP tools are optional for this PBI. If added, they should be thin wrappers over the same service functions.

### Write Path

The framework must normalize connector output to the existing `recordTimeSeriesPoints` service path or a shared internal equivalent. It must not insert time-series rows directly in a way that bypasses:

- authenticated owner scoping,
- `project_id` validation,
- `source` provenance,
- timestamp validation,
- atomic batch behavior.

Use a connector-specific source label such as `connector:<type>` or `ingestion:<type>` and include connector/run identifiers in metadata.

### Idempotency

Repeated runs over overlapping windows are expected. The framework must prevent duplicate time-series rows for the same source metric.

Acceptable approaches:

- A dedicated idempotency table keyed by owner, connector, source item id, metric key, and observed timestamp.
- A deterministic lookup in existing time-series metadata before insert.
- A cursor/window strategy plus duplicate checking for bridge replay.

The implementation should choose the smallest reliable approach and document it in the close-out.

## Intent Preservation

1. **D1 remains canonical.** Connector definitions, run history, and time-series points live in D1.
2. **No parallel metric store.** Ingested metrics are normal `time_series_points`.
3. **Provenance is mandatory.** Every point records connector/run provenance and authenticated owner context.
4. **Framework before connectors.** Do not add Garmin-specific assumptions to generic connector tables beyond a flexible `type` field and JSON config/metadata.
5. **Cloudflare-only runtime.** The generic framework must run in the existing Worker/D1 environment. External bridge scripts are connector-specific operational tools, not part of this PBI.
6. **Fail closed.** Invalid connector configs, unauthorized connector IDs, invalid project IDs, and invalid normalized points reject the run or payload without partial hidden writes.

## Verification

### Build and Type Checks

- `pnpm check && pnpm typecheck && pnpm test` pass.
- `pnpm build` passes if bindings or Worker exports change.

### Unit / Worker Tests

- Creating a connector stores it with authenticated `owner_id`, `source`, timestamps, and default status.
- Listing connectors returns only the caller's connectors.
- Updating a connector rejects another user's connector.
- Starting/recording a run creates run history with status and trigger metadata.
- A successful run records inserted/skipped/failed counts and updates connector cursor/last success fields.
- A failed run records sanitized error metadata without writing partial time-series points.
- Duplicate source metrics do not create duplicate time-series points.
- Ingestion writes call the same validation behavior as time-series bulk insert, including `project_id` validation and all-or-nothing failure.
- Existing memory/time-series tests continue to pass.

## Refinement Protocol

- If the idempotency design requires a dedicated table, add it in this PBI and keep it generic.
- If Cloudflare Workflows are needed for scheduling, mirror the PBI-015 pattern and keep local tests mocked/pure where necessary.
- If connector config validation becomes broad, implement only the minimal generic validation needed here and leave connector-specific schemas to connector PBIs.
- If a change would weaken `/api/v1/*` auth or memory write provenance, stop and ask.

## Close-Out Checklist

- [x] Connector and run-history migrations are added.
- [x] REST/service APIs exist and are authenticated/owner-scoped.
- [x] Idempotency behavior is implemented and tested.
- [x] Normalized writes use existing time-series validation/provenance semantics.
- [x] `specs/ingestion/spec.md` DoD items for the framework are updated with completion evidence.
- [x] `pnpm check && pnpm typecheck && pnpm test` pass.

## Completion Evidence

- Added D1/Drizzle schema and migration `0008_ingestion_framework.sql` for `ingestion_connectors`, `ingestion_runs`, and generic `ingestion_idempotency_keys`.
- Added authenticated REST/service paths under `/api/v1/ingestion/connectors` for connector CRUD, run listing, and bridge/manual run recording.
- Ingestion writes reuse the shared time-series bulk-input validation path, then write time-series points and idempotency rows in one atomic D1 batch using connector source labels and connector/run metadata provenance.
- Duplicate prevention uses a D1 idempotency table keyed by owner, connector, source item id, metric series key, and observed timestamp. Idempotency rows use the typed `i` suffix.
- Worker tests in `apps/worker/test/ingestion.test.ts` cover owner scoping, unauthorized connector update rejection, run lifecycle, successful cursor/checkpoint update, sanitized failed runs without partial point writes, idempotent replay skips, contested overlapping replay, and existing suite regression.
- Verification: `pnpm check && pnpm typecheck && pnpm test` passed on 2026-06-22 (10 test files, 214 tests). `pnpm build` also passed.

## Ship-PBI Log

- **Iteration 1 (implementor):** Added the generic ingestion framework: D1 schema/migration for connectors, runs, and idempotency keys; `apps/worker/src/ingestion.ts`; authenticated `/api/v1/ingestion/connectors*` routes; shared time-series validation extraction; and ingestion tests. Initial gates passed (`pnpm check && pnpm typecheck && pnpm test`, 213 tests) and `pnpm build` passed.
- **Critic pass 1:** Found two blocking PBI-016 issues: idempotency was not atomic because points were written before idempotency rows, and idempotency table rows reused the connector ID type. Critic also noted unrelated PBI-015/worktree changes in the full diff; those were not PBI-016 changes and were left untouched.
- **Iteration 2 (fix pass):** Reworked ingestion writes into one D1 batch using `insert or ignore` idempotency reservations plus conditional time-series inserts/updates; added typed `ingestionIdempotencyKey` IDs with suffix `i`; adjusted schema/migration for atomic reservation; and added contested replay coverage.
- **Deterministic gates:** `pnpm check && pnpm typecheck && pnpm test` passed after the fix (10 test files, 214 tests). `pnpm build` passed.
- **Critic pass 2:** Passed with no blocking findings. Critic confirmed the previous blockers were fixed and treated unrelated PBI-015 backup/workflow/UI-formatting worktree changes as out of PBI-016 scope.
