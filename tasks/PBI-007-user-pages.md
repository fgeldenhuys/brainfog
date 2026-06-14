# PBI-007: User Pages

## Spec

`specs/user-pages/spec.md`

## Goal

Implement MCP-authored user pages: safe page definitions, owner-scoped data queries, rendering under `/:user_slug/:page_slug`, and narrow pre-authenticated access links.

## Scope

- Add the D1 schema/migration additions for `pages` and `page_access_links`.
- Add page-definition service logic shared by REST and MCP.
- Add the safe template/query renderer for dynamic pages.
- Add MCP tools and REST routes for page management and page access links.
- Add a basic page management UI surface for list/edit/preview/publish/archive/delete.
- Use the dependency graph from PBI-005 when page definitions need to depend on upstream brainfog objects.
- Add pre-authenticated page URLs that exchange an opaque URL secret for a page-scoped HTTP-only cookie.
- Add tests and e2e coverage required by the spec.

## Out Of Scope

- Public signup.
- Public unauthenticated pages.
- React/Vite/SPA routing.
- Arbitrary HTML, JavaScript, SQL, or third-party embed execution in dynamic pages.
- A rich visual page builder; textarea-backed editing is sufficient for v1.

## Acceptance Criteria

- All Definition Of Done items in `specs/user-pages/spec.md` are satisfied.
- Regression guardrails in `specs/user-pages/spec.md`, `specs/frontend/spec.md`, `specs/dependency-graph/spec.md`, `specs/platform-setup/spec.md`, and `specs/memory-model/spec.md` still hold.
- Verification includes `pnpm check && pnpm typecheck && pnpm test` and `pnpm test:e2e`.
