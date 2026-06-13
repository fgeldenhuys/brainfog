# PBI-003: Agent Prompts

## Directive

Add an MCP `prompts` capability to `BrainfogMCP` (`/mcp`) providing `recall-context` and `save-session-notes` prompts that guide connected agents to recall relevant memory at the start of a session and persist durable facts, thoughts, and tasks before it ends, per `specs/agent-prompts/spec.md`.

## Scope

- Spec: `specs/agent-prompts/spec.md`
- Covers DoD items: all items in `specs/agent-prompts/spec.md`'s Definition Of Done.
- Out of scope:
  - New `/api/v1/*` routes or web UI changes.
  - New D1 tables/columns or Vectorize changes.
  - Additional prompts beyond `recall-context` and `save-session-notes`.
  - Distributable Claude Code/OpenCode skill files (see ADR-009's alternatives).

## Dependencies

- ADR-003 (remote MCP server) and ADR-009 (agent guidance via MCP prompts) are Accepted and binding.
- `specs/memory-model/spec.md` (PBI-002) provides the `recall`, `record_fact`, `remember`, and `create_task` tools these prompts reference by name.
- No new top-level npm dependency is authorized — `@modelcontextprotocol/sdk`'s `McpServer.prompt(...)` is already available via existing dependencies.

## Context

`apps/worker/src/mcp/index.ts` currently registers the existing MCP tools, including `ping` plus 16 memory-model tools, via a small `register` helper (name, description, Zod schema, handler) on `this.server`. The MCP SDK's `McpServer` exposes an analogous `.prompt(name, description, argsSchema, callback)` API that returns `{ messages: [...] }`. Prompts added by this PBI return static/templated guidance text only — they do not call into `../memory` or touch D1/Vectorize/R2; the connected agent follows the guidance and calls the named tools itself, so the existing provenance/ownership model (`ARCHITECTURE.md` invariant 4) is untouched.

## Intent Preservation

- Prompts must not read or write memory directly — they only return guidance text naming existing tools (`recall`, `record_fact`, `remember`, `create_task`). All actual memory access continues to flow through the existing owner-scoped tool handlers.
- `/mcp`'s existing connection-level bearer-token auth (unchanged from `specs/platform-setup/spec.md`) must continue to gate `prompts/list` and `prompts/get` exactly as it gates `tools/list` and `tools/call`.
- Do not change the 16 existing memory-model tools' names, schemas, or behavior.
- Prompt names (`recall-context`, `save-session-notes`) and argument names (`topic`, `project_id`) must match `specs/agent-prompts/spec.md` exactly, since MCP clients (Claude Code, OpenCode) surface them directly to users.

## Verification

- `pnpm check && pnpm typecheck && pnpm test` pass.
- `pnpm build` passes.
- Worker tests cover:
  - `prompts/list` over `/mcp` returns `recall-context` and `save-session-notes` with descriptions and SDK-emitted argument metadata/schema, and is rejected without a valid bearer token.
  - `prompts/get` for `recall-context` with and without `topic`/`project_id` returns valid MCP prompt messages (`messages[]` with role/content) naming the `recall` tool and reflecting the given arguments.
  - `prompts/get` for `save-session-notes` with and without `project_id` returns valid MCP prompt messages (`messages[]` with role/content) naming `record_fact`, `remember`, and `create_task` and reflecting project scoping when given.
  - Existing `tools/list` coverage still proves the current `ping` tool and 16 memory-model tools remain registered after prompts are added.

## Refinement Protocol

- If the installed `@modelcontextprotocol/sdk`/`agents` SDK versions do not support the `prompts` capability end-to-end (capability negotiation, `prompts/list`, `prompts/get`) over the `agents` SDK's `McpAgent`, pause and report — a version bump is a dependency change subject to `AGENTS.md`'s ASK rule.
- If useful prompt wording requires calling into the memory service (e.g. to list the user's projects for `project_id` suggestions), pause and update `specs/agent-prompts/spec.md` through review rather than silently expanding scope — this PBI assumes static/templated guidance text is sufficient.

## Ship-PBI Log

- **Iteration 1** (implementor): Registered `recall-context` and `save-session-notes` MCP prompts in `apps/worker/src/mcp/index.ts` (lines 43-119) via `McpServer.prompt(...)`, static/templated guidance text only, no new dependencies. Added 8 Vitest/Miniflare tests in `apps/worker/test/memory.test.ts` (lines 1018-1228) covering `prompts/list` (with/without bearer token), `prompts/get` for both prompts (with and without arguments), and a regression check that `tools/list` still returns `ping` + the 16 memory-model tools.
- **Deterministic gate**: `pnpm check && pnpm typecheck && pnpm test` — pass (30/30 tests, 2 files; `biome check` reports 2 informational config-version notices only). `pnpm build` — pass (`wrangler deploy --dry-run`).
- **Critic review (iteration 1)**: NO BLOCKING ISSUES. Contract fit, test evidence, regression risk, scope drift, intent preservation, refinement protocol, and brainfog invariants (auth parity for `prompts/list`/`prompts/get` vs `tools/list`/`tools/call`, no memory/D1/Vectorize/R2 access from prompt handlers) all pass.
- **Outcome**: Closed after 1 iteration. All DoD items in `specs/agent-prompts/spec.md` checked off.
