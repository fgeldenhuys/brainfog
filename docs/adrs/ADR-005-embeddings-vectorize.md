# ADR-005: Workers AI Embeddings + Vectorize For Semantic Recall

## Status

Accepted — 2026-06-12. Embedding model and dimension choice superseded by ADR-010 — 2026-06-14 (the architecture decision below — Workers AI embeddings + Vectorize for semantic recall, D1 canonical/Vectorize derived — remains in effect).

## Context

Brainfog's core value is recalling memories by meaning, not only by exact keyword match (`VISION.md`). Cloudflare provides Workers AI embedding models and Vectorize, a vector database that binds directly to Workers (ADR-001).

## Decision

We will generate an embedding via a Workers AI embedding model (e.g. `@cf/baai/bge-base-en-v1.5`) on every memory write, and upsert it into a Vectorize index keyed by the D1 memory row id. Recall/search tools query Vectorize for nearest neighbors and then fetch the corresponding D1 rows for content and metadata. D1 remains the source of truth (`ARCHITECTURE.md` invariants 2-3): Vectorize is a derived, rebuildable index, and semantic search falls back to D1 keyword/tag search if Vectorize is unavailable or out of sync.

## Consequences

**Positive**
- Semantic recall works using bindings already in the deployment surface — no external embeddings API or key.
- Vectorize scales independently of D1.
- The index can be rebuilt from D1 at any time.

**Negative**
- Every write incurs an additional Workers AI call, adding latency and a quota dimension.
- Vectorize is eventually consistent, so a memory may briefly be unsearchable by meaning immediately after write.
- Upgrading the embedding model requires re-embedding existing memories — a future maintenance task, not yet specced.

**Neutral**
- Embedding dimensionality is fixed by the chosen model and must match the Vectorize index configuration. Changing models implies a new index or a migration, to be handled by a future ADR if it happens.

## Alternatives Considered

- **External embeddings API (OpenAI, Anthropic, etc.) with a self-hosted vector database:** rejected because it adds an external API key/vendor and a database to operate, contradicting ADR-001's Cloudflare-only surface.
- **D1 full-text search (FTS5) only, no embeddings:** rejected as the sole mechanism for v1 — keyword search alone misses "recall by meaning". FTS5 remains a useful fallback and complement, not a replacement.
- **Defer AI/embeddings to a later ADR:** rejected — embeddings and the write-path hook are part of the platform baseline from the start, even before a rich recall UI exists, per the project decision made during initial setup.
