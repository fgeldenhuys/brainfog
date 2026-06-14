# Spec: User Pages

## Blueprint

### Context

The default UI in `specs/frontend/spec.md` gives humans a fixed browser, dashboard, user-management surface, and rendered document reader. This spec defines the later user-pages capability: an authenticated agent can define a custom web view through MCP, backed by safe server-rendered templates and owner-scoped queries over brainfog data. It builds on the dependency graph from `specs/dependency-graph/spec.md` for page definitions that need to declare upstream inputs.

The goal is to let a user ask an agent to create a page such as "daily review", "open loops", or "project field notes" and then open it under a stable `/:user_slug/:page_slug` path. These pages are dynamic views over existing brainfog data, not a public website feature and not a new source of truth.

PBI-007 (`tasks/PBI-007-user-pages.md`) implements this spec after PBI-006.

### Architecture

- **Route Shape**:
  - `GET /:user_slug/` renders the authenticated user's dynamic-page index for that slug.
  - `GET /:user_slug/:page_slug` renders a dynamic page definition owned by the user identified by `user_slug`.
  - Reserved top-level path segments are not valid user slugs: `api`, `mcp`, `app`, `assets`, `login`, `logout`, and `health`.

- **Authentication And Authorization**:
  - User pages remain behind the existing bearer-token/cookie authentication model (`ARCHITECTURE.md` invariant 6). They are not public in this spec.
  - A request for `/:user_slug/...` must authenticate as the same user identified by `user_slug` or present a valid pre-authenticated access credential for that exact page.
  - Agents can create pre-authenticated page URLs over MCP. These are capability links for a specific user/page, not general bearer tokens and not a replacement for the existing MCP/REST bearer-token model.
  - A pre-authenticated URL contains an opaque one-time secret in a query parameter. The first valid request exchanges it for an HTTP-only, same-site, page-scoped cookie and redirects to the same clean path without the secret in the URL.
  - Pre-authenticated URL secrets are hashed in D1, expire by default, can be limited by use count, and can be revoked. They authorize only the named page definition and its owner-scoped query results.

- **API Contracts**:
  - REST routes under `/api/v1/ui/*`, all authenticated and owner-scoped:
    - `GET /api/v1/ui/pages`, `GET /api/v1/ui/pages/:id`, `POST /api/v1/ui/pages`, `PATCH /api/v1/ui/pages/:id`, and `DELETE /api/v1/ui/pages/:id` manage dynamic page definitions.
    - `POST /api/v1/ui/pages/:id/preview` validates and renders a page definition without publishing it.
    - `POST /api/v1/ui/pages/:id/access-links` creates a pre-authenticated page URL for the authenticated page owner, with optional `expires_at`, `max_uses`, and `label`.
    - `GET /api/v1/ui/pages/:id/access-links` lists access-link metadata for a page, never plaintext secrets.
    - `DELETE /api/v1/ui/page-access-links/:id` revokes an access link.
  - MCP tools exposed under `/mcp`, all authenticated and owner-scoped:
    - `create_page(title, slug, template, queries, description?, status?)` creates a dynamic page definition.
    - `update_page(id, title?, slug?, template?, queries?, description?, status?)` updates a dynamic page definition and refreshes validation metadata.
    - `list_pages(status?)` lists page definitions for the authenticated user.
    - `get_page(id)` returns the page definition and validation status.
    - `preview_page(template, queries)` validates and renders a non-persisted preview for the authenticated user.
    - `create_page_access_link(page_id, expires_at?, ttl_seconds?, max_uses?, label?)` creates a pre-authenticated URL for a single page and returns the plaintext URL exactly once.
    - `list_page_access_links(page_id)` lists access-link metadata for a page without returning secrets.
    - `revoke_page_access_link(id)` revokes an access link.

- **Data Models** (D1, via Drizzle; all app-generated IDs follow the memory-model ID convention, adding suffix `g` for page definitions and `a` for page access links):
  - This spec depends on `users.slug` from `specs/frontend/spec.md`.
  - **`pages`**:
    - `id` (pk), `owner_id` (fk -> `users.id`), `source`, `slug`, `title`, `description` (nullable), `status` (`draft | published | archived`, default `draft`), `template`, `queries` (JSON), `validation_errors` (JSON array of strings, default `[]`), `created_at`, `updated_at`.
    - `UNIQUE (owner_id, slug)`.
    - Indexes: `pages(owner_id, status)`, `pages(owner_id, slug)`.
  - **`page_access_links`**:
    - `id` (pk), `owner_id` (fk -> `users.id`), `page_id` (fk -> `pages.id`, `ON DELETE CASCADE`), `source`, `label` (nullable), `secret_hash` (unique), `expires_at` (timestamp), `max_uses` (nullable integer), `use_count` (integer, default `0`), `last_used_at` (nullable timestamp), `revoked_at` (nullable timestamp), `created_at`, `updated_at`.
    - Indexes: `page_access_links(owner_id, page_id)`, `page_access_links(secret_hash)`, `page_access_links(expires_at)`.

