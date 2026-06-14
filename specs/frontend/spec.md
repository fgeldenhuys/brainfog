# Spec: Frontend Default UI

## Blueprint

### Context

Brainfog currently has a minimal server-rendered web UI: a bearer-token form at `/` and an authenticated confirmation page (`specs/platform-setup/spec.md`, ADR-007). The memory model and REST API already expose the core data that a richer human review surface needs (`specs/memory-model/spec.md`), but there is no product contract yet for browsing data, inspecting metrics, managing users, or reading stored documents in the browser.

This spec defines the default authenticated UI. The UI remains secondary to the agent interface: agents continue to write and recall memory through MCP, while humans use the web UI to review, curate, audit, manage users, and inspect the content agents wrote. MCP-authored user pages are intentionally split into `specs/user-pages/spec.md` and PBI-007 so PBI-006 can ship the default UI without also building a safe user-template system. This spec assumes the dependency graph from `specs/dependency-graph/spec.md` has already replaced the older one-off relationship tables.

Research summary: Hono JSX is already in use and is appropriate for server-rendered pages on Workers. htmx is a good fit for progressive enhancement because it is dependency-free, works by requesting HTML fragments, and does not require a frontend build pipeline. The default UI should stay server-rendered and should not become a separate SPA unless a future ADR supersedes ADR-007.

PBI-006 (`tasks/PBI-006-frontend-default-ui.md`) implements this spec after PBI-005 (`tasks/PBI-005-dependency-graph.md`).

### Architecture

- **Frontend Approach**:
  - Continue using Hono and `hono/jsx` for first-party pages, layouts, forms, tables, document views, and fragments.
  - Add htmx 2.x as an optional progressive-enhancement asset for filters, pagination, inline forms, and dashboard refreshes. Prefer vendoring the minified browser file under the Worker UI assets over adding a new frontend build step or loading from a CDN.
  - Do not add React, Vite, Next.js, Astro, Chart.js, or a client-side router in this spec. Server-render tables, cards, document pages, and small SVG/CSS charts are sufficient for v1.
  - All pages must work as normal HTML form/link flows without JavaScript; htmx improves the experience but must not be the only way to complete the core task.

- **Route Shape**:
  - `GET /` remains the login/token entry and redirects authenticated users to `/app`.
  - `POST /` keeps the existing token-entry flow, stores the token in the HTTP-only cookie, and then redirects or links to `/app`.
  - `GET /app` renders the authenticated default UI shell with navigation to Browser, Metrics, and Users.
  - `GET /app/browser` renders the data browser for memory tables.
  - `GET /app/browser/:kind` renders a table/list view for one kind: `projects`, `thoughts`, `facts`, `tasks`, `people`, `documents`, or `time-series-points`.
  - `GET /app/browser/:kind/:id` renders a detail page for one owned row, including provenance, project links, lifecycle fields, and related records where applicable.
  - `GET /app/documents/:id` renders a document reader page for one owned document. Markdown documents render as safe HTML; other supported text documents render as escaped plaintext.
  - `GET /app/documents/:id/raw` returns the raw document content from R2 for the authenticated owner, with a conservative text content type.
  - `GET /app/metrics` renders the dashboard.
  - `GET /app/users` renders user/token management for users authorized to manage users. Non-authorized users receive `403`.

- **Authentication And Authorization**:
  - All default UI routes remain behind the existing bearer-token/cookie authentication model (`ARCHITECTURE.md` invariant 6).
  - User management is admin-only. This spec does not change bearer-token verification semantics; it adds UI and service routes for managing known users and token records.
  - Token plaintext is only shown once at issuance. Stored token rows remain hashed, as in the platform baseline.

- **API Contracts**:
  - Existing REST list/create/update/delete routes from `specs/memory-model/spec.md` remain the data source for the default UI.
  - New UI-oriented REST routes live under `/api/v1/ui/*`, use the same bearer-token middleware, and return JSON for htmx-backed forms or server handlers:
    - `GET /api/v1/ui/summary` returns counts and recent activity for `thoughts`, `facts`, `tasks`, `documents`, `people`, `projects`, and `time_series_points` scoped to the authenticated user.
    - `GET /api/v1/ui/metrics?project_id?&from?&to?` returns dashboard data: entity counts, open task counts by status/priority, fact lifecycle counts, document/chunk counts, recallable row counts, and selected time-series rollups.
    - `GET /api/v1/ui/users`, `POST /api/v1/ui/users`, `PATCH /api/v1/ui/users/:id` support admin-only user management.
    - `POST /api/v1/ui/users/:id/tokens` creates a token for an existing user and returns plaintext exactly once.
    - `DELETE /api/v1/ui/tokens/:id` revokes a token.
  - No new MCP tools are added by this spec. MCP-authored pages are deferred to `specs/user-pages/spec.md`.

