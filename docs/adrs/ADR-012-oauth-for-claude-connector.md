# ADR-012: OAuth 2.1 Authorization Server For claude.ai Custom Connector Support

## Status

Accepted — 2026-06-15

## Context

Brainfog's `/mcp` endpoint is protected by per-user bearer tokens issued out-of-band (ADR-004), validated against a hashed `tokens` table in D1, and attached to the Hono context as `ctx.props.user`. This model works well for Claude Code and OpenCode, which support static `Authorization: Bearer <token>` headers in their remote-MCP configuration.

Claude.ai's "Custom Connectors" feature (https://support.claude.com/en/articles/11503834-build-custom-connectors-via-remote-mcp-servers) does not support static bearer tokens (`static_bearer` is not yet supported per the MCP auth registry). It supports either:
1. Authless servers (not viable for brainfog — every tool call must resolve to a `user` per ARCHITECTURE.md invariant 6),
2. OAuth 2.1 with PKCE (MCP 2025-03-26 and 2025-06-18 auth specs), via Dynamic Client Registration (DCR) or Anthropic-held credentials.

Cloudflare publishes `@cloudflare/workers-oauth-provider` (v0.8.0, npm package, GitHub `cloudflare/workers-oauth-provider`), a TypeScript library that runs an OAuth 2.1 authorization server on Workers, backed by KV for grant/token/client storage. It integrates with the `agents` SDK's `McpAgent` and is the documented standard pattern for "remote MCP server with OAuth on Cloudflare Workers".

To support claude.ai without breaking existing Claude Code / OpenCode clients, we add an OAuth authorization layer in front of `/mcp`, additive to ADR-004. Static bearer tokens remain unchanged; OAuth tokens are a second, independent credential issuance path that eventually resolves to the same per-user identity.

## Decision

We will:

1. **Add an OAuth 2.1 authorization server** via `@cloudflare/workers-oauth-provider` and a new KV binding (`mcp_oauth`), exposed at `/authorize`, `/token`, and `.well-known/*` endpoints. The library handles DCR, Protected Resource Metadata (`.well-known/oauth-protected-resource`), and OAuth-protected-resource metadata (`.well-known/oauth-authorization-server`), per MCP's auth specs.

