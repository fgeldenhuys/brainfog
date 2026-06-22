# Garmin Cloudflare Egress Spike

PBI: `tasks/PBI-018-garmin-cloudflare-egress-spike.md`

## Probe Shape

- Runtime: Cloudflare Container running Python 3.12 via `apps/worker/containers/garmin-spike/Dockerfile`.
- Trigger: authenticated admin-only `POST /api/v1/ingestion/spikes/garmin` on the brainfog Worker.
- Credentials: supplied only in the request body for the manual spike run; not committed, not persisted in D1, and not returned.
- Library: `garminconnect` plus `curl_cffi`, installed into the container image.
- Data bound: one login attempt, profile metadata call, one recent activity-list call, and today's daily summary call.
- Session state: `GARMINTOKENS` points at a temporary directory removed after every probe attempt.

## Manual Run

Deploy first so the request originates from Cloudflare egress:

```bash
pnpm run deploy
```

Then call the hosted Worker with a brainfog admin bearer token and one-time Garmin credentials:

```bash
curl -sS https://<brainfog-host>/api/v1/ingestion/spikes/garmin \
  -H "authorization: Bearer <brainfog-admin-token>" \
  -H "content-type: application/json" \
  --data '{"email":"<garmin-email>","password":"<garmin-password>","mfa_code":"<optional-code>"}'
```

Expected response fields are sanitized diagnostics only: runtime, package versions, dependency import status, login/API booleans, failure category, and recommendation. Do not paste or commit raw Garmin credentials, MFA codes, tokens, or personal payloads.

## Spike Evidence

- Runtime used: Cloudflare Container invoked through the deployed Worker at `https://brainfog.francois-wmgc.workers.dev`.
- `python-garminconnect` install/start: succeeded. Hosted probe reported Python `3.12.13`, `garminconnect` `0.3.6`, `curl_cffi` `0.15.0`, and `dependency_import_ok: true`.
- Garmin login/token reuse: fresh login succeeded for the one-time probe (`login_ok: true`). This spike intentionally deleted token/session state after the run, so long-lived encrypted token reuse remains PBI-019 implementation scope.
- Activity or daily summary read: succeeded. The probe read profile metadata, one recent activity-list page (`activity_count_seen: 1`), and today's daily summary (`profile_read_ok: true`, `activities_read_ok: true`, `daily_summary_read_ok: true`).
- Cloudflare egress blocking/rate limiting: no blocking or rate limiting observed in this single hosted run.
- Recommendation for PBI-017/PBI-019: `proceed_with_risks`. Cloudflare Container egress and runtime are feasible for Garmin v1, but the connector still depends on unofficial private Garmin endpoints, possible MFA/session expiry behavior, Garmin bot detection changes, and encrypted per-connector token persistence.

## Completion Notes

- The probe is intentionally isolated from production ingestion tables and writes no `time_series_points`.
- The route is authenticated and admin-only to keep the spike from becoming a user-facing secret-submission endpoint.
- The container deletes token/session files after each attempt, so this spike does not exercise long-lived Garmin token reuse. If login succeeds but MFA is required repeatedly, PBI-019 will need an encrypted connector credential/session-state model before scheduled runs are viable.
