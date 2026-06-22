# PBI-019: Garmin Connector MVP

## Directive

Implement the Garmin connector MVP on top of the ingestion framework, encrypted connector credentials, and Garmin Cloudflare egress spike. The connector runs from Cloudflare-hosted infrastructure, fetches Garmin Connect data separately for each active Garmin connector/user, and records bounded daily summary and activity metrics as time-series records.

## Scope

- **Spec:** `specs/ingestion/spec.md`
- **Covers DoD items:** The Garmin-specific portions of the spec: Cloudflare-hosted Garmin runner, per-user encrypted credentials, Garmin connector type, activity ingestion, daily summary ingestion, Garmin time-series conventions, idempotency, run history, and tests.
- **Out of scope:**
  - Porting Garmin private auth flows to TypeScript in the main Worker.
  - Official Garmin Connect Developer Program integration.
  - Uploading activities or writing data back to Garmin.
  - Storing full raw Garmin API responses or FIT/GPX/TCX files in R2.
  - A polished connector setup UI.
  - Running a local/laptop bridge as the production solution.

## Dependencies

- PBI-016 must be complete first.
- PBI-017 encrypted connector credentials must be complete first.
- PBI-018 Garmin Cloudflare egress spike must produce a `proceed` or `proceed_with_risks` recommendation before this PBI starts.
- If PBI-018 proves Cloudflare Containers are required, this PBI may add the approved Container binding/runtime for the Garmin runner.

### PBI-018 Handoff

PBI-018 closed with `proceed_with_risks`: Cloudflare Container egress, `python-garminconnect`, login, one recent activity-list call, and today's daily summary call all succeeded from the deployed Worker. During this PBI, either promote/refactor the spike-only container and `/api/v1/ingestion/spikes/garmin` admin route into the production Garmin runner, or replace them and remove the spike-only route before close-out.

## Context

### Why This Work

Garmin is the first useful real connector for automated time-series ingestion. Daily summary metrics are useful, but the main goal is activity ingestion from the start: runs, rides, walks, hikes, or other Garmin activities should become queryable time-series events in brainfog.

Garmin's official API is not available as a normal personal self-serve API. The practical MVP is therefore a Cloudflare-hosted runner:

1. The scheduler/dispatcher lists active `garmin` connectors.
2. For each connector, the Worker decrypts only that connector's credential/session payload.
3. A Cloudflare-hosted Garmin runner, expected to be a Python Container using `python-garminconnect`, fetches Garmin Connect data for that one connector/user.
4. The runner returns bounded normalized daily/activity payloads and any refreshed Garmin token/session state.
5. brainfog validates, normalizes, deduplicates, records run history, inserts time-series points, and re-encrypts refreshed credential state for that connector.

### Multi-User Runner Contract

The Garmin runner must process one connector per invocation. A scheduled sync over many users is a loop/dispatch operation, not a shared Garmin session:

- Query active `garmin` connectors due for sync.
- Start one run per connector.
- Decrypt only that connector's credentials for the duration of that run.
- Pass only that connector's credential/session payload and cursor window to the runner.
- Write returned metrics with the connector owner's `owner_id` and optional `project_id`.
- Re-encrypt any refreshed token/session state back to that connector only.
- Do not reuse token files, cookies, in-memory clients, or temporary directories across connectors unless they are keyed per connector and cleaned up.

### Garmin Runner Payload Contract

Add a connector type such as `garmin` and an internal runner result shape. If an authenticated REST endpoint is useful for tests/manual runs, keep it owner-scoped under the framework's ingestion routes, for example:

- `POST /api/v1/ingestion/connectors/:id/garmin-runs`

Payload shape should be explicit and bounded. Recommended shape:

```json
{
  "cursor": { "from": "2026-06-01", "to": "2026-06-22" },
  "daily": [
    {
      "date": "2026-06-22",
      "steps": 7500,
      "resting_heart_rate": 52,
      "sleep_seconds": 27120,
      "stress_avg": 28,
      "body_battery_min": 35,
      "body_battery_max": 88,
      "active_calories": 620,
      "intensity_minutes": 48
    }
  ],
  "activities": [
    {
      "activity_id": "12345678901",
      "activity_uuid": "optional-garmin-uuid",
      "activity_name": "Morning Run",
      "activity_type": "running",
      "start_time": "2026-06-22T05:31:00Z",
      "duration_seconds": 2765,
      "moving_duration_seconds": 2700,
      "distance_meters": 10250,
      "calories": 690,
      "avg_heart_rate": 142,
      "max_heart_rate": 176,
      "elevation_gain_meters": 105,
      "avg_speed_mps": 3.79,
      "training_effect": 3.2
    }
  ]
}
```

The exact field names can be adjusted to match `python-garminconnect` output, but the runner/endpoint must accept only documented fields and reject unbounded raw dumps.

### Time-Series Mapping

Daily summary metrics use the `garmin.daily.*` namespace, one point per metric per day. Recommended initial series:

- `garmin.daily.steps` — count
- `garmin.daily.resting_heart_rate` — bpm
- `garmin.daily.sleep_hours` — h, converted from seconds if needed
- `garmin.daily.stress_avg` — score
- `garmin.daily.body_battery_min` — score
- `garmin.daily.body_battery_max` — score
- `garmin.daily.active_calories` — kcal
- `garmin.daily.intensity_minutes` — min

Activity metrics use the `garmin.activities.*` namespace, one or more points per activity using the activity start time as `observed_at`. Recommended initial series:

