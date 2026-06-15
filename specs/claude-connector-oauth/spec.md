# Spec: OAuth 2.1 Authorization Server For claude.ai Custom Connector

## Blueprint

### Context

Brainfog's `/mcp` endpoint is protected by per-user bearer tokens (ADR-004), which work well for Claude Code and OpenCode. Claude.ai's "Custom Connectors" feature requires OAuth 2.1 with PKCE (MCP 2025-03-26 and 2025-06-18 auth specs) and does not support static bearer tokens.

To enable claude.ai users to connect brainfog as a custom connector without adding a new identity/signup system, ADR-012 commits to adding an OAuth 2.1 authorization server (`@cloudflare/workers-oauth-provider`) in front of `/mcp`, accessible via three new endpoints: `/authorize` (user-facing token-exchange), `/token` (OAuth token endpoint), and `.well-known/*` (OAuth metadata). The OAuth server stores grants and tokens in a new KV binding (`mcp_oauth`); the service layer (MCP tools, memory operations) remains unchanged and works for both static bearer tokens and OAuth tokens.

**Related:**
- `VISION.md` "few trusted people, low friction" — no new signup flow, reuse existing bearer tokens.
- `ARCHITECTURE.md` invariants 1 (Cloudflare-only, new KV binding), 6 (per-user auth, two credential paths), and the system-shape diagram.
- `ADR-004` (static bearer tokens, D1 storage and validation).
- `ADR-012` (OAuth 2.1 server decision, authentication via existing bearer token at `/authorize`, OAuth-to-user resolution).

### Architecture

