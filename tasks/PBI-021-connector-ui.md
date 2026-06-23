# PBI-021: Connector UI

## Directive

Update the authenticated web UI so a human can inspect ingestion connectors, view safe connector details, and review previous ingestion runs without exposing connector secrets or plaintext credential state.

## Scope

- **Spec:** `specs/ingestion/spec.md`
- **Related UI context:** Preserve the existing authenticated default UI patterns and route conventions.
- **Covers DoD items:** Human-facing inspection for the connector and run-history capabilities already implemented by the ingestion framework, encrypted connector credentials, Garmin connector MVP, and MCP connector tooling.
- **Out of scope:**
  - Creating a polished connector setup wizard.
  - Accepting or editing plaintext connector credentials in the browser.
  - Adding new connector types.
  - Changing Garmin runner behavior, schedule dispatch, idempotency, or time-series normalization.
  - Adding a new frontend framework, charting dependency, or client-side router.
  - Changing the auth/token model or any `/api/v1/ingestion/*` service contract unless a small read-only UI adapter is strictly necessary.

## Dependencies

- PBI-016 automated ingestion framework must be complete.
- PBI-017 encrypted connector credentials must be complete.
- PBI-019/PBI-020 Garmin connector implementation and live runner verification must be complete.
- Existing frontend default UI routes from `specs/frontend/spec.md` must remain intact.

## Context

### Why This Work

Connectors can now be created, credentialed, run, and inspected through REST/MCP, but the default web UI does not expose this operational state. A human should be able to answer basic questions from the browser:

1. Which connectors exist for my account?
2. Which connector types/statuses are active, paused, disabled, failing, or missing setup?
3. When did each connector last run and last succeed?
4. What safe configuration, schedule, cursor, and project scope is associated with a connector?
5. What happened in previous runs, including counts and sanitized errors?
6. Does a connector have credential status metadata, without showing any secret material?

This is an observability and review surface, not a secret-entry or connector-onboarding flow.

### Target UI Shape

Extend the existing server-rendered Hono JSX web UI with a connector section, preserving the current no-SPA approach:

- Add navigation from the authenticated app shell to a Connectors page.
- `GET /app/connectors` lists the authenticated user's connectors.
- `GET /app/connectors/:id` shows one owned connector detail page.
- The detail page includes a recent run-history table for that connector.
- If needed, add read-only UI service helpers under `/api/v1/ui/*`, but prefer reusing the existing ingestion service functions directly from UI handlers.
- All pages must work as normal server-rendered HTML without JavaScript.

### Connector List Requirements

The connector list should show safe, scannable operational fields:

- Connector name and type.
- Status (`active`, `paused`, `disabled`, or supported framework status values).
- Source label.
- Project scope when present.
- Last run timestamp.
- Last success timestamp.
- Sanitized last error summary when present.
- Credential status if available (`missing`, `valid`, `needs_setup`, `mfa_required`, `expired`, `revoked`, or `error`).
- Link to the connector detail page.

The list must not show encrypted credential payloads, credential redacted summaries that contain sensitive values, bearer tokens, Garmin usernames, cached session tokens, cookies, or raw personal payloads.

### Connector Detail Requirements

The connector detail page should show enough context to audit a connector safely:

- Connector identity: `id`, name, type, source, status, owner-scoped project link/name when present.
- Operational state: schedule metadata, cursor/checkpoint metadata, timestamps, last run, last success, sanitized last error.
- Safe configuration metadata, rendered as escaped JSON or a structured table.
- Credential status metadata from the existing redacted credential status path, if present.
- Recent ingestion runs for the connector, newest first.

Credential display rules:

- Never decrypt credentials for UI rendering.
- Never render plaintext credential payloads, encrypted payload blobs, IVs, encryption metadata, Garmin passwords, Garmin token/session contents, cookies, or bearer tokens.
- Only render credential lifecycle/status fields that are already safe in credential status responses.
- Treat any JSON string values as untrusted and HTML-escape them.

### Run History Requirements

Run history should make prior connector behavior understandable without exposing secrets:

- Run id.
- Trigger (`manual`, `scheduled`, `bridge`, or supported framework values).
- Status (`running`, `succeeded`, `failed`, or supported framework values).
- Started and finished timestamps.
- Inserted, skipped, and failed counts.
- Cursor/window before and after, rendered safely.
- Sanitized error metadata when present.
- Safe run metadata, rendered as escaped JSON or a structured table.

If pagination already exists in the UI patterns, use it for runs. Otherwise, show a reasonable recent limit, such as the latest 25 runs, and leave full pagination to a follow-up only if necessary.

## Intent Preservation

