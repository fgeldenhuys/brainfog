# PBI-020: Garmin Live Runner Verification

## Directive

Perform the live Cloudflare-hosted verification required before closing PBI-019 as production-ready: run the promoted Garmin Container path for one real Garmin connector and verify brainfog records both daily summary and activity metrics without committing secrets or personal payload fixtures.

## Scope

- **Spec:** `specs/ingestion/spec.md`
- **Covers DoD items:** Live promoted-runner verification for Garmin daily and activity ingestion.
- **Out of scope:** New Garmin fields, UI polish, official Garmin API integration, raw FIT/GPX/TCX storage, or changing the credential/auth model.

## Intent Preservation

1. Use Cloudflare-hosted infrastructure, not a laptop bridge.
2. Use one connector's encrypted credentials and one isolated runner invocation.
3. Verify both `garmin.daily.*` and `garmin.activities.*` rows are recorded in brainfog.
4. Do not commit Garmin usernames, passwords, MFA codes, cached tokens, bearer tokens, or live personal health payloads.
5. Record only sanitized evidence: command/request shape, timestamps, row counts, series keys, and redacted connector/run IDs as needed.

## Verification

- Configure or identify one real Garmin connector with encrypted credentials in the Cloudflare-hosted environment.
- Invoke the promoted Garmin runner path for a bounded cursor window that should include at least one daily summary and one activity.
- Confirm an `ingestion_runs` row succeeds and time-series rows exist under both `garmin.daily.*` and `garmin.activities.*` for that run.
- Confirm no live payload fixtures or secrets are committed.
- Update `tasks/PBI-019-garmin-connector-mvp.md`, `specs/ingestion/spec.md`, and `docs/notes/garmin-runner.md` with sanitized live-run evidence.

## Close-Out Checklist

- [ ] Live Cloudflare-hosted promoted Garmin runner invocation completed.
- [ ] Daily metric rows verified in brainfog.
- [ ] Activity metric rows verified in brainfog.
- [ ] Sanitized evidence added to PBI/spec/docs.
- [ ] No Garmin secrets or personal payload fixtures committed.