- **Data Models** (D1, via Drizzle):
  - **`users` additions**:
    - `slug` (unique, lowercase URL-safe text), `is_admin` (integer boolean, default `0`).
    - The first seeded/local owner may be marked admin by the seed script; there is still no public signup.
    - `slug` is included here because the default user-management UI needs a stable human-readable user handle before user pages are implemented.
  - No default-UI-only memory tables are added. Documents continue to use the existing `documents` D1 metadata table and R2 object content from `specs/memory-model/spec.md` and ADR-008.

- **Default UI Features**:
  - Data browser:
    - List all core tables with counts, filters, pagination, and direct links to row detail pages.
    - Show provenance fields (`source`, owner, project, created/updated timestamps) on every detail view.
    - Support create/edit/delete for records that already have REST write paths; destructive actions require confirmation and must preserve existing service-layer validation.
    - Provide recall search across thoughts, facts, and document chunks using the existing `GET /api/v1/recall` behavior.
  - Document browser and reader:
    - `/app/browser/documents` lists owned documents with title, project, MIME type, size, timestamps, chunk count where available, and links to open the rendered reader.
    - `/app/documents/:id` loads the document content from R2 through the existing owner-scoped document service.
    - Markdown documents (`text/markdown` and compatible Markdown text types) render to safe HTML in the server response.
    - Raw HTML embedded in Markdown is escaped or stripped; rendered Markdown must not allow scripts, event handlers, external active content, or unsafe URLs.
    - The reader includes document metadata, provenance, project, raw-content link, dependency graph links, stale dependency indicators, and links to chunks or recall results where useful.
    - Non-Markdown text content renders in a `<pre>` block with escaping.
  - Metrics dashboard:
    - Show memory totals, recent writes, recallable row counts, open task counts, fact lifecycle distribution, documents/chunks, and selected time-series trends.
    - Let the user filter by project and time range.
    - Use server-rendered HTML/SVG for charts in v1; do not add a charting dependency.
  - User management:
    - Admins can list users, create users, update names/slugs/admin flag, create tokens, see token metadata (`id`, `created_at`, `last_used_at`), and revoke tokens.
    - Non-admins can view their own identity and token metadata but cannot create users or tokens.

- **Markdown Rendering**:
  - Markdown is user/agent-authored content and must be treated as untrusted input.
  - Rendering must produce escaped/sanitized HTML. Raw HTML in the Markdown source is not trusted.
  - The renderer should support the useful subset: headings, paragraphs, emphasis, strong, inline code, fenced code blocks, blockquotes, ordered/unordered lists, links, horizontal rules, and tables if feasible.
  - Link URLs must allow only safe schemes (`https:`, `http:`, `mailto:`) or same-origin relative links. `javascript:` and data URLs are rejected or rendered as text.
  - A small Markdown parser dependency may be considered at implementation time, but adding a new top-level dependency still requires explicit approval under `AGENTS.md`. If no dependency is approved, implement a conservative in-repo subset renderer.

- **Dependencies**:
  - Runtime dependencies remain `hono`, `agents`, and `drizzle-orm` plus the existing project dependencies unless a Markdown parser is explicitly approved during implementation.
  - htmx is allowed as a vendored browser asset or static Worker asset, not as a new top-level npm dependency unless implementation explicitly asks and receives approval.
  - No new Cloudflare product or binding is required.

- **Constraints**:
  - D1 remains canonical for users, tokens, and all structured memory data.
  - R2 remains canonical for full document content; document views must read through the owner-scoped service layer, not directly bypass authorization.
  - UI routes must not bypass auth, owner scoping, provenance, or the memory service layer.
  - `/api/v1/*`, `/mcp`, and `/app/*` must not conflict.
  - Document reader pages should return `no-store` by default because rendered content is authenticated personal memory.

## Contract

### Definition Of Done

