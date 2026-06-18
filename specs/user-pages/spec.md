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
  - Reserved top-level path segments are not valid user slugs: `api`, `mcp`, `app`, `assets`, `authorize`, `token`, `register`, `.well-known`, `login`, `logout`, and `health`.

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
  - Iteration uses Mustache-style sections over named datasets from `queries`, for example `{{#recent_thoughts}} ... {{content}} ... {{/recent_thoughts}}`.
  - Conditional rendering is limited to Mustache-style truthy sections, for example `{{#project_name}} ... {{project_name}} ... {{/project_name}}`, and inverted sections for empty states, for example `{{^recent_thoughts}}No recent thoughts.{{/recent_thoughts}}`.
  - Display-specific shaping happens server-side before rendering: query results may be mapped into a bounded view model with derived display fields such as formatted dates, short labels, status labels, counts, and grouped arrays. Page-authored client-side JavaScript is not allowed for transforming data in v1.
  - The renderer must fail closed: an invalid template or query definition returns a validation error and never partially executes unsafe content.

- **Dynamic Page Queries**:
  - `queries` is JSON, validated by the service layer, with named datasets. It never accepts SQL.
  - Allowed `kind` values: `thoughts`, `facts`, `tasks`, `people`, `projects`, `documents`, `document_chunks`, `time_series_points`, and `recall`.
  - Allowed transforms: `date_labels`, `status_labels`, `excerpts`, `app_links`, `count`, `pivot_by_date`, and `pivot_by_year`. The `pivot_by_date` and `pivot_by_year` transforms are only meaningful for `time_series_points` queries and are silently ignored for other kinds. When `pivot_by_date` is applied it groups rows by `observedAt` calendar date (YYYY-MM-DD bucket) into one row per date; numeric series values are exposed as fields named by the suffix after the first dot in `seriesKey` (e.g. `electricity.cost_per_unit` → field `cost_per_unit`); `metadata.notes` is merged across the group (first non-empty wins); the pre-pivot DB query fetches up to `limit × 20` raw rows (hard cap 500) and `limit` is applied to the post-pivot row count. When `pivot_by_year` is applied it groups rows by calendar month (1–12) into 12 output rows (one per month, Jan–Dec, always all present even if empty); years are pivoted into columns named `y<YYYY>` (e.g. `y2024`) containing the value for that month/year; the pre-pivot DB query fetches up to `limit × 50` raw rows (hard cap 500) and `limit` is applied to the post-pivot row count.
  - Allowed filters are explicit per kind: `project_id`, `status`, `type`, `series_key`, `subject_type`, `subject_id`, `from`, `to`, `q`, and simple text search where the existing service layer supports it.
  - Allowed sort fields are explicit per kind and default to newest-first where timestamps exist.
  - `limit` is required or defaults to `25`; the service enforces a hard maximum of `500` rows per dataset (raised from 100 in PBI-014 to support pivot use cases).
  - All query execution uses the same owner-scoped service layer as MCP and REST. A page definition cannot read another user's rows, even if its stored JSON names another user's IDs.

- **Display Transforms and Formulas**:
  - Each dataset may include a `display` object with `formulas`: a mapping of formula names to numeric expressions.
  - Formula names must match `[a-z][a-z0-9_]*` and must not overwrite canonical row fields (`id`, `owner_id`, `created_at`, etc.).
  - Formulas may reference only numeric fields already present on each row's result or prepared view-model object (e.g., from existing transforms).
  - Formula expressions support numeric literals, variables, operators (`+`, `-`, `*`, `/`, `%`, parentheses), and allowlisted functions: `round`, `roundTo`, `floor`, `ceil`, `abs`, `min`, `max`.
  - Disallowed in formulas: member access, arrays, strings, comparisons, logical operators, conditionals, loops, assignment, custom functions, and arbitrary JavaScript.
  - Formula results must be finite numbers; `NaN`, `Infinity`, divide-by-zero, and other non-finite outputs are validation errors.
  - Formulas are validated during page create/update/preview; unsafe or malformed formulas reject the operation with validation errors.
  - Formula expressions are limited to 256 characters each; datasets are limited to 10 formulas maximum.
  - Formula evaluation is deterministic, side-effect-free, and happens server-side before Mustache rendering, making results available as additional escaped fields in each row's view model.

