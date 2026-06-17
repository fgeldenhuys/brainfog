# PBI-013: User Page Display Formulas

## Spec

`specs/user-pages/spec.md`

## Goal

Add safe, server-side numeric display formulas to user pages so a page can show derived fields such as differences, ratios, percentages, or simple arithmetic over values already present in a page dataset.

## Scope

- Extend the user-pages dynamic query/display model with an allowlisted `formulas` display transform.
- Add an approved formula-expression dependency, recommended: `expr-eval`, wrapped in a restrictive evaluator.
- Evaluate formulas server-side only, after strict owner-scoped page query execution and before Mustache rendering.
- Make formula outputs available as additional escaped Mustache fields in each dataset row/view-model object.
- Add validation errors for unsafe, unsupported, too-large, or non-numeric formulas before storing or rendering a page.
- Add tests covering valid arithmetic formulas, invalid formulas, unknown variables, non-finite results, and no cross-row/cross-user data access.
- Update `specs/user-pages/spec.md` to document the formula transform and mark completion evidence when implemented.

## Out Of Scope

- Unit-conversion helpers or named conversion presets.
- Arbitrary JavaScript, `eval`, `new Function`, user-supplied functions, or client-side formula execution.
- Cross-row aggregation formulas, window functions, joins, SQL expressions, or formulas that fetch additional data.
- String manipulation, date math, conditionals, comparisons, logical expressions, or object traversal in formulas.
- Public pages or cacheable/static formula output.

## Dependencies

- PBI-007 user pages must be deployed first. This PBI builds on the server-side display view-model shaping in `apps/worker/src/pages.ts`.
- The approved dependency direction is `expr-eval` unless implementation finds a concrete Worker/runtime problem. If `expr-eval` is unsuitable, pause and propose an alternative before adding a different package.
- No new Cloudflare product or binding is required.

## Formula Model

Formula definitions live inside a dataset's display options. Example shape:

```json
{
  "readings": {
    "kind": "time_series_points",
    "limit": 25,
    "display": {
      "formulas": {
        "delta": "after - before",
        "percent_complete": "round((completed / total) * 100, 1)"
      }
    }
  }
}
```

Rules:

- Formula names become output fields on each row's prepared view model.
- Formula names must be simple safe identifiers (`[a-z][a-z0-9_]*`) and must not overwrite existing canonical row fields unless explicitly allowed by the service.
- Formulas may reference only numeric fields already present on that row's raw result or prepared view-model object.
- Formula results must be finite numbers. `NaN`, `Infinity`, `-Infinity`, divide-by-zero non-finite outputs, and thrown evaluations are validation/render errors.
- Formula expressions should have a conservative length limit, e.g. 256 characters, and a conservative count limit per dataset, e.g. 10 formulas.
- Formula evaluation must be deterministic and side-effect free.

Allowed syntax:

- Numeric literals.
- Variables matching known row/view-model numeric fields.
- Operators: `+`, `-`, `*`, `/`, `%`, parentheses.
- Allowlisted functions only: `round`, `floor`, `ceil`, `abs`, `min`, `max`.

Disallowed syntax:

- Assignment, member access/object traversal, arrays, strings, logical/comparison operators, ternaries, conditionals, loops, custom functions, built-in globals, imports, network access, date access, and any JavaScript execution.

## Intent Preservation

- **No page-authored JavaScript.** Formulas are data, not code. The evaluator must parse and execute a restricted numeric expression DSL server-side.
- **Strict owner scope remains unchanged.** Formula inputs are only the row/view-model fields produced by the existing strict page-owner query execution path; formulas must not widen visibility to `shared = true` rows or other users' data.
- **Mustache remains logic-less.** Formulas produce fields before rendering; templates only interpolate escaped values.
- **Fail closed.** Invalid formula definitions reject page create/update/preview and never persist unsafe page definitions.
- **Small v1 surface.** Prefer a minimal evaluator wrapper over a rich spreadsheet/calculation feature. Unit conversions and cross-row aggregations are future PBIs.

## Verification

- `pnpm install` if `expr-eval` is added.
- `pnpm check && pnpm typecheck && pnpm test` pass.
- `pnpm test:e2e` passes if page-rendering behavior is affected.

Required tests:

- A valid formula such as `delta = after - before` renders as an escaped Mustache field on a dynamic page.
- A formula can use allowlisted functions such as `round((completed / total) * 100, 1)`.
- Unknown variables are rejected before storage/rendering.
- Non-numeric inputs and non-finite results are rejected or handled as validation errors according to the service contract.
- Disallowed syntax, including member access, assignment, strings, conditionals, and unsupported functions, is rejected.
- Formula output fields cannot overwrite protected/canonical fields.
- Another user's rows, including `shared = true` rows, cannot become formula inputs for a page.

## Refinement Protocol

- If `expr-eval` cannot be restricted to the allowed syntax above, do not add a permissive configuration. Either use it only as a parser with a custom evaluator, or pause and propose a different dependency.
- If formulas require richer display transforms than this PBI allows, create a follow-up PBI rather than expanding this one.
- If this work requires changing the `specs/user-pages/spec.md` Contract section, pause for explicit approval before editing it.