- **Dynamic Page Definition**:
  - `template` is an HTML-like server-rendered template, not arbitrary HTML execution. It supports a small allowlist of structural tags (`section`, `article`, `header`, `footer`, `h1`-`h4`, `p`, `ul`, `ol`, `li`, `table`, `thead`, `tbody`, `tr`, `th`, `td`, `dl`, `dt`, `dd`, `blockquote`, `code`, `pre`, `strong`, `em`, `small`, `a`, `time`, `div`, `span`) and safe attributes (`class`, `href` for same-origin or `https:`, `title`, `datetime`, `data-*`).
  - Disallowed in stored templates: `script`, inline event handlers, `style` attributes, arbitrary `hx-*` attributes, external resources, forms that submit to arbitrary routes, raw SQL, and unescaped output.
  - Template variables use escaped interpolation by default: `{{field}}`. Raw interpolation is not supported in v1.
  - Iteration uses named datasets from `queries`, for example `{{#each recent_thoughts}} ... {{content}} ... {{/each}}`.
  - Conditional rendering is limited to existence checks, for example `{{#if project_name}} ... {{/if}}`.
  - The renderer must fail closed: an invalid template or query definition returns a validation error and never partially executes unsafe content.

- **Dynamic Page Queries**:
  - `queries` is JSON, validated by the service layer, with named datasets. It never accepts SQL.
  - Allowed `kind` values: `thoughts`, `facts`, `tasks`, `people`, `projects`, `documents`, `document_chunks`, `time_series_points`, and `recall`.
  - Allowed filters are explicit per kind: `project_id`, `status`, `type`, `series_key`, `subject_type`, `subject_id`, `from`, `to`, `q`, and simple text search where the existing service layer supports it.
  - Allowed sort fields are explicit per kind and default to newest-first where timestamps exist.
  - `limit` is required or defaults to `25`; the service enforces a hard maximum of `100` rows per dataset.
  - All query execution uses the same owner-scoped service layer as MCP and REST. A page definition cannot read another user's rows, even if its stored JSON names another user's IDs.

- **Pre-Authenticated Page URLs**:
  - Generated URLs have the shape `/:user_slug/:page_slug?access=<opaque_secret>`.
  - The opaque secret is generated with the same cryptographic standard as bearer tokens, shown only once, and stored only as a hash derived with `BRAINFOG_TOKEN_HASH_SECRET` or a successor secret if a future ADR introduces one.
  - On request, the Worker validates the secret hash, page ownership, page status, expiry, revocation, and use count. Invalid links return `404` or a generic `403` without revealing whether the page exists.
  - On success, the Worker increments `use_count`, updates `last_used_at`, sets a page-scoped HTTP-only cookie, and redirects to `/:user_slug/:page_slug` without the `access` query parameter.
  - Page access cookies authorize only that page route and expire no later than the access link. They do not authorize `/app`, `/api/v1/*`, `/mcp`, other pages, or user management.
  - Default expiry is 24 hours when neither `expires_at` nor `ttl_seconds` is supplied. `max_uses` defaults to `1` unless explicitly set higher.

- **Dependencies**:
  - Runtime dependencies remain `hono`, `agents`, and `drizzle-orm` plus the existing project dependencies.
  - No new Cloudflare product or binding is required.

- **Constraints**:
  - D1 remains canonical for pages, access links, and all structured memory data.
  - Dynamic pages are views over D1/R2/Vectorize-backed service results; they do not become a new memory source of truth.
  - Page rendering must not bypass auth, owner scoping, provenance, or the memory service layer.
  - Pre-authenticated page URLs are credentials. They must be short-lived by default, revocable, logged only as metadata, and never displayed again after creation.
  - User-authored templates are untrusted input. They must be parsed/validated and rendered with escaping; `dangerouslySetInnerHTML` may only receive output from the trusted template renderer after validation/sanitization.
  - `/api/v1/*`, `/mcp`, `/app/*`, and `/:user_slug/*` must not conflict; reserved slugs are rejected at user creation/update time.
  - Dynamic pages should return `no-store` by default because rendered content is authenticated personal memory.

