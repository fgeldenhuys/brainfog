# PBI-026: Garmin Activity Notes Page

## Directive

Enhance dynamic user pages so Garmin activity tables can group metrics by activity identity and display thoughts linked to each activity's canonical time-series point.

## Scope

- Spec: `specs/user-pages/spec.md`
- Covers DoD items: Extends the completed dynamic-page query/display shaping behavior so page definitions can render grouped time-series activity rows enriched with owner-scoped linked thoughts, while preserving the spec's safe template rendering, no arbitrary SQL, owner scoping, and server-side display-transform constraints.
- Out of scope:
- Adding `time_series_point_ids` to `remember`/`link`; that is PBI-025 and must land first.
- Creating a first-class `activities` table.
- Changing Garmin ingestion or backfilling existing data beyond using rows already in D1.
- Client-side JavaScript, raw SQL in page definitions, new frontend dependencies, or public unauthenticated pages.
- Rendering notes from unrelated activities or cross-user private thoughts.

## Dependencies

- PBI-025: Time-Series Thought Links.
- Current user-page renderer in `apps/worker/src/pages.ts`, especially `pivot_by_date`, formulas, date labels, and validated query definitions.
- Dependency graph read helpers (`listDependencies` or lower-level service equivalents) and owner/shared validation rules.
- PBI-019/PBI-020 Garmin ingestion output: activity metric rows use `series_key` values under `garmin.activities.*` and metadata fields such as `activity_id`, `external_activity_id`, `activity_name`, and `activity_type`.

## Context

The current Garmin page uses `series_prefix: "garmin.activities"` plus `pivot_by_date` to render one row per date. That is good enough for current sample data, but it is not semantically correct: two activities on the same day would merge into one row. The page also cannot display a user's thought explaining what they did during a cardio/cycling activity.

PBI-025 will make the correct note model possible: a thought can reference the canonical time-series point for an activity, preferably the `garmin.activities.duration` row. This PBI should make page rendering capable of grouping Garmin metrics by activity identity and exposing linked thought content in that grouped row.

## Intent Preservation

1. **Pages remain views, not sources of truth.** The page must read D1/dependency graph data and render it; it must not write notes or mutate links.
2. **No arbitrary joins in page JSON.** Any new enrichment must be a validated transform or query option, not raw SQL or template-side logic.
3. **Activity grouping must not be date-only.** Garmin rows sharing `metadata.activity_id` should produce one row per activity, even when multiple activities occur on the same calendar day.
4. **Thought links must respect graph direction.** The linked thoughts are downstream dependents where `dependent_kind = thought`, `dependency_kind = time_series_point`, and `relationship = references` for the canonical activity point.
5. **Owner scoping must be enforced in the service layer.** Page rendering must not bypass memory/dependency service authorization.
6. **Templates stay escaped and JavaScript-free.** Notes should render through normal Mustache escaped fields/sections.

## Implementation Plan

### 1. Confirm Page Query Extension Shape

- Read `AGENTS.md`, `ARCHITECTURE.md`, `specs/user-pages/spec.md`, PBI-025, and this PBI before editing.
- Inspect `apps/worker/src/pages.ts` query normalization and transform handling.
- Decide the smallest page-definition extension that supports this use case. Preferred minimal shape:
- Add a transform named `pivot_by_activity` for `time_series_points` queries that groups by `metadata.activity_id` or `metadata.external_activity_id`, falling back to exact `observedAt` only if no activity id exists.
- Add an enrichment transform or display option named `linked_thoughts` / `activity_notes` that attaches an array of referenced thought rows to each grouped activity row by following dependency edges from the canonical metric point id.
- If adding a new transform changes the spec Contract, pause for explicit approval before editing `specs/user-pages/spec.md`; otherwise record the extension in the PBI close-out notes.
- Acceptance criteria:
- The chosen query JSON shape is validated, deterministic, and does not allow raw SQL.

### 2. Preserve Canonical Point IDs During Activity Pivoting

- File scope: `apps/worker/src/pages.ts` and tests.
- Implement `pivot_by_activity` for `time_series_points` only.
- Group rows by `metadata.activity_id` first, then `metadata.external_activity_id`, then a stable fallback such as `observedAt` ISO string.
- Within each group, expose numeric metric fields using the active `series_prefix` suffix behavior from the current `pivot_by_date` implementation.
- Copy primitive metadata fields such as `activity_id`, `external_activity_id`, `activity_name`, and `activity_type` into the grouped row.
- Preserve a canonical point id on the grouped row, preferably from `garmin.activities.duration`; if duration is absent, use the first point id in the group.
- Preserve `observedAt` and `observed_at_label` based on the activity start time.
- Apply post-transform `limit` to grouped activities, newest first.
- Acceptance criteria:
- Two activities on the same date but with different activity ids render as two rows.
- Existing `pivot_by_date` behavior for electricity/rainfall pages remains unchanged.

