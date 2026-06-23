# Spec: Automated Ingestion

## Blueprint

### Context

brainfog already stores generic `time_series_points` with provenance, bulk inserts, and series-convention guidance. This spec defines the next layer: automated ingestion tasks that collect data from remote sources, normalize it into brainfog's time-series model, and record durable ingestion run metadata.

The first target connector is Garmin. Garmin's official Garmin Connect APIs are not open for normal personal use; they require approval through Garmin's developer/business program. Unofficial libraries such as `python-garminconnect` can access personal Garmin Connect data through private web/mobile endpoints, but their authentication flows are brittle and may require MFA, token refresh, and client/TLS behavior that a normal JavaScript Worker should not reimplement.

PBI-016 (`tasks/PBI-016-ingestion-framework.md`) implements the generic ingestion framework. PBI-017 (`tasks/PBI-017-encrypted-connector-credentials.md`) adds encrypted per-user connector credential storage. PBI-018 (`tasks/PBI-018-garmin-cloudflare-egress-spike.md`) de-risks Garmin access from Cloudflare before the full connector is built. PBI-019 (`tasks/PBI-019-garmin-connector-mvp.md`) implements the Garmin connector MVP on top of those prerequisites.

### Architecture

- **API Contracts**:
  - Authenticated REST routes under `/api/v1/ingestion/*` manage connector definitions, inspect run history, and accept connector payloads. These routes use the existing bearer-token/OAuth auth model and derive `owner_id` from the authenticated user.
  - Authenticated REST routes under `/api/v1/ingestion/connectors/:id/credentials` let a connector owner create, rotate, inspect redacted status for, and delete connector credentials. Plaintext credentials are accepted only on create/update and are never returned.
  - MCP tools are required for connector inspection, connector setup, credential status/update, run history, and manual Garmin runner invocation so agent-driven ingestion can be tested end-to-end without falling back to a separate REST client. Credential tools must accept plaintext only for create/update, return only redacted metadata, and share the same service-layer owner checks as REST.
  - Scheduled ingestion uses Cloudflare-native scheduling or Workflows. A scheduler/dispatcher enumerates active connectors and starts one isolated run per connector, so multiple users' Garmin connectors run separately with their own encrypted credentials and cursor state.
  - Time-series writes must call the same service-layer normalization and validation path as `record_time_series_points`; ingestion must not write directly to D1 in a way that bypasses provenance or owner scoping.

- **Data Models** (D1, via Drizzle; exact names may be refined during implementation):
  - **`ingestion_connectors`**: connector definitions owned by a user, including connector type, display name, status, project scope, configuration metadata, schedule/cadence metadata, cursor/checkpoint metadata, source label, timestamps, and optional last success/error fields.
  - **`ingestion_runs`**: append-only run history for a connector, including status, trigger type (`manual | scheduled | bridge`), started/finished timestamps, cursor/window, counts inserted/skipped/failed, and sanitized error metadata.
  - **`ingestion_connector_credentials`**: encrypted per-connector credential records owned by the connector owner. Stores credential type, encrypted payload, encryption metadata, status (`missing | valid | needs_setup | mfa_required | expired | revoked | error`), safe redacted summary, optional expiry/last-verified timestamps, provenance, and timestamps. The encrypted payload may contain API keys, OAuth refresh tokens, or connector-specific session/token state. It must never store plaintext credentials.
  - Optional **`ingestion_events`** or run detail rows may be added only if run-level counts are insufficient for debugging.
  - Time-series points produced by ingestion remain canonical in the existing `time_series_points` table.

- **Connector Model**:
  - Each connector type defines a bounded input shape, a normalization function, a source label, and an idempotency strategy.
  - Connector output is an array of time-series point inputs with `series_key`, `value`, `unit`, `observed_at`, optional `project_id`, and `metadata`.
  - Connector metadata on each point should include enough source identity to support duplicate detection and audit, for example `connector_id`, `run_id`, `source_system`, `external_id`, `external_date`, or `external_activity_id`.
  - Duplicate prevention is required. The implementation may use a deterministic metadata key lookup, connector cursor windows, or a dedicated idempotency table, but repeated ingestion of the same source item must not create duplicate time-series points.
  - Connector credentials are always scoped to one connector and one owner. Scheduled runners must decrypt and use credentials only for the connector currently being processed, then discard plaintext from memory after the run.

