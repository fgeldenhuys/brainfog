# PBI-006: Frontend Default UI

## Spec

`specs/frontend/spec.md`

## Goal

Implement the richer authenticated default web UI described in the frontend spec: data browser, rendered document reader, metrics dashboard, and user/token management.

## Scope

- Add the D1 schema/migration additions for `users.slug` and `users.is_admin`.
- Build the `/app` authenticated UI shell, browser, metrics, users, and document-reader screens using Hono JSX.
- Add progressive htmx enhancement only where it improves forms/filtering without requiring JavaScript for core flows.
- Add owner-scoped document browsing and rendered Markdown document views backed by R2 content.
- Add safe Markdown rendering for document content, with raw HTML and unsafe URLs made inert.
- Use the dependency graph from PBI-005 to show relationships/dependencies on detail and document pages where useful.
- Add UI service routes for summary, metrics, and admin user/token management.
- Add tests and e2e coverage required by the spec.

## Out Of Scope

- Public signup.
- Public unauthenticated pages.
- MCP-authored user pages and pre-authenticated page links; those are PBI-007.
- React/Vite/SPA routing.
- Arbitrary HTML or JavaScript execution from document content.
- A rich visual document editor.

## Acceptance Criteria

- All Definition Of Done items in `specs/frontend/spec.md` are satisfied.
- Regression guardrails in `specs/frontend/spec.md`, `specs/dependency-graph/spec.md`, `specs/platform-setup/spec.md`, and `specs/memory-model/spec.md` still hold.
- Verification includes `pnpm check && pnpm typecheck && pnpm test` and `pnpm test:e2e`.
