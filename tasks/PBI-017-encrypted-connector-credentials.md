# PBI-017: Encrypted Connector Credentials

## Directive

Add encrypted, owner-scoped connector credential storage so users can configure future native connectors without editing Worker secrets, while keeping plaintext credentials out of D1, logs, responses, and committed files.

## Scope

- **Spec:** `specs/ingestion/spec.md`
- **Covers DoD items:** Encrypted per-connector credential payloads, root encryption key handling, authenticated credential create/update/delete/status routes, redacted responses, owner isolation, and tests.
- **Out of scope:**
  - Garmin-specific credential shapes or `python-garminconnect` token formats.
  - Cloudflare Containers or any Garmin runner implementation.
  - OAuth authorization flows for third-party services.
  - A rich connector setup UI.
  - Key rotation beyond documenting how a future rotation PBI should behave.

## Dependencies

- PBI-016 must be complete first because credentials attach to `ingestion_connectors`.
- A Wrangler-managed production secret named `BRAINFOG_CONNECTOR_ENCRYPTION_KEY` (or an explicitly chosen equivalent) must be configured before credential encryption can work in production.
- No new external dependency should be added; use WebCrypto available in the Worker runtime.

## Context

### Why This Work

Future native connectors need user-managed credentials. Those credentials cannot be Worker secrets because each user/connector needs different values and users must be able to set them up without redeploying brainfog. They also cannot be plaintext D1 rows.

This PBI adds the generic encrypted credential substrate before Garmin stores Garmin username/password, session tokens, or refreshed token state.

### Data Model

Add an `ingestion_connector_credentials` table, likely:

- `id`
- `owner_id`
- `connector_id`
- `source`
- `auth_type`
- `status` (`missing | valid | needs_setup | mfa_required | expired | revoked | error`)
- `encrypted_payload`
- `encryption_metadata` (algorithm, IV, key version, created by implementation)
- `redacted_summary`
- `expires_at`
- `last_verified_at`
- `created_at`
- `updated_at`

Credentials are owned by the same `owner_id` as their connector. The service layer must reject any connector/credential mismatch.

### API Shape

Recommended authenticated REST routes under `/api/v1/ingestion/connectors/:id/credentials`:

- `PUT /` creates or replaces encrypted credentials for the caller-owned connector.
- `GET /` returns redacted status/metadata only.
- `DELETE /` revokes or deletes credentials for the caller-owned connector.

Plaintext credential payloads are accepted only by `PUT`, encrypted before D1 write, and never returned.

MCP tools are optional and should not be added unless the plaintext handling and tool descriptions are very explicit.

### Encryption Model

- Use a Wrangler-managed root secret such as `BRAINFOG_CONNECTOR_ENCRYPTION_KEY`.
- Derive/import a WebCrypto key from that secret.
- Encrypt credential payload JSON with AES-GCM and a unique random IV per write.
- Store only ciphertext plus encryption metadata in D1.
- Keep redacted summaries safe, for example username/domain or token suffix only when useful.
- Fail closed if the root key is missing or malformed.

### Key Rotation

Full key rotation is out of scope. The table should include a key-version field in encryption metadata so a future PBI can re-encrypt credentials.

## Intent Preservation

1. **D1 encrypted, not plaintext.** D1 may store encrypted connector credentials, never raw API keys, passwords, refresh tokens, session cookies, or MFA codes.
2. **One root Worker secret.** Users configure connector credentials through authenticated API calls; only the root encryption key is a Wrangler secret.
3. **Owner isolation.** Users cannot create, read, update, delete, decrypt, or infer credentials for connectors they do not own.
4. **No secret echo.** API responses, validation errors, logs, test snapshots, and completion evidence must never contain plaintext credential values.
5. **Connector-agnostic.** Keep payload storage generic; Garmin-specific schema validation belongs to PBI-017.

## Verification

### Build and Type Checks

- `pnpm check && pnpm typecheck && pnpm test` pass.
- `pnpm build` passes if Worker env typings or config change.

### Unit / Worker Tests

- Saving credentials for a caller-owned connector stores ciphertext in D1 and no plaintext value appears in `encrypted_payload`, `encryption_metadata`, or `redacted_summary` unless explicitly redacted.
- `GET` credential status returns only safe metadata and never plaintext.
- Replacing credentials changes ciphertext and updates timestamps/status.
- Deleting/revoking credentials prevents future decrypt/use and returns a safe status.
- Another user cannot save/read/delete credentials for a connector they do not own.
- Missing/malformed `BRAINFOG_CONNECTOR_ENCRYPTION_KEY` fails closed.
- Existing ingestion connector tests continue to pass.

## Refinement Protocol

- If WebCrypto key import details require a stricter secret format, document it in `.dev.vars.example` with placeholders only.
- If credential payload validation becomes connector-specific, store opaque encrypted JSON and defer validation to connector PBIs.
- If implementation needs key rotation immediately, stop and split rotation into a separate PBI.
- If any route would return plaintext credentials, stop and redesign the API.

## Close-Out Checklist

- [ ] Credential table and migration added.
- [ ] Encryption/decryption helper implemented with WebCrypto.
- [ ] Authenticated owner-scoped credential routes added.
- [ ] Redacted response shapes implemented.
- [ ] Secret placeholders documented without real values.
- [ ] Tests prove encrypted-at-rest and no plaintext echo.
- [ ] `specs/ingestion/spec.md` DoD items for credentials updated with completion evidence.
- [ ] `pnpm check && pnpm typecheck && pnpm test` pass.
