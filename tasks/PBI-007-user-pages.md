# PBI-007: User Pages

## Spec

`specs/user-pages/spec.md`

## Goal

Implement MCP-authored user pages: safe page definitions, owner-scoped data queries, rendering under `/:user_slug/:page_slug`, and narrow pre-authenticated access links.

User pages are authenticated, server-rendered dynamic views over brainfog data. They are not statically generated pages, public website pages, or a second source of truth.

## Dependencies

- `specs/user-pages/spec.md` is authoritative for this PBI.
- PBI-005 dependency graph has landed; page definitions that depend on upstream brainfog objects must use `dependency_edges` rather than one-off relationship storage.
- PBI-006 default frontend has landed; `users.slug`, `users.is_admin`, the `/app` UI shell, and `/api/v1/ui/*` route namespace already exist.
- PBI-008 global people pool has landed; `people` are globally visible authenticated records, while page data queries must still enforce the page-owner data boundary required by the user-pages spec.
- PBI-009/PBI-010 shared visibility has landed; many memory read paths now return `owner_id = caller OR shared = true`, but dynamic page rendering must use strict page-owner scoping unless `specs/user-pages/spec.md` is explicitly changed.
- PBI-011 OAuth has landed; `/mcp` accepts both static bearer tokens and OAuth access tokens, and `/authorize`, `/token`, `/register`, and `/.well-known/*` are active Worker routes that must not be shadowed by dynamic user-page routing.

## Scope

- Add the D1 schema/migration additions for `pages` and `page_access_links`.
- Add page-definition service logic shared by REST and MCP.
- Add the safe template/query renderer for dynamic pages.
- Add MCP tools and REST routes for page management and page access links.
- Add a basic page management UI surface for list/edit/preview/publish/archive/delete.
- Use the dependency graph from PBI-005 when page definitions need to depend on upstream brainfog objects.
- Add pre-authenticated page URLs that exchange an opaque URL secret for a page-scoped HTTP-only cookie.
- Update slug validation/reserved route handling so user slugs cannot collide with `/api`, `/mcp`, `/app`, `/assets`, `/authorize`, `/token`, `/register`, `/.well-known`, `/login`, `/logout`, or `/health`.
- Ensure page query execution does not accidentally inherit shared-visibility widening from PBI-009/PBI-010; rendered page data is scoped to the page owner and the exact page access credential.
- Preserve both MCP auth paths from PBI-011: page MCP tools must work for static bearer-token clients and OAuth-authenticated clients without changing tool semantics.
- Add tests and e2e coverage required by the spec.

## Out Of Scope

- Public signup.
- Public unauthenticated pages.
- Static site generation, build-time page publishing, CDN-published static artifacts, or public cacheable page output.
- React/Vite/SPA routing.
- Arbitrary HTML, JavaScript, SQL, or third-party embed execution in dynamic pages.
- A rich visual page builder; textarea-backed editing is sufficient for v1.

## Implementation Notes

- Use the existing Worker stack: Hono, `hono/jsx`, Drizzle, D1, R2-backed document services, Vectorize/Workers AI through the existing memory services, and the current MCP `agents`/`OAuthProvider` setup.
- Do not introduce React, Vite, Next.js, Astro, a client router, a static-site generator, or a template-execution dependency unless explicitly approved under `AGENTS.md`.
- Approved package direction for the safe template layer: use `mustache` for logic-less escaped rendering plus an HTML parser/validator such as `htmlparser2` or `parse5` for fail-closed tag/attribute validation.
- Avoid runtime template engines that evaluate JavaScript, rely on Node-only APIs, or require a browser DOM. User templates are untrusted input and must fail closed.

## Server-Side Display Logic

- Dynamic pages must not allow page-authored client-side JavaScript for transforming data. All display shaping happens server-side before Mustache rendering.
- Page `queries` return named datasets. After owner-scoped query execution, the page service maps raw rows into a bounded view model consumed by the template.
- Supported display transforms must be declarative and allowlisted in the query definition, not supplied as JavaScript functions or template helpers. Examples: formatted date labels, status/lifecycle labels, short/excerpt fields, safe `/app` detail links, row counts, and simple grouping by approved fields such as `status` or `project_id`.
- The first implementation should keep transforms small and explicit. If a requested transform is not allowlisted, validation fails with a clear error rather than evaluating arbitrary code.
- Validation must cover the query schema, display-transform options, referenced datasets, template syntax, allowed tags/attributes, and row limits before storing or rendering a page.
- Mustache templates render only the prepared view model, for example `{{#recent_tasks}}<a href="{{url}}">{{title}}</a> {{due_at_label}}{{/recent_tasks}}`; they must not call functions, execute JavaScript, run SQL, or fetch additional data from the browser.

## Acceptance Criteria