- **Credential Encryption Model**:
  - D1 stores encrypted credential payloads so users can configure connectors without editing Worker secrets.
  - A deployment-level Wrangler secret such as `BRAINFOG_CONNECTOR_ENCRYPTION_KEY` is the root key used by the Worker to encrypt/decrypt connector credential payloads with WebCrypto (for example AES-GCM with per-record random IVs). This root key is not user-specific and is never stored in D1.
  - Credential create/update endpoints accept plaintext only over authenticated requests from the connector owner, encrypt before write, and return only redacted metadata. Read/list endpoints return status, redacted summary, expiry, last verification, and timestamps, never decrypted payloads.
  - Credential rotation updates the encrypted payload and redacted summary atomically. Delete/revoke makes future runs fail closed with `missing` or `revoked` status.
  - Tests must prove D1 does not contain plaintext credential values, another user cannot read/write credentials for a connector they do not own, and responses never echo secrets.

- **Garmin MVP Model**:
  - Garmin v1 is Cloudflare-hosted but isolated from the main brainfog Worker runtime: a scheduled Worker/Workflow dispatches Garmin runs, and a Garmin runner (expected to be a Cloudflare Container running Python + `python-garminconnect`) fetches Garmin Connect data.
  - The scheduler enumerates active `garmin` connectors and runs each connector separately. Each run decrypts only that connector owner's Garmin credential/token payload, invokes the runner with that one user's credentials/session state, receives normalized data plus any refreshed token state, then re-encrypts updated credential state for that connector.
  - Before implementing the full Garmin connector, a spike must verify whether Garmin login/API access from Cloudflare egress is feasible. The spike must use a test-only Cloudflare Worker/Container path, avoid committing credentials or personal payloads, and record whether Garmin blocks Cloudflare IPs, private auth flow requirements, TLS/client impersonation, MFA, or `python-garminconnect` dependencies.
  - Garmin v1 must ingest both activities and daily summary metrics from the start.
  - Activities are represented as time-series points under the `garmin.activities.*` namespace, with one or more independently queryable metrics per activity event. Recommended initial series include duration, distance, calories, average heart rate, max heart rate, elevation gain, and training effect where present.
  - Daily summary metrics are represented under `garmin.daily.*`, with recommended initial series including steps, resting heart rate, sleep hours, stress, Body Battery, active calories, and intensity minutes where present.
  - Raw Garmin API responses are not archived wholesale in D1 or R2 in v1. Store only normalized fields and useful source metadata.

- **Dependencies**:
  - The generic framework must remain Cloudflare-only: Worker, D1, and optionally Workflows/Queues if already accepted for this project.
  - The Garmin runner may require Cloudflare Containers because `python-garminconnect` depends on Python packages such as `curl_cffi` that are unlikely to run in a standard Python Worker. Adding a Container binding is a new Cloudflare product/binding and must be explicitly approved/implemented in the Garmin spike or Garmin connector PBI.
  - Do not add Garmin credentials, tokens, or personal health data samples to committed files.

- **Constraints**:
  - D1 remains canonical for connector definitions, run history, and time-series points.
  - Every ingestion-created time-series point records provenance: owner, source, observed timestamp, created/updated timestamps, connector/run metadata, and project scope when supplied.
  - `/api/v1/ingestion/*` routes must be authenticated except any future health/introspection route that is explicitly documented as safe and non-sensitive.
  - Secrets never live in committed files. Production root encryption keys are Wrangler-managed; user connector credentials and refreshed connector token state are encrypted in D1.
  - Multi-user connector runs must be isolated by connector ID and owner ID. A Garmin run for one connector must not read, decrypt, reuse, log, or update credentials belonging to another connector or owner.
  - Ingestion must not become a raw personal-data firehose. Prefer curated, typed metrics with documented series conventions.

## Contract

### Definition Of Done

