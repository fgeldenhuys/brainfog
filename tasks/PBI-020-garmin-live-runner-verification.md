# PBI-020: Garmin Live Runner Verification

## Directive

Perform the live Cloudflare-hosted verification required before closing PBI-019 as production-ready: expose the missing MCP setup/run surface, run the promoted Garmin Container path for one real Garmin connector through MCP, and verify brainfog records both daily summary and activity metrics without committing secrets or personal payload fixtures.

## Scope

- **Spec:** `specs/ingestion/spec.md`
- **Covers DoD items:** MCP ingestion/Garmin setup tools plus live promoted-runner verification for Garmin daily and activity ingestion.
- **Out of scope:** New Garmin fields, UI polish, official Garmin API integration, raw FIT/GPX/TCX storage, or changing the credential/auth model.

## Intent Preservation

1. Use Cloudflare-hosted infrastructure, not a laptop bridge.
2. Use MCP as the agent-facing end-to-end interface for connector setup, credential storage, runner invocation, run inspection, and time-series verification.
3. Use one connector's encrypted credentials and one isolated runner invocation.
4. Verify both `garmin.daily.*` and `garmin.activities.*` rows are recorded in brainfog.
5. Do not commit Garmin usernames, passwords, MFA codes, cached tokens, bearer tokens, or live personal health payloads.
6. Record only sanitized evidence: MCP tool shapes, timestamps, row counts, series keys, and redacted connector/run IDs as needed.

## Verification

- Add MCP tools for owner-scoped ingestion connector create/list/update, encrypted credential create/status/delete, ingestion run listing, and Garmin manual runner invocation.
- Configure or identify one real Garmin connector with encrypted credentials in the Cloudflare-hosted environment through MCP.
- Invoke the promoted Garmin runner path through MCP for a bounded cursor window that should include at least one daily summary and one activity.
- Confirm an `ingestion_runs` row succeeds and time-series rows exist under both `garmin.daily.*` and `garmin.activities.*` for that run using MCP-accessible verification.
- Confirm no live payload fixtures or secrets are committed.
- Update `tasks/PBI-019-garmin-connector-mvp.md`, `specs/ingestion/spec.md`, and `docs/notes/garmin-runner.md` with sanitized live-run evidence.

## Close-Out Checklist

- [x] MCP ingestion/Garmin setup and runner tools implemented and tested.
- [x] Live Cloudflare-hosted promoted Garmin runner invocation completed.
- [x] Daily metric rows verified in brainfog.
- [x] Activity metric rows verified in brainfog.
- [x] Sanitized evidence added to PBI/spec/docs.
- [x] No Garmin secrets or personal payload fixtures committed.

## Completion Evidence

- Deployed Worker version: `b5c8fd68-96e0-4192-9dce-f2cce3526353` at `https://brainfog.francois-wmgc.workers.dev`.
- Production D1 was migrated through `0009_connector_credentials.sql`; ingestion tables now exist remotely.
- Production secret `BRAINFOG_CONNECTOR_ENCRYPTION_KEY` was configured with a new Wrangler-managed random value before storing connector credentials.
- MCP setup flow used `whoami`, `create_ingestion_connector`, `set_connector_credentials`, `run_garmin_connector`, `list_ingestion_runs`, and `list_time_series_points`.
- Connector evidence: one `garmin` connector for `francois`, redacted id `bfw03...kwn`, active status, cursor window `2026-06-01` through `2026-06-23`.
- Credential evidence: stored through MCP as encrypted connector credentials; response returned only redacted summary (`man***`, password prefix redacted) and no plaintext credential values.
- Runner evidence: MCP `run_garmin_connector` invoked the promoted Cloudflare Garmin Container path with encrypted credentials; redacted run id `bfsf...3nu` succeeded at `2026-06-23T08:29:16Z`.
- Run counts: `inserted_count=71`, `skipped_count=0`, `failed_count=0`, `daily_count=23`, `activity_count=6`.
- Time-series verification for that run: `garmin.daily.*` recorded 26 rows across 5 series; `garmin.activities.*` recorded 45 rows across 8 series.
- Verified series included `garmin.daily.steps`, `garmin.daily.resting_heart_rate`, `garmin.daily.sleep_hours`, `garmin.daily.active_calories`, `garmin.daily.intensity_minutes`, plus `garmin.activities.duration`, `garmin.activities.moving_duration`, `garmin.activities.distance`, `garmin.activities.calories`, `garmin.activities.avg_heart_rate`, `garmin.activities.max_heart_rate`, `garmin.activities.elevation_gain`, and `garmin.activities.avg_speed`.
- No Garmin username, password, cached tokens, bearer tokens, or live personal payload fixtures were added to committed files.