2. **Authenticate users via their existing ADR-004 bearer tokens.** The `/authorize` endpoint renders a form that accepts the bearer token as a POST body field (`application/x-www-form-urlencoded`, not a URL query parameter — credentials must not appear in URLs, browser history, or server access logs, consistent with the MCP auth spec's prohibition on tokens in connector URLs), validates it against the D1 `tokens` table using the same `authMiddleware` logic, and on success exchanges it for an OAuth `authorization_code`. The user never enters a password or signs up — they reuse their existing brainfog token.

3. **Resolve OAuth tokens to `ctx.props.user` before `/mcp` handlers execute.** The `/mcp` endpoint will branch: if the request carries an OAuth access token (validated by `@cloudflare/workers-oauth-provider`), the library populates `ctx.props` with the `user_id` stored in the token's metadata. If the request carries a static bearer token (ADR-004), the existing `authMiddleware` validates it and populates `ctx.props` as today. The `BrainfogMCP` service layer sees `ctx.props.user` either way.

4. **Store minimal user metadata in OAuth tokens.** When the authorization server exchanges an authorization code for an access token (per OAuth 2.1 PKCE), the `ctx.props` passed to `completeAuthorization()` will include the `user_id` (and name if needed). The `@cloudflare/workers-oauth-provider` library encrypts this payload with token material as the key and stores it in KV; on authenticated API requests, the library decrypts and repopulates `ctx.props`.

5. **Document the `/authorize` UX and KV schema** in the new `specs/claude-connector-oauth/spec.md` (Blueprint: API contract for `/authorize` with `?token=<bearer_token>` semantics, `.well-known/*` contracts, KV schema and lifecycle; Contract: DoD, Regression Guardrails ensuring ADR-004 paths remain unbroken, Gherkin scenarios for the OAuth flow).

## Consequences

**Positive**
- claude.ai Custom Connectors now work: users can paste their bearer token into a simple `/authorize` form, get OAuth tokens, and use brainfog as a custom connector without leaving the claude.ai UI.
- Zero new identity system or signup flow — reuses the existing per-user token and the "few trusted people" scale (VISION.md, ADR-004).
- Static bearer tokens remain unchanged; Claude Code, OpenCode, and REST clients continue to work without any refactor.
- A single service layer (memory, MCP tools) works for both credential types; `ctx.props.user` is populated identically.
- Leverage Cloudflare's reference implementation; no custom OAuth implementation.

**Negative**
- New KV binding and its schema are a deployment/operational surface to manage (migrations, key/TTL lifecycle).
- `@cloudflare/workers-oauth-provider` is still in v0.8.0 (pre-1.0); the MCP authorization extension is marked "experimental — the MCP extension is still a draft". Risk of API breakage or incomplete MCP spec alignment.
- Doubles the number of credential paths the `/mcp` endpoint must handle (OAuth + static bearer), increasing branching complexity and test surface.
- OAuth tokens have expiry and refresh semantics; the `@cloudflare/workers-oauth-provider` library handles the mechanics, but brainfog's logging/monitoring must track both token types.

**Neutral**
- The `/authorize` endpoint is part of the OAuth server, not the `/mcp` server — it lives outside the MCP protocol itself.
- Vectorize, Workers AI, and D1 are unchanged; only KV and the Worker routing layer are affected.

## Alternatives Considered

- **Require users to manually authenticate with an identity provider (Clerk, Auth0, etc.) and link their brainfog account:** rejected because it adds an external vendor and signup UX that contradicts VISION.md's "few trusted people, low friction" goal. OAuth 2.1 with PKCE, when user-initiated via a simple token-paste form, has near-zero friction compared to third-party account linking.
- **Authless `/mcp` with an optional OAuth layer for rate limiting / auditing:** rejected because every brainfog tool call must resolve to a `user` (ARCHITECTURE.md invariant 6, ADR-004). Anonymous access is not acceptable.
- **Store OAuth token metadata in D1 instead of KV:** rejected because KV is the natural fit for the OAuth library's use case (high-volume, short-lived grant/token storage with TTL support). D1 is better suited for canonical structured data. The user's *identity* (brainfog user, project, memory metadata) lives in D1; the OAuth *session tokens* live in KV.
- **Require OAuth for all clients (both static bearer tokens and claude.ai), phasing out ADR-004 tokens:** rejected because it breaks existing Claude Code / OpenCode integrations and adds friction to a setup that currently works well for a small trusted group. Additive OAuth is lower-risk.

## Open Questions and Risks

- **@cloudflare/workers-oauth-provider API stability:** The library is at v0.8.0, pre-1.0, and the "MCP Enterprise-Managed Authorization" extension is experimental. Integration details (exact function signatures for wrapping the fetch handler, the shape of `ctx.props` passed to `completeAuthorization()`, how to detect whether a request is OAuth-authenticated vs. static-bearer-authenticated) should be verified during spec / PBI-011 implementation. If the library's API shifts significantly, the PBI may uncover gaps that need a follow-up ADR.
- **KV quota and costs:** KV has per-operation costs and daily-write quota limits. An active OAuth flow (users authorizing, tokens expiring/refreshing) could accumulate writes. This should be estimated during implementation (PBI-011 will include a capacity/cost analysis in its Context or Verification).
- **OAuth token interception and leakage:** OAuth tokens in KV are encrypted with token material as the key, per the library's design. Static bearer tokens are hashed in D1. Both are lower-risk than plaintext, but the security boundary between KV and D1 should be documented in the spec and reviewed by anyone auditing brainfog's threat model.