- [x] D1 schema and migrations define connector definitions and run history for automated ingestion. Evidence: PBI-016 added `ingestion_connectors`, `ingestion_runs`, and `ingestion_idempotency_keys` in `packages/db/src/schema.ts` and migration `0008_ingestion_framework.sql`.
- [x] Authenticated service functions and REST routes can create/list/update connector definitions and list run history for the authenticated owner. Evidence: PBI-016 added owner-scoped `/api/v1/ingestion/connectors*` routes and service functions in `apps/worker/src/ingestion.ts`, covered by `apps/worker/test/ingestion.test.ts`.
- [x] A connector execution path records run lifecycle state and writes normalized time-series points through the existing service-layer validation path. Evidence: PBI-016 `recordIngestionRun` records running/succeeded/failed rows, validates with the shared time-series bulk-input validator, and writes points/idempotency rows in one atomic D1 batch preserving bulk insert semantics.
- [x] Ingestion-created points carry connector/run provenance in `source` and/or `metadata`, and never accept `owner_id` from the client. Evidence: PBI-016 derives owner from auth context, uses connector source labels, and adds connector/run metadata to each point.
- [x] Duplicate prevention is implemented and covered by tests. Evidence: PBI-016 uses a D1 idempotency table keyed by owner, connector, source item id, series key, and observed timestamp; replay behavior is covered in `ingestion.test.ts`.
- [x] Scheduled/manual run support exists for connectors that can execute inside the Worker, without weakening existing auth or memory invariants. Evidence: PBI-016 run recording supports `manual`, `scheduled`, and `bridge` triggers behind existing `/api/v1/*` auth; concrete connector executors remain connector-specific.
- [x] D1 stores encrypted per-connector credential payloads, backed by a Wrangler-managed root encryption key, with authenticated owner-scoped create/update/delete/status routes that never return plaintext secrets.
  Evidence: PBI-017 added ingestion_connector_credentials schema/migration, WebCrypto AES-256-GCM encryption, authenticated credential PUT/GET/DELETE routes at /api/v1/ingestion/connectors/:id/credentials, redacted responses without plaintext echo, owner-scoped access controls, and tests in apps/worker/test/ingestion-credentials.test.ts.
- [x] A Cloudflare egress spike verifies and documents whether Garmin Connect login/API access works from Cloudflare-hosted runtime using `python-garminconnect` or an equivalent minimal probe, without committing credentials or personal payloads. Evidence: PBI-018 added an admin-only `/api/v1/ingestion/spikes/garmin` route backed by a Cloudflare Container running Python 3.12 with `garminconnect` 0.3.6 and `curl_cffi` 0.15.0; the hosted run logged in, read profile metadata, one recent activity-list page, and today's daily summary from Cloudflare egress. Sanitized results are recorded in `docs/notes/garmin-cloudflare-egress-spike.md` with recommendation `proceed_with_risks`.
- [x] Garmin Cloudflare-hosted runner ingestion accepts or produces bounded payloads for daily summary metrics and activities, validates them, normalizes them into `garmin.daily.*` and `garmin.activities.*` time-series points, and records run history. Evidence: PBI-019 promoted the spike into `GarminContainer`, added the bounded `/api/v1/ingestion/connectors/:id/garmin-runs` path, scheduled Garmin dispatch, `apps/worker/src/garmin.ts` validation/normalization, and `apps/worker/test/garmin.test.ts` run-history/idempotency/failure-isolation coverage. PBI-020 completed a live MCP-driven Cloudflare-hosted Garmin Container run for connector `bfw03...kwn`; run `bfsf...3nu` succeeded with 71 inserted points, including 26 `garmin.daily.*` rows and 45 `garmin.activities.*` rows.
- [x] MCP tools can create/list/update ingestion connectors, store/read/revoke encrypted connector credentials without returning plaintext, list ingestion runs, and manually invoke the Garmin runner for one connector using either a bounded dry-run payload or the promoted Cloudflare Container path. Evidence: PBI-020 added MCP tools in `apps/worker/src/mcp/index.ts`, covered them with Worker-runtime MCP tests in `apps/worker/test/garmin.test.ts`, deployed Worker version `b5c8fd68-96e0-4192-9dce-f2cce3526353`, and used MCP for the live connector setup/run/verification.
- [x] Garmin runner documentation explains that the connector uses unofficial Garmin Connect access via `python-garminconnect` in a Cloudflare-hosted runner, not Garmin's official business API, and documents known Cloudflare egress/auth risks. Evidence: PBI-019 added `docs/notes/garmin-runner.md` with manual/dry-run instructions, unofficial API risks, and Garmin namespace convention setup text.
- [x] Tests cover connector CRUD, encrypted credential storage, per-user credential isolation, run lifecycle, idempotency, Garmin daily summary ingestion, Garmin activity ingestion, auth rejection, and existing time-series behavior. Evidence: PBI-019 added `apps/worker/test/garmin.test.ts`; PBI-016/PBI-017 tests continue to cover generic connector CRUD, run lifecycle, encrypted credentials, isolation, and existing ingestion/time-series behavior.
  Additional evidence: PBI-017 adds credential-specific test coverage in apps/worker/test/ingestion-credentials.test.ts covering ciphertext storage, safe GET responses, credential replacement, revoke/delete, cross-user isolation, encryption key failure modes, and redacted summary generation.