- All Definition Of Done items in `specs/user-pages/spec.md` are satisfied.
- Regression guardrails in `specs/user-pages/spec.md`, `specs/frontend/spec.md`, `specs/dependency-graph/spec.md`, `specs/platform-setup/spec.md`, `specs/memory-model/spec.md`, `specs/sharing/spec.md`, and `specs/claude-connector-oauth/spec.md` still hold.
- Dynamic page route tests prove reserved top-level routes still win over `/:user_slug/*`, including `/api/v1/health`, `/mcp`, `/app`, `/assets`, `/authorize`, `/token`, `/register`, and `/.well-known/*`.
- Dynamic page query tests prove another user's rows do not render through a page, including rows visible through `shared = true` read paths.
- Dynamic page display-logic tests prove allowed server-side transforms produce the expected view-model fields and disallowed transform/function inputs are rejected.
- MCP page-tool tests cover the static bearer-token path and preserve OAuth-authenticated `/mcp` behavior from PBI-011.
- Verification includes `pnpm check && pnpm typecheck && pnpm test` and `pnpm test:e2e`.

## Completion Evidence

Implemented in `packages/db/src/schema.ts`, `packages/db/migrations/0007_user_pages.sql`, `apps/worker/src/pages.ts`, `apps/worker/src/mcp/index.ts`, `apps/worker/src/routes/ui-api.ts`, `apps/worker/src/ui/index.tsx`, `apps/worker/src/ui/layout.tsx`, `apps/worker/e2e/global-setup.ts`, `apps/worker/e2e/user-pages.spec.ts`, `apps/worker/test/ui-pages.test.ts`, `apps/worker/test/oauth.test.ts`, `apps/worker/package.json`, and `pnpm-lock.yaml`.

- Added D1-backed `pages` and `page_access_links` with provenance, owner scoping, typed IDs (`g`/`a`), lifecycle fields, hashed access secrets, expiry/use-count/revocation fields, and indexes.
- Added a shared page service used by MCP, REST, UI, and dynamic rendering; page queries are validated JSON, enforce strict page-owner scoping, and intentionally do not inherit `shared = true` read widening.
- Added Mustache plus parse5 safe rendering. Templates are validated before storage/rendering, use escaped interpolation and Mustache sections, reject unsafe tags/attributes/raw interpolation, and fail closed for drafts and published pages.
- Added server-side display view-model shaping for date/status labels, excerpts, safe links, counts, and allowlisted grouping without page-authored client JavaScript.
- Added MCP tools for page CRUD/preview and access-link create/list/revoke, preserving static bearer-token and OAuth-authenticated `/mcp` behavior.
- Added REST routes under `/api/v1/ui/pages` and `/api/v1/ui/page-access-links`, plus a basic `/app/pages` UI for list/create/edit/preview/publish/archive/delete and access-link management.
- Added dynamic page routes for `/:user_slug/` and `/:user_slug/:page_slug`, with reserved-route protection for existing app/API/OAuth/static routes.
- Added pre-authenticated page URLs that store only hashed secrets, return plaintext URLs only at creation, exchange `?access=` for a page-scoped HTTP-only cookie, remove the visible secret by redirect, and do not authorize `/app`, `/api/v1/*`, `/mcp`, or other pages.

Final verification on 2026-06-17:

- `pnpm check && pnpm typecheck && pnpm test` passed; 145 Vitest tests passed. Vitest still emitted the existing post-success close-timeout warning.
- `pnpm test:e2e` passed; 3 Playwright tests passed.

Critic review found four blocking issues in the first pass: invalid draft definitions could be persisted, bad pre-auth access leaked page existence via `403`/`404`, MCP-created links used `https://example.com`, and MCP/access-link boundary coverage was insufficient. A focused fix pass rejected invalid definitions before storage, normalized invalid unauthenticated pre-auth attempts to generic `404`, switched MCP access-link output to relative URLs, and added MCP/static/OAuth/access-link expiry/use/revocation tests. Final critic confirmation reported no blocking issues.

## Ship-PBI Log

- Iteration 1: `pbi-implementor` implemented PBI-007 end-to-end, including schema/migration, service layer, Mustache/parse5 rendering, MCP/REST/UI/dynamic routes, pre-auth links, and tests. Reported green `pnpm install`, `pnpm check && pnpm typecheck && pnpm test`, and `pnpm test:e2e`.
- Deterministic gate after iteration 1: orchestrator ran `pnpm check && pnpm typecheck && pnpm test` successfully (143 tests) and `pnpm test:e2e` successfully (3 tests).
- Critic report 1: four blocking issues: invalid drafts could be stored, invalid pre-auth attempts leaked page existence by status, MCP access-link creation used `https://example.com`, and required MCP/access-link boundary coverage was missing.
- Fix pass 1: `planned-implementor` applied bounded fixes for all four blocking findings and reran focused tests plus full gates.
- Deterministic gate after fix pass 1: orchestrator ran `pnpm check && pnpm typecheck && pnpm test` successfully (145 tests) and `pnpm test:e2e` successfully (3 tests).
- Critic report 2: no blocking issues; ready for closeout.
