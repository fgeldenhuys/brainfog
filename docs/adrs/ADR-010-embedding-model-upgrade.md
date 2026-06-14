# ADR-010: Embedding Model Upgrade To qwen3-embedding-0.6b

## Status

Accepted — 2026-06-14

## Context

ADR-005 established Workers AI embeddings + Vectorize for semantic recall, citing `@cf/baai/bge-base-en-v1.5` (768 dimensions, 512-token context window) as an example model, and explicitly anticipated that "changing models implies a new index or a migration, to be handled by a future ADR if it happens."

Cloudflare's Workers AI catalog now includes `@cf/qwen/qwen3-embedding-0.6b`: 1024 dimensions, a 4096-8192 token context window (vs 512 for `bge-base-en-v1.5`), and roughly 5.6x lower per-token price (~$0.012/M neurons vs ~$0.067/M). Neither model is on Cloudflare's deprecation list, but qwen3-embedding-0.6b is materially cheaper and supports much longer inputs.

Brainfog's single hosted D1 database currently holds only test data (one user, and a handful of rows across `projects`, `people`, `tasks`, `facts`, `documents`, `document_chunks`, `thoughts`, and `time_series_points`). Switching the embedding model now, while there is no real user data to re-embed, avoids a costlier migration later.

## Decision

We will switch brainfog's embedding model from `@cf/baai/bge-base-en-v1.5` (768 dimensions) to `@cf/qwen/qwen3-embedding-0.6b` (1024 dimensions) for all `thoughts`, `facts`, and `document_chunks` embeddings (`specs/memory-model/spec.md`).

Because a Vectorize index's dimension is fixed at creation and cannot be changed in place, the existing `brainfog-vectors` index (platform baseline, ADR-005) is deleted and recreated at dimension 1024, keeping the same index name and Wrangler binding (`VECTORIZE`). Its per-property metadata indexes (`owner_id`, `kind`, `project_id` — `docs/notes/vectorize-setup.md`) are recreated against the new index.

Because the recreated index starts empty and the existing D1 rows' vectors would otherwise be orphaned, and because the hosted database currently holds only test data, all rows in the memory-model tables (`projects`, `people`, `tasks`, `facts`, `documents`, `document_chunks`, `thoughts`, `time_series_points`, and their junction tables) are cleared as part of this migration. `users` and `tokens` are preserved so existing bearer-token auth (ADR-004) continues to work unchanged.

This is the "future ADR" anticipated by ADR-005's Neutral consequence about model changes. ADR-005's core decision — Workers AI embeddings + Vectorize for semantic recall, with D1 canonical and Vectorize a derived/rebuildable index (`ARCHITECTURE.md` invariants 2-3) — remains in effect; only the specific model and its dimension change.

## Consequences

**Positive**

- Roughly 5.6x lower Workers AI embedding cost per write.
- Much larger embedding context window (4096-8192 tokens vs 512), reducing truncation risk for long `document_chunks`/`facts`/`thoughts` content.
- `@cf/qwen/qwen3-embedding-0.6b`'s output shape (`{ data?: number[][], shape?: number[] }`) matches `@cf/baai/bge-base-en-v1.5`'s, so `apps/worker/src/memory.ts`'s `embed()` response-parsing logic is unchanged beyond the model name and dimension constants.

**Negative**

- The Vectorize index must be deleted and recreated (dimension is immutable post-creation) and its metadata indexes recreated — a manual, per-environment operational step, repeating the pattern `docs/notes/vectorize-setup.md` already documents for initial setup.
- All existing memory-model rows are cleared as part of this migration. This is acceptable only because the hosted database currently holds test data only, per explicit project decision for PBI-004; it would not be acceptable once real user memories exist.

**Neutral**

- `@cf/qwen/qwen3-embedding-0.6b` accepts an optional `instruction`/`queries`/`documents` distinction for asymmetric query-vs-document retrieval; brainfog does not use this distinction yet and continues to call the model with `{ text }` as before. Adopting it would be a future refinement to `recall` quality, not part of this ADR.
- A future model/dimension change would follow this same pattern (new ADR, recreate index and metadata indexes, re-embed or clear data) — ADR-005's original Neutral consequence about model changes still holds for any model after this one.

## Alternatives Considered

- **`@cf/baai/embeddinggemma-300m`** (768 dimensions, 512 tokens, multilingual): rejected — same dimension as the current model, so it would avoid a Vectorize index recreation, but it gives no material improvement to brainfog's cost or context-window constraints and doesn't address the reason for switching now.
- **Keep `@cf/baai/bge-base-en-v1.5`**: rejected — `qwen3-embedding-0.6b` is materially cheaper and supports much longer inputs within the same Cloudflare-only architecture (ADR-001, ADR-005), and switching now, while only test data exists, avoids a costlier re-embedding migration once real user data accumulates.
- **Re-embed existing rows into the new 1024-dimension index instead of clearing D1**: rejected for this migration — writing a one-off re-embedding script for ~20 rows of test data has no lasting value; clearing the test data is simpler and was explicitly authorized for this dataset. A rebuild-from-D1 tool (`ARCHITECTURE.md` invariant 3) remains the right approach for a future model migration once real data exists.