- [x] `pnpm check && pnpm typecheck && pnpm test` pass. Evidence: PBI-019 critic follow-up reran `pnpm check && pnpm typecheck && pnpm test` successfully (227 Vitest tests passed), followed by `pnpm build` successfully because Worker/container code changed. This is fixture/test/build evidence only, not live Garmin verification.

### Regression Guardrails

- Existing MCP and REST memory tools must continue to use bearer-token/OAuth auth and owner scoping unchanged.
- `time_series_points` remains the canonical place for ingested metrics; ingestion must not introduce a parallel metrics store.
- Vectorize is not involved in ingestion-created time-series points.
- Garmin credentials, Garmin cached tokens, bearer tokens, encryption root keys, and raw personal health exports must never be committed.
- If Garmin cannot run reliably from Cloudflare after the spike, do not implement a laptop/local bridge silently. Stop and decide whether to accept a non-Cloudflare runner, pursue Garmin's official API, or drop/defer the connector.
- Multi-user scheduled ingestion must process each connector separately and must not share decrypted credential/session state across users or connectors.

### Scenarios

```gherkin
Feature: Automated ingestion

  Scenario: Creating an ingestion connector
    Given an authenticated user
    When they create an ingestion connector definition
    Then the connector is stored in D1 owned by that user
    And it records source, status, configuration metadata, and timestamps

  Scenario: Running a connector records time-series points
    Given an authenticated user has an active connector
    When a connector run produces normalized time-series metrics
    Then a run history row is created
    And time-series points are inserted through the existing time-series service layer
    And the points include connector and run provenance

  Scenario: Replaying the same source payload is idempotent
    Given a connector has already ingested a source item
    When the same source item is submitted again
    Then duplicate time-series points are not created
    And the run history records skipped or duplicate counts

  Scenario: Storing connector credentials
    Given an authenticated user owns an ingestion connector
    When they save connector credentials
    Then D1 stores only encrypted credential payloads and safe redacted metadata
    And reading credential status never returns plaintext secrets

  Scenario: Agent-driven Garmin setup and manual run through MCP
    Given an authenticated MCP client for a brainfog user
    When it creates a Garmin connector, stores encrypted Garmin credentials, and invokes the Garmin runner tool for that connector
    Then the same owner-scoped service layer used by REST records an ingestion run
    And daily metrics are recorded under `garmin.daily.*`
    And activity metrics are recorded under `garmin.activities.*`
    And no credential plaintext is returned by MCP responses

  Scenario: Running scheduled connectors for multiple users
    Given two users each own an active Garmin connector with separate encrypted credentials
    When the scheduled Garmin dispatcher runs
    Then it starts separate runs for each connector
    And each run decrypts only that connector's credential payload
    And each user's time-series points are owned by the correct user

  Scenario: Garmin runner ingests activities
    Given the Cloudflare-hosted Garmin runner has fetched activity data for one connector
    When it returns a bounded Garmin activity payload to brainfog
    Then activity metrics are recorded under `garmin.activities.*`
    And each metric references the Garmin activity id in metadata

  Scenario: Garmin runner ingests daily summaries
    Given the Cloudflare-hosted Garmin runner has fetched daily wellness data for one connector
    When it returns a bounded Garmin daily summary payload to brainfog
    Then daily metrics are recorded under `garmin.daily.*`
    And the namespace convention is documented before production use
```