- **Pre-Authenticated Page URLs**:
  - Generated URLs have the shape `/:user_slug/:page_slug?access=<opaque_secret>`.
  - The opaque secret is generated with the same cryptographic standard as bearer tokens, shown only once, and stored only as a hash derived with `BRAINFOG_TOKEN_HASH_SECRET` or a successor secret if a future ADR introduces one.
  - On request, the Worker validates the secret hash, page ownership, page status, expiry, revocation, and use count. Invalid links return `404` or a generic `403` without revealing whether the page exists.
  - On success, the Worker increments `use_count`, updates `last_used_at`, sets a page-scoped HTTP-only cookie, and redirects to `/:user_slug/:page_slug` without the `access` query parameter.
  - Page access cookies authorize only that page route and expire no later than the access link. They do not authorize `/app`, `/api/v1/*`, `/mcp`, other pages, or user management.
  - Default expiry is 24 hours when neither `expires_at` nor `ttl_seconds` is supplied. `max_uses` defaults to `1` unless explicitly set higher.

- **Dependencies**:
  - Runtime dependencies remain `hono`, `agents`, and `drizzle-orm` plus the existing project dependencies, with the approved addition of `mustache` for logic-less escaped rendering and one pure-JS HTML parser/validator package such as `htmlparser2` or `parse5`.
  - No new Cloudflare product or binding is required.

- **Constraints**:
  - D1 remains canonical for pages, access links, and all structured memory data.
  - Dynamic pages are views over D1/R2/Vectorize-backed service results; they do not become a new memory source of truth.
  - Page rendering must not bypass auth, owner scoping, provenance, or the memory service layer.
  - Pre-authenticated page URLs are credentials. They must be short-lived by default, revocable, logged only as metadata, and never displayed again after creation.
  - User-authored templates are untrusted input. They must be parsed/validated and rendered with escaping; `dangerouslySetInnerHTML` may only receive output from the trusted template renderer after validation/sanitization.
  - `/api/v1/*`, `/mcp`, `/app/*`, `/assets/*`, `/authorize`, `/token`, `/register`, `/.well-known/*`, and `/:user_slug/*` must not conflict; reserved slugs are rejected at user creation/update time.
  - Dynamic pages should return `no-store` by default because rendered content is authenticated personal memory.

## Contract

### Definition Of Done

- [x] `pages` table exists with owner-scoped slug uniqueness, status lifecycle, template text, query JSON, validation errors, provenance, and timestamps.
- [x] `page_access_links` table exists with hashed secrets, page ownership, expiry, optional max-use count, use count, revocation, provenance, and timestamps.
- [x] MCP tools `create_page`, `update_page`, `list_pages`, `get_page`, and `preview_page` exist and are authenticated/owner-scoped.
- [x] MCP tools `create_page_access_link`, `list_page_access_links`, and `revoke_page_access_link` exist; plaintext access URLs are returned only at creation time.
- [x] REST page-management routes under `/api/v1/ui/pages` exist and call the same service layer as the MCP page tools.
- [x] REST access-link routes under `/api/v1/ui/pages/:id/access-links` and `/api/v1/ui/page-access-links/:id` exist and call the same service layer as the MCP access-link tools.
- [x] Users can list, create, edit, preview, publish/archive, and delete their own page definitions from a basic UI surface.
- [x] Dynamic pages render at `/:user_slug/:page_slug` for the authenticated matching user and return `404` or `403` without revealing whether another user's page exists.
- [x] Dynamic pages can also render through a valid pre-authenticated URL for that exact page; the URL secret is exchanged for a page-scoped HTTP-only cookie and removed from the visible URL via redirect.
- [x] The template renderer validates the allowed tag/attribute subset, escapes all data interpolation, rejects disallowed constructs, and fails closed with validation errors.
- [x] Dynamic page queries accept only validated JSON definitions, never SQL, and enforce owner scope plus per-dataset row limits.
- [x] `pnpm check && pnpm typecheck && pnpm test` pass, including coverage for page validation, unsafe template rejection, owner-scoped dynamic rendering, access-link expiry/use/revocation, pre-auth scope boundaries, and formula validation/evaluation.
- [x] `pnpm test:e2e` covers creating or seeding a page, rendering a published dynamic page under `/:user_slug/:page_slug`, and using a pre-authenticated page URL.
- [x] Formula tests cover valid arithmetic expressions, allowlisted functions (`roundTo`, `floor`, `ceil`, `abs`, `min`, `max`), invalid formulas (member access, strings, conditionals, unsupported functions), unknown variables, non-finite results, protected field overwriting, and no cross-row/cross-user data access.
- [x] `pivot_by_year` is an allowed transform for `time_series_points` queries; it groups rows by calendar month (1–12), pivots years into `y<YYYY>` columns, always emits all 12 month rows (Jan–Dec) with `month` and `month_label` fields, applies `limit` post-transform, pre-fetches `min(limit × 50, 500)` raw rows, and is silently ignored for non-`time_series_points` kinds.