1. **No secret display.** The UI is read-only for credentials and must never reveal plaintext, encrypted blobs, or token/session internals.
2. **Owner scoping remains mandatory.** Users can list and inspect only their own connectors and runs.
3. **D1 remains canonical.** Connector state and run history are read from the existing D1-backed ingestion services.
4. **Server-rendered first.** Preserve the existing Hono JSX web UI approach; do not introduce a SPA or frontend build pipeline.
5. **No connector behavior changes.** UI work must not alter Garmin execution, scheduling, normalization, idempotency, or credential encryption semantics.
6. **Safe rendering.** All connector config, cursor, run metadata, and errors are untrusted data and must be HTML-escaped.

## Verification

### Build and Type Checks

- `pnpm check && pnpm typecheck && pnpm test` pass.
- `pnpm test:e2e` passes if the e2e suite is updated.
- `pnpm build` passes if Worker routes, bindings, or bundled UI assets change.

### Unit / Worker Tests

- Authenticated users can open `/app/connectors` and see only their own connectors.
- Connector list rows include type, status, last run/success fields, credential status where available, and detail links.
- Another user's connector never appears in the list.
- Authenticated users can open `/app/connectors/:id` for an owned connector.
- Opening another user's connector detail returns `404` or `403`, matching existing UI conventions.
- Detail page shows safe connector config/schedule/cursor metadata and recent run history.
- Detail page never renders plaintext credential values, encrypted credential blobs, bearer tokens, Garmin passwords, Garmin tokens, session cookies, or raw runner payloads.
- Run history renders sanitized errors and safely escaped JSON metadata.
- Existing Browser, Metrics, Users, document reader, MCP, and REST ingestion tests continue to pass.

### E2E Tests

- Browser login can navigate to the Connectors page from the app shell.
- A seeded or test-created connector appears in the connector list.
- The connector detail page shows previous runs without exposing credential-like fixture values.

## Refinement Protocol

- If the current ingestion service does not expose a UI-safe combined connector/credential/run read model, add the smallest owner-scoped helper needed rather than duplicating D1 queries in JSX components.
- If displaying credential status requires expanding the redacted status response, keep the response lifecycle-only and add tests proving secrets are not returned.
- If the navigation layout becomes crowded, add a top-level Connectors nav item rather than hiding connectors under Metrics or Users.
- If a requested UI action would require plaintext credential entry, pause and split that into a separate setup/rotation PBI.
- If this work requires changing `specs/ingestion/spec.md` or `specs/frontend/spec.md` Contract sections, ask before editing the contracts.

## Close-Out Checklist

- [x] `/app/connectors` exists and is authenticated/owner-scoped.
- [x] `/app/connectors/:id` exists and is authenticated/owner-scoped.
- [x] Connector list and detail pages render safe connector metadata, credential status, and run history.
- [x] Credential and run rendering are covered by tests that include secret-like fixture values and prove they do not appear in HTML.
- [x] App navigation links to Connectors.
- [x] `pnpm check && pnpm typecheck && pnpm test` pass.
- [x] `pnpm test:e2e` passes if updated for connector navigation. Not run because this PBI did not update the e2e suite.
- [x] `specs/ingestion/spec.md` and/or frontend completion evidence is updated only if implementation changes their Contract evidence. Not updated because no spec Contract evidence changed.

## Ship-PBI Log

- 2026-06-23: Implemented server-rendered authenticated connector list/detail UI under `/app/connectors`, added Connectors navigation, safe/redacted JSON rendering for config/schedule/cursor/run metadata, credential lifecycle-only display, and owner-scoped UI tests with secret-like credential/run fixtures. Verification passed: `pnpm check && pnpm typecheck && pnpm test` (229 tests) and `pnpm build`. E2E/spec completion evidence not updated because no e2e suite or Contract evidence was changed.
- 2026-06-23: Critic fix pass for blocking redaction gap. Extended UI redaction to treat username/email/login-style keys and email/token-like free-form string values as sensitive across connector config/schedule/cursor, list/detail last errors, and run metadata/errors. Expanded UI regression fixtures to include `username`, `email`, `login`, `message`, connector `last_error`, run metadata/error, and config/cursor values, proving those fixture values do not appear in rendered connector HTML. Verification passed: targeted `pnpm --filter @brainfog/worker test -- ui-pages.test.ts` (Vitest reported 229 tests), full `pnpm check && pnpm typecheck && pnpm test` (229 tests), and `pnpm build`.
- 2026-06-23: Critic pass 2 found no blocking issues. It confirmed the previous redaction issue was fixed, auth/owner scoping was preserved, no credential decryption or connector behavior changes were introduced, and PBI scope remained limited to connector UI/navigation/tests.
