# Vectorize metadata indexes

`recall` (`specs/memory-model/spec.md`) filters Vectorize queries by `owner_id`
and optionally `kind`/`project_id` (ADR-005). Cloudflare Vectorize requires a
**metadata index** for every property used in a `.query()` `filter` —
without one, the query still returns `{success: true, matches: []}` (no
error), so `recall` silently falls back to the D1 `LIKE` keyword search for
every call, scored `0`.

This is **not** part of the Wrangler config (`apps/worker/wrangler.jsonc`) —
it's a one-time, per-index setup step against the deployed Vectorize index
(`brainfog-vectors`), run once per environment (ARCHITECTURE.md invariant 7:
currently a single hosted environment):

```sh
npx wrangler vectorize create-metadata-index brainfog-vectors --propertyName owner_id --type string
npx wrangler vectorize create-metadata-index brainfog-vectors --propertyName kind --type string
npx wrangler vectorize create-metadata-index brainfog-vectors --propertyName project_id --type string
```

Verify with:

```sh
npx wrangler vectorize list-metadata-index brainfog-vectors
```

**Caveat:** metadata indexes only apply to vectors upserted *after* the index
was created. Vectors upserted before this step won't match filtered queries
until they're re-upserted (re-running the write that created them, e.g. via
`update_fact`/`update_document`, or a future rebuild-from-D1 tool per
ARCHITECTURE.md invariant 3).

If the Vectorize index is ever dropped and rebuilt, repeat this step before
relying on filtered `recall` results.