- **API Contracts:**

  - `GET /authorize` — Renders the OAuth consent/login form (no credentials in the request). `POST /authorize` — Accepts a brainfog bearer token (from ADR-004) as a POST body field (`application/x-www-form-urlencoded` or `application/json`), never as a URL query parameter (credentials must not appear in URLs, browser history, or server access logs — consistent with the MCP auth spec's prohibition on tokens in connector URLs). Validates the token against the D1 `tokens` table using the same middleware as ADR-004. On success, the OAuth server returns an `authorization_code` (per RFC 6749 PKCE extension) for the client (claude.ai or a local OAuth client for testing) to exchange at `/token`. On validation failure, returns `401 Unauthorized`.

  - `POST /token` — OAuth 2.1 token endpoint (RFC 6749). Accepts `grant_type=authorization_code` with `code`, `code_verifier`, and `client_id`. Issues `access_token` (short-lived, default TTL per `@cloudflare/workers-oauth-provider`'s config), `refresh_token`, and token metadata (expires_in, token_type: Bearer). The access token's metadata (stored in KV by the OAuth library) includes the resolved brainfog `user_id`, which is decrypted and passed to `/mcp` handlers as `ctx.props.user`.

  - `.well-known/oauth-protected-resource` — Per MCP 2025 auth spec, exposes the authorization server URI and supported grant types. Returned by the OAuth library; brainfog configures which endpoints are "protected resources" (i.e., require OAuth authentication). `/mcp` is marked as a protected resource; `/api/v1/health` is not.

  - `.well-known/oauth-authorization-server` — Per RFC 8414, exposes OAuth server metadata (issuer, authorization_endpoint, token_endpoint, supported grant types, etc.). Generated and returned by `@cloudflare/workers-oauth-provider`.

  - `/mcp` (updated) — Existing MCP endpoint (ADR-003) now handles two credential types: (a) static bearer tokens (existing `authMiddleware` path, ADR-004), and (b) OAuth access tokens (validated by the OAuth server via KV, returns 401 if invalid). Both paths resolve `ctx.props.user` from D1 before `BrainfogMCP` tools execute. Tools see no difference between the two sources.

- **Data Models:**

  - **KV namespace `mcp_oauth`** — New Cloudflare KV binding. Stores:
    - **Grant storage** — `oauth:grant:<grant_id>` → encrypted JSON blob with `user_id`, `client_id`, `auth_code`, creation timestamp, expiry (TTL: 10 minutes, per OAuth spec).
    - **Access token storage** — `oauth:token:<token_hash>` → encrypted JSON blob with `user_id`, scope, creation timestamp, expiry (TTL: configurable, default 1 hour).
    - **Refresh token storage** — `oauth:refresh:<token_hash>` → encrypted JSON blob with `user_id`, `client_id`, creation timestamp, expiry (TTL: 90 days or per config).
    - **Client registration** — `oauth:client:<client_id>` → encrypted client metadata (redirect_uris, client_secret, etc.), populated via Dynamic Client Registration (DCR) endpoint or Anthropic-provided credentials. The spec does not require brainfog to expose a client registration UI; clients are either registered out-of-band or via Anthropic's hosting (if brainfog is listed as an approved connector).
    - **Session state (if needed)** — `oauth:session:<session_id>` → temporary state for the authorization code flow.

  - **D1 `tokens` table** (unchanged by this spec) — still holds brainfog's canonical user identity and static bearer tokens (ADR-004, `specs/platform-setup/spec.md`). No schema changes.

  - **D1 `users` table** (unchanged) — still canonical for user identity, name, roles. Accessed by the OAuth server via the same service layer that validates static bearer tokens.

  - No new D1 columns required. Provenance (ADR-011, ARCHITECTURE.md invariant 4) is unchanged; all memory writes still require `user_id` from either token path.

- **Dependencies:**

  - New package: `@cloudflare/workers-oauth-provider` (npm, v0.8.0 or later). Provides `OAuthProvider` and `OAuthServer` classes that wrap the Worker fetch handler, route OAuth endpoints, and manage KV-backed grant/token storage.
  - New Wrangler binding: `mcp_oauth` (KV namespace), declared in `wrangler.toml`.
  - No changes to existing bindings (D1, Vectorize, Workers AI, R2); KV is additive.

- **Constraints:**

  - Cloudflare is the sole deployment surface; KV is the only supported session/token storage backend (ARCHITECTURE.md invariant 1, ADR-012).
  - D1 is still canonical for user identity; KV is ephemeral, backed by D1 for the "source of truth" user record (ARCHITECTURE.md invariant 2).
  - `/authorize` authenticates via existing bearer tokens only — it does not create new users, does not accept passwords, and does not link external identity providers (VISION.md "few trusted people", ADR-004, ADR-012).
  - Both static bearer tokens and OAuth access tokens must resolve to the same per-user `ctx.props.user` before MCP/REST handlers execute, with identical service-layer behavior (ARCHITECTURE.md invariant 5).
  - `/api/v1/health` remains unauthenticated; all other `/api/v1/*` routes and `/mcp` remain protected (ADR-004, `specs/platform-setup/spec.md` Regression Guardrails).
  - OAuth tokens are time-limited (not indefinite like bearer tokens); refresh tokens are issued with a longer TTL to allow credential rotation. Implementation must document TTLs and provide admin controls to adjust them (TBD in PBI-011 context).

## Contract

### Definition Of Done

- [x] `@cloudflare/workers-oauth-provider` is added to `apps/worker/package.json`; `wrangler.toml` declares the `mcp_oauth` KV binding. *(Deviation: binding is named `OAUTH_KV`, not `mcp_oauth`/`BRAINFOG_MCP_OAUTH_KV` — see "Documented Deviations" in PBI-011's Completion Evidence. `apps/worker/wrangler.jsonc` `kv_namespaces` + `apps/worker/package.json` dependency.)*
- [x] `POST /authorize` endpoint accepts bearer tokens via the request body (never a URL query parameter), validates against D1 `tokens` table, and returns OAuth `authorization_code` on success or `401` on failure. Supports both `application/x-www-form-urlencoded` and `application/json`. (`apps/worker/src/oauth/index.ts` `handleAuthorizePost`; `apps/worker/test/oauth.test.ts` "POST /authorize validation" + "Full OAuth happy-path flow".)
- [x] `POST /token` endpoint accepts `grant_type=authorization_code`, `code`, `code_verifier`, `client_id`, and returns `{ access_token, refresh_token, expires_in, token_type }` per RFC 6749. KV stores encrypted token metadata. (Library-managed `/token`, exercised by `apps/worker/test/oauth.test.ts` "Full OAuth happy-path flow" and "Refresh token flow".)
- [x] `.well-known/oauth-protected-resource` is reachable and exposes authorization server URI, `/mcp` as a protected resource, and supported grant types. (`apps/worker/test/oauth.test.ts` ".well-known endpoints" + ".well-known/oauth-protected-resource" → `/.well-known/oauth-protected-resource/mcp` lists `/mcp` in `resource`.)
- [x] `.well-known/oauth-authorization-server` is reachable and exposes RFC 8414 metadata (issuer, authorization_endpoint, token_endpoint, token_endpoint_auth_method, supported grant types, etc.). (`apps/worker/test/oauth.test.ts` "GET /.well-known/oauth-authorization-server returns RFC 8414 metadata".)
- [x] `/mcp` endpoint detects and validates OAuth access tokens (via the `@cloudflare/workers-oauth-provider` library's middleware/wrapping), extracts `user_id` from KV token metadata, and populates `ctx.props.user` before handlers execute — identical to the static bearer token path. (`apps/worker/src/index.ts` `apiRoute: "/mcp"`; `apps/worker/test/oauth.test.ts` "Full OAuth happy-path flow" calls `whoami` via the OAuth access token and asserts the resolved user matches the grant.)
- [x] `/mcp` endpoint continues to accept and validate static bearer tokens (ADR-004) via the existing `authMiddleware`-derived lookup (`resolveExternalToken` → `lookupAuthenticatedUser`), with no behavioral change, including `last_used_at` tracking. (`apps/worker/test/oauth.test.ts` "Regression: static bearer token paths still work".)
- [x] `BrainfogMCP` tools and `memory` service layer require no changes; they receive `ctx.props.user` and function identically regardless of token source. (No changes to `apps/worker/src/mcp/index.ts` or `apps/worker/src/memory.ts` — confirmed via `git diff main`.)
- [x] Unit tests cover: (a) `/authorize` with valid and invalid bearer tokens, (b) `/token` with valid and invalid authorization codes, (c) `/mcp` with both static bearer tokens and OAuth access tokens, (d) token expiry and refresh flow, (e) KV grant/token storage and cleanup (TTL expiry). (`apps/worker/test/oauth.test.ts`, 23 tests; see PBI-011 Completion Evidence for the expiry/refresh limitation note.)
- [x] Playwright E2E test covers the full OAuth flow: paste bearer token at `/authorize`, receive authorization code, exchange code at `/token`, connect an MCP client with the resulting access token, execute a brainfog tool (`ping` or similar), and verify successful execution. (`apps/worker/e2e/oauth.spec.ts`.)
- [x] `.well-known` endpoints are unauthenticated and return the correct JSON per RFC 8414 and MCP 2025-03-26 / 2025-06-18 auth spec. (`apps/worker/test/oauth.test.ts` ".well-known endpoints are unauthenticated".)
- [x] `pnpm check`, `pnpm typecheck`, `pnpm build`, and `pnpm test` all pass with no errors or warnings. (See PBI-011 Completion Evidence for command output.)
- [x] The new KV binding is documented in `.dev.vars.example` (with placeholder name `BRAINFOG_MCP_OAUTH_KV`); the Wrangler config binds it correctly in both local (Miniflare) and production environments. *(Deviation: documented as `OAUTH_KV` — a real `wrangler.jsonc` `kv_namespaces` binding, not a `.dev.vars` placeholder — `apps/worker/.dev.vars.example`.)*

### Regression Guardrails

- **Existing `/api/v1/*` routes (except `/api/v1/health`) and `/mcp` must remain protected by bearer-token auth.** Static bearer tokens (ADR-004) must continue to work without any change to the client's request format (`Authorization: Bearer <token>`). Existing Vitest middleware tests (from `specs/platform-setup`) must pass; any new OAuth-specific tests must not break the static-bearer-path tests.

- **`/api/v1/health` remains unauthenticated.** The OAuth server must not intercept or require authentication for this health-check endpoint.

- **D1 `tokens` table and its hashing/validation logic are unchanged.** The `/authorize` endpoint uses the existing `hashToken` and D1 lookup; no changes to how bearer tokens are stored, hashed, or validated are required by this spec.

- **`BrainfogMCP` tools and `memory` service layer see no changes.** All changes are at the Worker routing / auth-branching layer. Tools continue to receive `ctx.props.user` and call service methods identically.

- **Provenance (ADR-011, ARCHITECTURE.md invariant 4) is unchanged.** Every memory write carries source, user_id, project, and timestamps; the source of `user_id` (static bearer token or OAuth) is transparent to the service layer.

- **Vectorize metadata filters remain unaffected.** The `recall` service continues to use `owner_id` and `shared` fields; no new filter columns are required.

- **No existing REST or MCP client needs to change its configuration.** Claude Code, OpenCode, and REST API consumers continue to use static bearer tokens; they must never receive a `401 Unauthorized` or redirect to `/authorize`.

### Scenarios

```gherkin
Feature: OAuth 2.1 authorization for claude.ai custom connector

  Scenario: User exchanges a bearer token for an authorization code
    Given a user with a valid bearer token exists in D1
    When a client POSTs to /authorize with token=<bearer_token> in the request body
    Then the response status is 200
    And the response body contains an authorization_code
    And the code is stored in KV with the user_id and a 10-minute expiry
    And the token does not appear in the request URL or any redirect Location header

  Scenario: Authorization endpoint rejects invalid bearer tokens
    Given the brainfog Worker is running
    When a client POSTs to /authorize with token=<invalid_token> in the request body
    Then the response status is 401
    And no authorization_code is returned

  Scenario: Client exchanges authorization code for access token
    Given a valid authorization_code from /authorize
    When a client POSTs to /token with grant_type=authorization_code, code=<auth_code>, code_verifier, client_id
    Then the response status is 200
    And the response body contains access_token, refresh_token, expires_in, token_type
    And the access token and refresh token are stored in KV with encrypted user_id metadata

  Scenario: Token endpoint rejects invalid authorization codes
    Given the brainfog Worker is running
    When a client POSTs to /token with an invalid or expired authorization_code
    Then the response status is 400
    And an error_code (e.g., invalid_grant) is returned
    And no access_token is issued

  Scenario: MCP endpoint accepts OAuth access token
    Given a valid access_token from /token
    When an MCP client connects to /mcp and sends a request with Authorization: Bearer <access_token>
    Then the request is authenticated as the user associated with the token
    And BrainfogMCP tools can be invoked normally
    And ctx.props.user is populated with the user_id and name

  Scenario: MCP endpoint continues to accept static bearer tokens
    Given a valid static bearer token from ADR-004
    When an MCP client connects to /mcp and sends a request with Authorization: Bearer <static_token>
    Then the request is authenticated as the user associated with the token
    And BrainfogMCP tools can be invoked normally
    And ctx.props.user is populated with the user_id and name
    And no change to the client's configuration or request format is required

  Scenario: .well-known/oauth-protected-resource exposes MCP as protected
    Given the brainfog Worker is running
    When a client GETs /.well-known/oauth-protected-resource
    Then the response status is 200
    And the response body lists /mcp as a protected resource
    And the response body indicates the authorization server URI

  Scenario: .well-known/oauth-authorization-server returns RFC 8414 metadata
    Given the brainfog Worker is running
    When a client GETs /.well-known/oauth-authorization-server
    Then the response status is 200
    And the response body contains issuer, authorization_endpoint, token_endpoint, etc.
    And the response body matches RFC 8414 format

  Scenario: OAuth access token expires and refresh token can be used
    Given an expired access_token
    When an MCP client sends a request with the expired access_token
    Then the response status is 401 Unauthorized
    When the client exchanges the refresh_token at /token with grant_type=refresh_token
    Then a new access_token is issued
    And the new token can be used to authenticate subsequent /mcp requests

  Scenario: KV grant storage cleans up after authorization code is used
    Given an authorization_code in KV with a 10-minute TTL
    When the code is exchanged at /token and a token is issued
    Then the authorization_code KV entry is either deleted or marked consumed (to prevent reuse)
    And a subsequent request with the same code is rejected with invalid_grant

  Scenario: Static bearer token and OAuth token can coexist for the same user
    Given a user who has both a static bearer token (ADR-004) and an active OAuth access token
    When two separate clients use each token to authenticate to /mcp
    Then both clients are authenticated as the same user
    And both can execute tools and see the same memories (per owner_id)
    And provenance records the tool source (e.g., from Claude Code vs. claude.ai) but the user_id is identical
```