### 3. Attach Linked Thoughts To Activity Rows

- File scope: `apps/worker/src/pages.ts` and dependency service helpers if needed.
- For grouped rows with a canonical time-series point id, query dependency edges where that point is the dependency and linked thoughts are dependents with relationship `references`.
- Fetch the linked thought rows owner-scoped and attach them as an array, for example `thoughts` or `notes`, with at least `id`, `content`, `type`, `createdAt`, and `created_at_label`.
- Keep enrichment bounded: avoid N+1 queries if simple batching is possible; otherwise enforce row limits tightly and document why the small N is acceptable.
- Do not expose thoughts from other users unless existing shared-read rules explicitly allow them.
- Acceptance criteria:
- A note thought linked to an activity's duration point appears on the correct activity row.
- A thought linked to a different activity does not appear on that row.
- Unlinked activities render with an empty notes section without errors.

### 4. Update The Garmin Activities Page Definition

- Use the existing `garmin-activities` page as the target after code is deployed.
- Update the page query to use the new activity grouping/enrichment shape.
- Update the template to render notes in a `Notes` column, preferably as a short list of escaped thought content.
- Keep existing columns: date, activity, type, duration, distance, calories, avg/max HR, elevation gain, and avg speed.
- Acceptance criteria:
- The live page shows linked notes for activities that have them.
- Activities without notes still render cleanly.

### 5. Tests

- File scope: `apps/worker/test/ui-pages.test.ts` and possibly a dependency graph test file if enrichment requires a new helper.
- Add Worker-runtime tests covering:
- `pivot_by_activity` groups by `metadata.activity_id`, not date.
- Multiple activities on one date do not merge.
- Metric formulas still work on grouped activity fields.
- Linked thoughts attached via dependency edges render under the correct activity row.
- Cross-owner private linked thoughts or points are not exposed.
- Existing page tests for `pivot_by_date`, `pivot_by_year`, formulas, and access links still pass.

## Verification

- `pnpm check && pnpm typecheck && pnpm test` pass.
- `pnpm build` passes if page renderer behavior changes substantially.
- A live or local page preview demonstrates a Garmin activity row with a linked thought rendered in the notes column.
- If deployed as part of the PBI, update the published `garmin-activities` page and create a fresh page access link for manual review.

## Close-Out Checklist

- [x] Garmin activity rows can be grouped by `metadata.activity_id` / `external_activity_id`.
- [x] Activity grouping preserves a canonical time-series point id (`canonical_time_series_point_id`, preferring duration suffix) for linked-note lookup.
- [x] Page rendering can attach linked thought notes (`notes` array) to each activity row via `activity_notes` transform.
- [x] The Garmin activities page template can include a notes column/list via nested escaped `{{#notes}}` sections.
- [x] Tests cover same-day multiple activities (2 activities on same date render as 2 rows), linked notes rendered in page HTML, and owner-scoping (cross-owner private data excluded).

## Ship-PBI Log

- 2026-06-24: Implementation pass completed for `apps/worker/src/pages.ts` and `apps/worker/test/ui-pages.test.ts`.
- 2026-06-24: Initial `pnpm test` run hit Cloudflare Vitest pool runner startup timeouts before most suites imported. Reran with `pnpm --filter @brainfog/worker exec vitest run --maxWorkers 1` to cap Cloudflare pool concurrency; all 12 test files and 260 tests passed.
- 2026-06-24: Follow-up fix allowed nested Mustache sections inside known dataset rows so `{{#notes}}` can render linked activity notes through escaped templates. Final verification passed with `pnpm check && pnpm typecheck && pnpm --filter @brainfog/worker exec vitest run --maxWorkers 1 && pnpm build`.
- 2026-06-24: Critic found one blocking determinism issue for same-timestamp activity groups. Fixed `pivot_by_activity` to sort ties by stable activity key before applying post-transform `limit`, added a regression test, and re-ran `pnpm check && pnpm typecheck && pnpm --filter @brainfog/worker exec vitest run --maxWorkers 1 && pnpm build` (12 test files, 261 tests passed; build dry-run passed).
- 2026-06-24: Critic follow-up found no remaining blocking findings and confirmed PBI-026 can close. Non-blocking note: `specs/user-pages/spec.md` should eventually list `pivot_by_activity` and `activity_notes` if these transforms are treated as durable contract surface.

## Refinement Protocol

- If adding `pivot_by_activity` or linked-note enrichment requires a user-pages Contract change, pause and ask before editing `specs/user-pages/spec.md`.
- If activity identity should become a first-class data model instead of grouped time-series rows, stop and open a separate spec/PBI rather than hiding a schema migration inside this page-rendering PBI.
- If PBI-025 is not complete, do not fake notes by reading arbitrary thought text from metadata; wait for proper dependency graph links.