- `garmin.activities.duration` — min or s, choose one and document it
- `garmin.activities.moving_duration` — min or s, same unit family as duration
- `garmin.activities.distance` — km or m, choose one and document it
- `garmin.activities.calories` — kcal
- `garmin.activities.avg_heart_rate` — bpm
- `garmin.activities.max_heart_rate` — bpm
- `garmin.activities.elevation_gain` — m
- `garmin.activities.avg_speed` — m/s or min/km, choose one and document it
- `garmin.activities.training_effect` — score

Each activity point's metadata should include at least `activity_id`, `activity_type`, `activity_name`, and any available Garmin UUID. This keeps each metric independently queryable while preserving the activity grouping.

### Garmin Runner Tooling

Add a minimal Cloudflare-hosted runner, expected to be a Cloudflare Container, that:

- Installs/uses `python-garminconnect` in a Python runtime that supports its dependencies.
- Receives one connector's decrypted credential/session payload per invocation.
- Performs Garmin login/token refresh for that connector only.
- Supports a date range or since cursor.
- Fetches daily summaries and activities.
- Emits the bounded runner payload plus any refreshed token/session state.
- Never writes Garmin credentials or cached tokens into the repo or shared container image.

If `python-garminconnect` needs token files, they must be created in per-run/per-connector temporary storage and removed after the run unless their contents are returned to the Worker for encrypted D1 storage.

### Series Convention

Before production ingestion, create or update a `record_fact` convention for `garmin.daily.*` and `garmin.activities.*` that documents:

- each series key,
- units,
- timestamp semantics,
- metadata fields,
- idempotency key fields,
- whether omitted Garmin fields are skipped or recorded as null-valued points.

Tests do not need to call live Garmin or create production facts, but the PBI should document the convention text expected for setup.

## Intent Preservation

1. **Activities included from day one.** Do not ship a daily-summary-only Garmin connector.
2. **Cloudflare-hosted, not laptop-hosted.** Do not ship a production local/laptop bridge.
3. **Bounded payloads only.** The runner returns normalized Garmin data, not arbitrary raw Garmin API dumps.
4. **Idempotent activity ingestion.** Replaying the same Garmin activity must not create duplicate activity metric points.
5. **Time-series first.** Activities are represented as time-series points, not a new activity table, unless implementation proves idempotency requires a small generic ingestion idempotency table from PBI-016.
6. **Per-user isolation.** Garmin runs for different connectors/users must use separate encrypted credentials, separate cursor state, and separate temporary runtime state.
7. **No secrets committed.** Garmin username, password, MFA codes, cached Garmin tokens, encryption keys, and brainfog bearer tokens remain secrets and are never committed.

## Verification

### Build and Type Checks

- `pnpm check && pnpm typecheck && pnpm test` pass.
- `pnpm build` passes if Worker routes or bindings change.

### Unit / Worker Tests

- Garmin connector accepts a valid runner payload with both `daily` and `activities` arrays.
- Garmin connector rejects unknown connector IDs, non-Garmin connector IDs, another user's connector, and malformed payloads.
- Scheduled Garmin dispatch creates separate runs for multiple active Garmin connectors owned by different users.
- Each Garmin run decrypts and uses only that connector's credential payload.
- Daily payload maps to expected `garmin.daily.*` time-series points with correct units, timestamps, and metadata.
- Activity payload maps to expected `garmin.activities.*` time-series points with correct units, activity start timestamp, and activity metadata.
- Replaying the same activity payload does not duplicate activity metric points.
- Replaying the same daily payload does not duplicate daily metric points.
- Run history records inserted/skipped counts for Garmin runner results.
- Existing ingestion-framework and time-series tests continue to pass.

### Runner Verification

- Provide a runner dry-run mode that returns/prints a bounded payload without writing time-series rows, or document an equivalent command.
- Before closing this PBI, perform one Cloudflare-hosted runner run using a real Garmin account for one connector and verify brainfog records both activity and daily metrics. Do not close PBI-019 with fixture-only evidence unless live Garmin access is explicitly unavailable and a follow-up PBI is opened.
- No live Garmin payload fixtures containing personal data are committed.

## Refinement Protocol

- If `python-garminconnect` field names differ from the proposed payload, adapt the runner mapper but keep the brainfog endpoint bounded and documented.
- If Garmin auth breaks during implementation, keep brainfog-side normalization/tests shippable using fixtures and stop before claiming the connector is production-ready.
- If PBI-018 found Cloudflare egress blocked and no approved mitigation exists, do not implement this PBI as if Cloudflare-hosted Garmin sync works.
- If activity data contains multiple sports with incompatible metrics, normalize the common core first and keep sport-specific metrics in metadata or a follow-up PBI.
- If raw activity files such as FIT/GPX/TCX become necessary, stop and propose a separate ADR/PBI because that expands storage beyond normalized time-series metrics.

## Close-Out Checklist

- [ ] Garmin connector type and Cloudflare-hosted runner implemented.
- [ ] Multi-user scheduled dispatch runs once per active Garmin connector with isolated credentials.
- [ ] Daily summary and activity payload validation implemented.
- [ ] `garmin.daily.*` and `garmin.activities.*` normalization implemented.
- [ ] Activity and daily idempotency tested.
- [ ] Runner dry-run/manual-run path documented without committed secrets.
- [ ] Garmin namespace convention documented for setup.
- [ ] `specs/ingestion/spec.md` DoD items for Garmin are updated with completion evidence.
- [ ] `pnpm check && pnpm typecheck && pnpm test` pass.
