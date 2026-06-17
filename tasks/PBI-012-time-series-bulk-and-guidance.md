# PBI-012: Time-Series Bulk Insert, Prefix Query, and Agent Guidance

## Directive

Add a bulk-insert MCP tool for time-series points, a `series_prefix` filter on list, and rewrite the tool descriptions to give connected agents clear, opinionated guidance on series naming, value/metadata conventions, and the requirement to document and verify series conventions in brainfog before inserting data.

## Scope

- **Spec:** `specs/memory-model/spec.md`
- **Covers DoD items:** Extends the time-series section of the memory model with three new capabilities (bulk insert, prefix filter, agent guidance descriptions). The following new DoD items are added to `specs/memory-model/spec.md` as part of this PBI:
  - `record_time_series_points` (plural) MCP tool accepts an array of point objects and inserts them in a single batch
  - `list_time_series_points` accepts an optional `series_prefix` parameter that filters with `LIKE 'prefix.%'` using the existing `(owner_id, series_key, observed_at)` index
  - Tool descriptions for both the singular and plural insert tools carry the full agent-guidance prose defined in the Context section below
- **Out of scope:**
  - Changes to the `value` column type (remains `real`; compound data belongs in `metadata`)
  - Web UI changes
  - New indexes — the existing `(owner_id, series_key, observed_at)` index already supports prefix range scans efficiently

## Dependencies

- No other open PBIs are blockers.
- The existing `time_series_points` schema and indexes are not changed — no new migration is required unless the implementor finds one necessary.

## Context

### Why This Work

Recording the electricity top-up history (32 rows × 4 series = 128 MCP calls) exposed two friction points:

1. **Call volume.** Each `record_time_series_point` is a separate HTTP round-trip and D1 write. A batch tool collapses this to one call.
2. **No namespace query.** The dot-namespaced convention (`electricity.before`, `electricity.after`, …) is efficient for prefix queries in SQLite (`LIKE 'electricity.%'` uses the B-tree index as a range scan), but `list_time_series_points` only supports exact `series_key` equality. Querying all series under a namespace requires N separate calls.
3. **No agent guidance.** Tool descriptions are terse; agents have no instruction on how to structure series names, when to split vs. compound, what `metadata` is for, or that they must document a series convention before writing data.

### Bulk Insert Tool: `record_time_series_points` (plural)

New MCP tool alongside the existing singular one:

```
record_time_series_points(points: Array<{
  series_key: string,
  value?: number | null,
  unit?: string | null,
  observed_at?: number | null,
  project_id?: string | null,
  metadata?: Record<string, unknown>,
}>)
```

Implementation notes:
- Validate all rows up front (project existence if supplied); reject the whole batch on any validation failure.
- Use a single Drizzle `.insert(timeSeriesPoints).values([...rows])` call.
- No subject/edge support in the bulk tool (subject relationships remain singular-only for now).
- Return the inserted rows array.

### Series Prefix Filter

`list_time_series_points` gains an optional `series_prefix` parameter. When supplied, the handler generates:

```sql
WHERE series_key LIKE '<prefix>.%'
```

The existing `(owner_id, series_key, observed_at)` index handles this as a B-tree range scan — no new index needed. `series_key` exact-match and `series_prefix` are mutually exclusive; if both are supplied, return an error.

### Agent Guidance — Tool Descriptions

