# Garmin runner MVP

The Garmin connector uses unofficial Garmin Connect access through `python-garminconnect` in a Cloudflare Container (`GarminContainer`). It is not Garmin's official business/developer API. Known risks from the PBI-018 spike remain: Garmin may change private endpoints, require MFA, rate-limit, or block Cloudflare egress.

PBI-019 implementation and critic follow-up verified the brainfog-side bounded payload, normalization, idempotency, scheduled failure isolation, and container build paths with tests. A live Cloudflare-hosted run of the promoted MVP runner against a real Garmin connector was not performed during critic follow-up; PBI-020 tracks that required verification before claiming production readiness.

## Manual and dry-run paths

- Brainfog-side validation/normalization dry run: `POST /api/v1/ingestion/connectors/:id/garmin-runs` with `{ "dry_run": true, "runner_payload": { "daily": [...], "activities": [...] } }`. This returns normalized point previews and does not write time-series rows.
- Manual bounded ingest: `POST /api/v1/ingestion/connectors/:id/garmin-runs` with a bounded runner payload containing only documented `daily`, `activities`, and optional `cursor` fields. This records an ingestion run and writes idempotent time-series points.
- Cloudflare-hosted scheduled sync invokes the Garmin Container once per active `garmin` connector, decrypting only that connector's credential payload for the invocation.
- Runner credential/session refresh payloads are accepted only for documented credential/session fields (`username`, `email`, `password`, `token`, `tokens`, `tokenstore`, `oauth1`, `oauth2`, `session`, `cookies`, `expires_at`) and are stored encrypted through the connector credential service.

Do not commit Garmin usernames, passwords, MFA codes, cached tokens, bearer tokens, or live personal payloads. Store connector credentials only through `/api/v1/ingestion/connectors/:id/credentials`.

## Garmin time-series namespace convention

Setup convention text for `record_fact` before production ingestion:

`garmin.daily.*` uses one point per metric per calendar day at `YYYY-MM-DDT00:00:00Z`; omitted Garmin fields are skipped rather than recorded as null. Metadata includes `external_date`, `connector_id`, `connector_type`, `ingestion_run_id`, and `source_system: garmin`. Idempotency uses owner, connector, source item id `daily:<date>`, series key, and observed timestamp.

Daily series and units: `garmin.daily.steps` count, `garmin.daily.resting_heart_rate` bpm, `garmin.daily.sleep_hours` h, `garmin.daily.stress_avg` score, `garmin.daily.body_battery_min` score, `garmin.daily.body_battery_max` score, `garmin.daily.active_calories` kcal, `garmin.daily.intensity_minutes` min.

`garmin.activities.*` uses one point per metric per activity at the Garmin activity start timestamp. Metadata includes `activity_id`, `activity_uuid` when available, `activity_name`, `activity_type`, `start_time`, `connector_id`, `connector_type`, `ingestion_run_id`, and `source_system: garmin`. Idempotency uses owner, connector, source item id `activity:<activity_id>`, series key, and observed timestamp.

Activity series and units: `garmin.activities.duration` s, `garmin.activities.moving_duration` s, `garmin.activities.distance` m, `garmin.activities.calories` kcal, `garmin.activities.avg_heart_rate` bpm, `garmin.activities.max_heart_rate` bpm, `garmin.activities.elevation_gain` m, `garmin.activities.avg_speed` m/s, `garmin.activities.training_effect` score.