Completion evidence: PBI-007 implementation added `pages` and `page_access_links` schema/migration, a shared page service, Mustache plus parse5 fail-closed template validation/rendering, strict page-owner query execution with server-side display view-model shaping, MCP page/access-link tools, REST page/access-link routes under `/api/v1/ui`, default UI page management, dynamic routes under `/:user_slug/` and `/:user_slug/:page_slug`, and narrow pre-authenticated page links using hashed one-time secrets and page-scoped HTTP-only cookies. Verification on 2026-06-17: `pnpm check && pnpm typecheck && pnpm test` passed with 145 Vitest tests; `pnpm test:e2e` passed with 3 Playwright tests. Critic review initially found blocking issues around invalid draft persistence, pre-auth enumeration by status, a hardcoded MCP access-link origin, and missing MCP/access-link boundary tests; a focused fix pass resolved all four, and final critic confirmation reported no blocking issues.

PBI-016 (pivot_by_year transform) extends this with: a `pivotByYear()` function in `apps/worker/src/pages.ts` that groups `time_series_points` rows by UTC calendar month (1–12), pivots years into `y<YYYY>` columns, always initialises all 12 month buckets so every month row is present regardless of data availability, and uses last-write-wins semantics consistent with `pivot_by_date`. The transform is wired into `mapRows` with a `min(limit × 50, 500)` pre-pivot DB fetch. `pivot_by_year` added to `allowedTransforms`. Verification on 2026-06-18: `pnpm check && pnpm typecheck && pnpm test` passed with 210 Vitest tests (7 new `pivot_by_year` unit tests covering: 12-row output, correct `month_label`/`y<YYYY>` fields for known rainfall data, sparse-year rows, silent no-op for non-`time_series_points` kinds, and post-transform limit application). All existing `pivot_by_date` and formula tests continued to pass. Critic found no blocking issues; non-blocking notes: transform precedence (pivot_by_year wins over pivot_by_date if both present) is implicit in code order, and pre-existing PBI-015 backup infrastructure changes were present in the worktree but are not part of this PBI.

PBI-013 (display formulas) extends this with: a formula evaluator module (`apps/worker/src/formula.ts`) using `expr-eval` (declared in `@brainfog/worker`) with strict syntax validation (patterns: member access, strings, comparisons, conditionals, assignment, and `==`/`!=` forbidden; only numeric operators and allowlisted functions allowed); formula validation at page create/update/preview time rejecting unsafe expressions, too-long expressions (>256 chars), too-many formulas (>10 per dataset), protected field overwrites, and non-finite results; formula evaluation server-side after owner-scoped queries and before Mustache rendering; formula results available as additional escaped fields in row view models. Verification on 2026-06-17: `pnpm check && pnpm typecheck && pnpm test` passed with 196 Vitest tests (43 formula unit tests, integration tests, plus all existing page tests). Formula tests cover simple arithmetic, function calls (`round` 1-arg, `roundTo` 2-arg, `floor`, `ceil`, `abs`, `min`, `max`), complex multi-variable expressions, invalid syntax including `==`/`!=` operators, length/count limits, name validation, protected field overwriting, and no cross-row evaluation. Integration tests confirm formulas are validated on page creation and can be previewed without publishing. No regressions in existing page functionality.

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
