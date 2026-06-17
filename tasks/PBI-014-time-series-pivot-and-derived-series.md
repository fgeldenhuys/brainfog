# PBI-014: Time-Series Pivot Transform and Electricity Derived Series

## Directive

Add a `pivot_by_date` transform to the page query system for `time_series_points` (Option B from the
analysis in session 2026-06-17), then backfill five derived electricity series and update the
electricity user page to produce a single combined table matching the spreadsheet layout.

## Scope

- **Spec:** `specs/user-pages/spec.md` (adds `pivot_by_date` to the allowed transforms list)
- **New DoD items:**
  - `pivot_by_date` is an allowed transform for `time_series_points` page queries
  - When applied, rows are grouped by their `observedAt` calendar date (YYYY-MM-DD bucket); each
    group collapses to one row with numeric series suffixes as fields, `observedAt` preserved, and
    `notes` merged from `metadata.notes` (first non-empty across the group wins)
  - Series suffix is the text after the **first dot** in `seriesKey`
    (e.g. `electricity.cost_per_unit` → field `cost_per_unit`)
  - When `pivot_by_date` is present the pre-pivot DB query fetches up to `limit × 20` rows (hard
    cap 500); `limit` is then applied to the post-pivot rows. The per-query hard max of raw rows
    rises to 500 (was 100) to support pivot use cases
  - `pivot_by_date` is silently ignored for non-`time_series_points` query kinds
  - Five derived `electricity.*` series are backfilled for all historical events and recorded on
    each future top-up: `cost_per_unit`, `days`, `units_used`, `units_per_day`, `cost_per_month`
    (see Context for definitions)
  - The electricity user page is updated to use a single `series_prefix: electricity` + `pivot_by_date`
    dataset with one combined table — Date | Before | After | Spent (ZAR) | Purchased (kWh) |
    Cost/Unit | Days | Units Used | Units/Day | Cost/Month | Notes
- **Out of scope:**
  - Chained formula evaluation (formulas referencing sibling formula results)
  - Window/LAG functions in the query system (deferred; see Option C in analysis)
  - Other time-series domains beyond electricity backfill

## Dependencies

- PBI-007, PBI-012, PBI-013 must be complete (all are)
- The electricity page (`slug = 'electricity'`) created 2026-06-17 must exist
- The `series_prefix` filter bug fix and `queries` JSON-string parse fix (both landed in
  session 2026-06-17 as ad-hoc fixes before this PBI was written) are prerequisites; they are
  already deployed

## Context

### Why this work

The electricity page launched (PBI-007 + 2026-06-17 session) shows three separate tables and
cannot produce the combined top-up view that exists in the spreadsheet. Two capabilities were
missing:

1. **Cross-series join (Option B):** four separate time-series per event need to become one row
   per date. The `pivot_by_date` transform handles this server-side in `mapRows`.
2. **Cross-row derived values (Option A):** Days between top-ups and units consumed require the
   previous event's `after` reading. Rather than adding window functions (Option C, larger scope),
   these are stored as additional series and backfilled.

### Pivot Transform: `pivot_by_date`

**Algorithm in `mapRows` (called after DB query):**

1. If `pivot_by_date` is in transforms **and** kind is `time_series_points`, call `pivotByDate(rows)` before the per-row transform loop.
2. `pivotByDate` iterates the raw rows (already ordered `observedAt DESC` by the query) and
   accumulates a `Map<dateKey, pivotRow>` keyed by `observedAt.toISOString().slice(0, 10)`.
3. For each raw row: extract suffix = `seriesKey.slice(seriesKey.indexOf('.') + 1)`. If `value`
   is a finite number, set `pivotRow[suffix] = value`. Merge `metadata.notes` (first non-empty).
4. Set `pivotRow.observedAt` and `pivotRow.observed_at_label` from the first row in the group.
5. Return `Array.from(groups.values())` — insertion order preserves newest-first from the DB sort.

**Limit semantics when `pivot_by_date` is used:**

