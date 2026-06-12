# ADR-004: Per-User Bearer Tokens For Auth

## Status

Accepted — 2026-06-12

## Context

Brainfog serves a small group of trusted users with no public signup (`VISION.md`). MCP clients, REST calls, and the web UI all need to identify which user's memories are being read or written, per `ARCHITECTURE.md` invariant 6.

## Decision

We will use per-user, admin-issued bearer tokens, stored hashed in D1. `/mcp` and `/api/v1/*` requests authenticate via `Authorization: Bearer <token>`. The web UI accepts the same token, entered once and stored in a cookie — there is no separate password or signup flow in v1.

## Consequences

**Positive**
- Simple to implement and reason about: no email/password flows or third-party identity provider.
- A token can be revoked by deleting or rotating its D1 row.
- Fits the "me + a few trusted people" scale described in `VISION.md`.

**Negative**
- Token issuance and rotation are manual, out-of-band processes — an admin generates and shares tokens.
- No self-service signup or password reset.
- A leaked token grants full access to that user's memories until revoked.

**Neutral**
- Tokens are scoped per-user, not per-project. Project-level scoping of memories is an application-layer concern for the memory model, not an auth concern.

## Alternatives Considered

- **Cloudflare Access / Zero Trust:** rejected for v1 because it adds an external policy/identity-provider configuration surface that is more than a handful of users need. Worth revisiting if the user group grows or SSO becomes desirable.
- **Third-party auth (e.g. Clerk, Auth0):** rejected because it adds an external vendor/account and a signup UX that brainfog's scale doesn't need.
- **Per-application API keys instead of per-user tokens:** rejected because memories need per-user provenance and scoping by default, which per-user tokens provide without extra modeling.