The descriptions for `record_time_series_point`, `record_time_series_points`, and `list_time_series_points` must be updated to include the following guidance prose (adapt wording to fit each tool's natural framing, but preserve all substantive rules):

---

**Series naming and namespacing**

Use a dot-namespaced `series_key` of the form `<domain>.<metric>`, e.g. `electricity.spent`, `sleep.hours`, `weight.kg`. The namespace prefix (before the first `.`) groups related series and enables efficient prefix queries via `list_time_series_points` with `series_prefix`.

**Split series vs. compound rows — prefer split**

When an observation event produces multiple related numeric values (e.g. a top-up records "before", "after", "spent", and "purchased"), the default recommendation is to record each as a separate series point with the same `observed_at` timestamp:

- `electricity.before` / `electricity.after` / `electricity.spent` / `electricity.purchased`

This keeps each metric independently queryable, plottable, and aggregatable over time. Use the bulk insert tool (`record_time_series_points`) to record all fields in a single call.

Use a compound (single) row only when all fields are always retrieved together as a unit and none needs to be queried or charted independently — in that case, put the primary scalar in `value` and the rest in `metadata`.

**`value` is the primary numeric scalar — `metadata` is for secondary and non-numeric data**

- `value` (nullable real): the one number that matters most for this series, e.g. `spent` in ZAR, `hours` slept. Leave null if there is no meaningful primary scalar.
- `unit`: the unit for `value`, e.g. `ZAR`, `kWh`, `h`, `kg`.
- `metadata`: a JSON object for everything else — secondary readings, contextual notes, tags, free-text. Examples: `{"notes": "Away for 3 days"}`, `{"before": 375, "after": 583, "purchased": 208}`. Do not duplicate `value` in `metadata`.

**Document the series convention before inserting data**

Before recording points for a new series namespace (a namespace you have not used before), you MUST:

1. Call `recall` with a query like `"electricity time series convention"` to check whether a convention fact already exists for this namespace.
2. If no convention fact exists, call `record_fact` to create one. The fact must document:
   - The namespace and what it represents
   - Each `series_key` used, its meaning, and its `unit`
   - What fields appear in `metadata` and their types
   - The event that triggers a new row (e.g. "recorded on each electricity top-up")
3. If a convention fact already exists, read it and follow it — do not deviate from the established field names, units, or metadata schema.

This ensures data stays consistent across future insertions regardless of which agent or session performs them.

---

## Intent Preservation

1. **No schema change to `value`.** It remains `real` (nullable). Compound/secondary data belongs in `metadata`. Do not add a `value_json` column or change `value` to text.
2. **Bulk tool has no subject/edge support.** The singular tool's subject-to-dependency-edge path remains unchanged. The bulk tool does not add subject fields; keep it simple.
3. **`series_prefix` is index-safe.** The filter must use `LIKE 'prefix.%'` (prefix + dot + wildcard), not `LIKE '%prefix%'`, so the B-tree index can be used. The dot separator is load-bearing — validate or document that the prefix itself must not contain `%` or `_`.
4. **Singular tool is unchanged in behavior.** `record_time_series_point` continues to work exactly as before; only its description text changes.
5. **Provenance invariant (ARCHITECTURE.md invariant 4).** Each bulk-inserted row must carry `source = "mcp:tool"` and the caller's `owner_id`, exactly as the singular tool does.

## Verification

### Build and type checks
- `pnpm check` and `pnpm typecheck` pass with no new errors.
- `pnpm build` succeeds.

### Unit / Miniflare tests
- `record_time_series_points` with a valid array of 3+ points inserts all rows, returns them, and each has the caller's `owner_id` and `source = "mcp:tool"`.
- `record_time_series_points` with a bad `project_id` on any point rejects the whole batch (no partial insert).
- `list_time_series_points` with `series_prefix = "electricity"` returns all `electricity.*` points and none from other namespaces.
- `list_time_series_points` with both `series_key` and `series_prefix` returns an error.
- Existing singular `record_time_series_point` and `list_time_series_points` (exact key) tests continue to pass.
- `pnpm test` passes in full.

### Description content check
- `tools/list` response for `record_time_series_point`, `record_time_series_points`, and `list_time_series_points` includes the words "series_prefix", "metadata", "convention", and "recall" in their descriptions (manual inspection or a test asserting description length > N chars).

## Refinement Protocol

If the Drizzle batch insert behaves differently for D1 (e.g. statement count limits), implement as a transaction with sequential inserts rather than a single `.values([...])` call, and note the limitation in the close-out. The external contract (one tool call, all-or-nothing result) must be preserved regardless of the internal implementation.

## Ship-PBI Log

**Status:** Complete — 2026-06-17

**Iterations:** 2 implementor passes (1 fix pass for blocking critic finding)

**Gates:** `pnpm check && pnpm typecheck && pnpm test` — 151/151 passed both passes.

**Pass 1 — Implementation:**
- Added `recordTimeSeriesPoints` function in `apps/worker/src/memory.ts` with single Drizzle `.insert().values([...])` call (no D1 statement-limit workaround needed).
- Added `series_prefix` filter to `listTimeSeriesPoints` using `like(seriesKey, \`${prefix}.%\`)`.
- Registered `record_time_series_points` MCP tool and `POST /api/v1/time-series-points/batch` REST route.
- Updated tool descriptions for all three time-series tools with full agent guidance prose.
- Added comprehensive Vitest/Miniflare tests covering all DoD items.

**Critic finding (blocking):** Source field hardcoded to `"mcp:tool"` in bulk insert instead of using `source(ctx)`, violating ARCHITECTURE.md invariant 4. REST calls to `/api/v1/time-series-points/batch` would have recorded incorrect provenance.

**Pass 2 — Fix:**
- Changed `source: "mcp:tool"` → `source: source(ctx)` in `recordTimeSeriesPoints`.
- Updated test assertion to expect `"rest:api"` for the REST-path test.
- Updated `specs/memory-model/spec.md` DoD items to formally document the new tools and `series_prefix` parameter, plus added completion evidence entry.

**Refinement note:** Drizzle `.insert().values([...])` worked fine for D1; no transaction workaround needed.