- [x] The web UI has a shared authenticated layout at `/app` with navigation to Browser, Metrics, and Users.
- [x] `/` still supports the existing token-entry flow and authenticated requests are redirected or linked to `/app`.
- [x] Data browser pages exist for `projects`, `thoughts`, `facts`, `tasks`, `people`, `documents`, and `time-series-points`, with owner-scoped lists, filters, pagination, and row detail pages.
- [x] Detail views display provenance and relevant relationships without leaking rows owned by another user.
- [x] `/app/browser/documents` shows owned documents with metadata and links to rendered document reader pages.
- [x] `/app/documents/:id` renders owned Markdown documents as safe HTML from R2 content, renders non-Markdown text as escaped plaintext, and shows dependency graph relationships/staleness for generated documents where present.
- [x] `/app/documents/:id/raw` returns raw document text only for the authenticated owner.
- [x] Markdown rendering escapes or strips raw HTML, event handlers, scripts, unsafe URLs, and active external content.
- [x] Recall search is available from the UI and uses the existing owner-scoped recall service.
- [x] Metrics dashboard renders entity counts, task status counts, fact status counts, document/chunk counts, recent activity, and selected time-series rollups, filterable by project/time range.
- [x] `users.slug` and `users.is_admin` are added by Drizzle migration, with reserved slug validation in the service layer.
- [x] Admin-only user management can list/create/update users, issue one-time plaintext tokens, and revoke tokens; non-admin requests receive `403`.
- [x] htmx-backed interactions degrade to normal HTML links/forms when JavaScript is unavailable.
- [x] `pnpm check && pnpm typecheck && pnpm test` pass, including coverage for auth/authorization, document rendering safety, owner-scoped document access, admin-only user management, and data-browser/metrics service outputs.
- [x] `pnpm test:e2e` covers login, navigating the data browser, opening a rendered Markdown document, viewing metrics, and user-management authorization behavior.

Completion evidence: PBI-006 implementation added the authenticated `/app` Hono JSX shell, data browser, recall search, metrics dashboard, safe document reader/raw routes backed by owner-scoped R2 document services, admin user/token management, UI service REST routes under `/api/v1/ui/*`, `users.slug`/`users.is_admin` schema migration and seed updates, vendored htmx asset serving, Markdown safety rendering, Worker-runtime UI/API tests, and Playwright coverage for login, browser navigation, Markdown rendering, metrics, and user-management authorization. Verified on 2026-06-14 with `pnpm check && pnpm typecheck && pnpm test` (97/97 tests passed; known post-success Vitest close-timeout warning) and `pnpm test:e2e` (1/1 passed, run twice consecutively after idempotent setup fix). Critic review initially found blocking issues around plaintext token URLs, token metadata/revocation UI, non-admin POST handling, and e2e repeatability; focused re-review confirmed all four were resolved with no new blocking issues.

### Regression Guardrails

- `GET /api/v1/health` remains unauthenticated; all other `/api/v1/*` routes remain authenticated.
- `/mcp` remains authenticated and continues to expose the memory-model tools and agent prompts unchanged.
- Existing memory-model REST/MCP behavior remains source-compatible; UI routes must use the same service layer rather than duplicating data-access rules.
- Document rendering must not execute arbitrary HTML or JavaScript from document content.
- The web UI must not store bearer tokens in localStorage; it continues to use the existing HTTP-only cookie flow for browsers.

### Scenarios

```gherkin
Feature: Frontend default UI

  Scenario: Viewing the authenticated app shell
    Given a user has submitted a valid bearer token through the web UI
    When they open /app
    Then they see navigation to Browser, Metrics, and Users

  Scenario: Browsing thoughts
    Given an authenticated user has thoughts in brainfog
    When they open /app/browser/thoughts
    Then they see only their own thoughts
    And each row links to a detail page with provenance

  Scenario: Browsing documents
    Given an authenticated user has documents in brainfog
    When they open /app/browser/documents
    Then they see only their own documents
    And each document links to a rendered reader page

  Scenario: Reading a Markdown document
    Given an authenticated user has a Markdown document in R2
    When they open /app/documents/:id
    Then the document content is rendered as safe HTML
    And document metadata and provenance are visible

  Scenario: Markdown rendering blocks unsafe content
    Given an authenticated user has a Markdown document containing a script tag and a javascript link
    When they open /app/documents/:id
    Then the unsafe content is escaped, stripped, or rendered inert

  Scenario: Viewing dashboard metrics
    Given an authenticated user has thoughts, facts, tasks, documents, and time-series points
    When they open /app/metrics
    Then they see owner-scoped counts and rollups
    And they can filter the dashboard by project and time range

  Scenario: Admin creates a user token
    Given an authenticated admin user
    When they create a token for an existing user from /app/users
    Then the plaintext token is shown exactly once
    And subsequent token lists show only token metadata

  Scenario: Non-admin cannot manage users
    Given an authenticated non-admin user
    When they open /app/users
    Then the response status is 403
```