## Contract

### Definition Of Done

- [ ] `pages` table exists with owner-scoped slug uniqueness, status lifecycle, template text, query JSON, validation errors, provenance, and timestamps.
- [ ] `page_access_links` table exists with hashed secrets, page ownership, expiry, optional max-use count, use count, revocation, provenance, and timestamps.
- [ ] MCP tools `create_page`, `update_page`, `list_pages`, `get_page`, and `preview_page` exist and are authenticated/owner-scoped.
- [ ] MCP tools `create_page_access_link`, `list_page_access_links`, and `revoke_page_access_link` exist; plaintext access URLs are returned only at creation time.
- [ ] REST page-management routes under `/api/v1/ui/pages` exist and call the same service layer as the MCP page tools.
- [ ] REST access-link routes under `/api/v1/ui/pages/:id/access-links` and `/api/v1/ui/page-access-links/:id` exist and call the same service layer as the MCP access-link tools.
- [ ] Users can list, create, edit, preview, publish/archive, and delete their own page definitions from a basic UI surface.
- [ ] Dynamic pages render at `/:user_slug/:page_slug` for the authenticated matching user and return `404` or `403` without revealing whether another user's page exists.
- [ ] Dynamic pages can also render through a valid pre-authenticated URL for that exact page; the URL secret is exchanged for a page-scoped HTTP-only cookie and removed from the visible URL via redirect.
- [ ] The template renderer validates the allowed tag/attribute subset, escapes all data interpolation, rejects disallowed constructs, and fails closed with validation errors.
- [ ] Dynamic page queries accept only validated JSON definitions, never SQL, and enforce owner scope plus per-dataset row limits.
- [ ] `pnpm check && pnpm typecheck && pnpm test` pass, including coverage for page validation, unsafe template rejection, owner-scoped dynamic rendering, access-link expiry/use/revocation, and pre-auth scope boundaries.
- [ ] `pnpm test:e2e` covers creating or seeding a page, rendering a published dynamic page under `/:user_slug/:page_slug`, and using a pre-authenticated page URL.

### Regression Guardrails

- `GET /api/v1/health` remains unauthenticated; all other `/api/v1/*` routes remain authenticated.
- `/mcp` remains authenticated and continues to expose the memory-model tools and agent prompts unchanged except for the additive page tools in this spec.
- Existing memory-model REST/MCP behavior remains source-compatible; page routes must use the same service layer rather than duplicating data-access rules.
- No dynamic page route may execute arbitrary JavaScript, arbitrary HTML, arbitrary SQL, or cross-user data access.
- Pre-authenticated page URLs must not authorize REST, MCP, `/app`, other dynamic pages, or user management.
- The web UI must not store bearer tokens in localStorage; it continues to use the existing HTTP-only cookie flow for browsers.

### Scenarios

```gherkin
Feature: User pages

  Scenario: Agent creates a dynamic page
    Given an authenticated MCP client
    When it calls create_page with a slug, template, and queries over recent thoughts
    Then a page definition is stored in D1 for that user
    And the page can be previewed without publishing

  Scenario: Dynamic page renders under the user path
    Given an authenticated user with slug "francois"
    And they have a published page with slug "daily-review"
    When they open /francois/daily-review
    Then the page renders from the stored template and owner-scoped query results

  Scenario: Agent creates a pre-authenticated page URL
    Given an authenticated MCP client owns a published page
    When it calls create_page_access_link with a ttl_seconds value and max_uses 1
    Then the tool returns a URL containing an opaque access secret
    And D1 stores only a hash of the secret

  Scenario: Pre-authenticated URL exchanges secret for page cookie
    Given a valid pre-authenticated URL for /francois/daily-review
    When a browser opens the URL
    Then the Worker validates the access secret
    And redirects to /francois/daily-review without the secret query parameter
    And sets a page-scoped HTTP-only cookie

  Scenario: Pre-authenticated page access is narrow
    Given a browser has a valid page access cookie for /francois/daily-review
    When it opens /app or /api/v1/whoami without a bearer-token session
    Then the request is rejected

  Scenario: Dynamic page rejects unsafe template content
    Given an authenticated MCP client
    When it tries to create a page containing a script tag or inline event handler
    Then the page is rejected with validation errors
    And no unsafe content is rendered

  Scenario: Dynamic page cannot read another user's rows
    Given two users have separate thoughts
    When one user's page query names the other user's thought id
    Then rendering the page does not include the other user's thought
```