The DB query uses `LIMIT min(q.limit * 20, 500)` so that enough pre-pivot rows arrive for
`q.limit` pivot rows (assumes ≤ 20 series per prefix). After pivoting, slice to `q.limit`.
The hard max `Math.min(100, ...)` in `normalizeQueries` rises to `Math.min(500, ...)`.

**Edge cases:**
- Duplicate series key within same date: last value wins (no summation).
- Missing series for a date (e.g. first event has no `days`): field absent → Mustache renders
  as empty string, no formula error (formulas are not used on the electricity page).
- `pivot_by_date` + `count` transform: `count` is applied to the post-pivot row count.
- `pivot_by_date` without `series_prefix` (e.g. single `series_key`): produces single-field
  pivot rows; technically valid but not meaningful.

### Derived Electricity Series (Option A)

Five new series are recorded per top-up event (bulk-inserted with one `record_time_series_points`
call each time the agent records a top-up, after first querying the most recent prior
`electricity.after` row):

| Series key | Unit | Definition |
|---|---|---|
| `electricity.cost_per_unit` | ZAR/kWh | `round(spent / purchased, 2)` |
| `electricity.days` | days | calendar days since previous `observedAt` |
| `electricity.units_used` | kWh | previous `after` − current `before` |
| `electricity.units_per_day` | kWh/day | `round(units_used / days, 1)` |
| `electricity.cost_per_month` | ZAR/month | `round(units_per_day × 30 × cost_per_unit, 0)` |

The first historical event (2024-02-14) has no previous event; `days`, `units_used`,
`units_per_day`, and `cost_per_month` are omitted for it. `cost_per_unit` is still recorded.

All backfilled series points use the event's original `observedAt` date (not insertion time).

### Updated Electricity Page

The three-table page is replaced by a single dataset:
- `kind: time_series_points`, `filters: { series_prefix: "electricity" }`, `limit: 50`,
  `transforms: ["pivot_by_date"]`
- No display formulas (all derived values come from stored series via pivot)
- Template: one `<table>` iterating the pivot dataset, columns as above
- Empty cells render naturally where derived series are absent (first event)

## Intent Preservation

1. **No formula chaining added.** `applyFormulas` continues to evaluate each formula against the
   original row data only. Chaining would require a separate PBI with careful ordering semantics.
2. **Hard max increase is page-system only.** The MCP `list_time_series_points` tool and REST
   endpoints retain their own limits; only `normalizeQueries` in `pages.ts` changes.
3. **Provenance on derived series.** Each backfilled `record_time_series_points` call sets
   `observed_at` to the event date, ensuring the derived series appear at the correct date in
   the pivot. Source = `"mcp:tool"` per invariant 4.
4. **Electricity series convention fact.** Before backfilling, verify or update the convention
   fact that documents the `electricity.*` namespace to include the five new series.
5. **Backward-compatible.** Existing pages that do not use `pivot_by_date` are unaffected.
   The limit increase from 100 → 500 does not break existing queries (they just get access to
   more rows if they set `limit` higher than 100).

## Verification

### Build and type checks
- `pnpm check && pnpm typecheck && pnpm build` pass with no new errors.

### Unit / Miniflare tests
- `pivot_by_date` on a `time_series_points` query with `series_prefix` groups rows by date and
  produces one row per date with suffix fields.
- `notes` from `metadata.notes` is merged into the pivot row (first non-empty wins).
- `limit` is applied to post-pivot row count, not pre-pivot.
- `pivot_by_date` on a non-`time_series_points` query has no effect (rows pass through unmodified).
- Existing page tests (template validation, formula validation, access-link tests) continue to pass.
- `pnpm test` passes in full (no regressions).

### Electricity page output check
- The electricity page at `/francois/electricity` (access link) renders a single table.
- The table has 32 data rows (one per historical top-up event).
- The first row (2026-06-09, newest) shows correct Before, After, Spent, Purchased, Cost/Unit,
  Days, Units Used, Units/Day, Cost/Month, Notes.
- The oldest row (2024-02-14) shows Before, After, Spent, Purchased, Cost/Unit and empty cells
  for Days, Units Used, Units/Day, Cost/Month (no previous event).
- Values match the spreadsheet for at least the last five events.
