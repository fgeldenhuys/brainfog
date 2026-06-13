# Spec: Agent Prompts

## Blueprint

### Context

This spec adds reusable, named MCP prompt templates to brainfog's `/mcp` server (ADR-003), giving connected agents (Claude, OpenCode) built-in guidance on when to use brainfog's memory tools (`specs/memory-model/spec.md`). Per `VISION.md`, agents are the primary readers and writers of brainfog memory, but the 16 memory-model tools require an agent to already know to call `recall` before answering, or `record_fact`/`remember`/`create_task` before a session ends. ADR-009 records the decision to deliver this guidance as MCP prompts on the existing server rather than as distributable client-side skill files.

PBI-003 (`tasks/PBI-003-agent-prompts.md`) implements this spec.

**Out of scope for this spec** (noted so future specs know where to extend, not because they're forgotten): additional prompts beyond the two below, prompts that themselves call into the memory service (these return guidance text only), and any REST or web UI surface for prompts.

### Architecture

- **API Contracts**:

  MCP prompts exposed under `/mcp` (extending `BrainfogMCP`, ADR-003), gated by the same connection-level bearer-token auth (ADR-004) as the existing tools — `prompts/list` and `prompts/get` are unreachable without a valid token, exactly like `tools/list` and `tools/call`:

  - `recall-context(topic?, project_id?)` → returns a prompt message instructing the calling agent to call the `recall` tool (with `query` derived from `topic` when given, and `project_id` when given) before proceeding, and to incorporate any returned `thought`, `fact`, or `document_chunk` results into its response. When `topic`/`project_id` are omitted, the message gives the same instruction in general terms (recall anything relevant to the current conversation).
  - `save-session-notes(project_id?)` → returns a prompt message instructing the agent to review the session for durable content and persist it before finishing: confirmed facts or decisions via `record_fact` (with citations/confidence), noteworthy observations or ideas via `remember`, and follow-up work via `create_task` — scoped to `project_id` when given. The message reiterates `VISION.md`'s "few well-curated memories over many low-signal ones" heuristic: only durable, recallable content should be stored, not a transcript.

  No new `/api/v1/*` routes — prompts are an MCP-only capability; the web UI remains for human review/curation (`ARCHITECTURE.md` boundaries), not agent workflows.

- **Data Models**: None. Prompts return static/templated text and do not read or write D1, Vectorize, or R2.

- **Dependencies**: None new. `@modelcontextprotocol/sdk`'s `McpServer.prompt(...)` and the `agents` SDK's `McpAgent` already support the MCP `prompts` capability (ADR-003's existing dependencies).

- **Constraints**:
  - Prompts must not read or write memory directly — they only return guidance text naming existing tools (`recall`, `record_fact`, `remember`, `create_task`). All actual memory access continues through the existing owner-scoped tool handlers (`ARCHITECTURE.md` invariant 4 and 5 remain satisfied by the tools, unchanged by this spec).
  - `prompts/list` and `prompts/get` sit behind the same `/mcp` connection-level bearer-token auth as `tools/list`/`tools/call` (invariant 6, ADR-004) — no new unauthenticated surface.
  - Prompt and argument names (`recall-context`, `save-session-notes`, `topic`, `project_id`) are part of this spec's contract because MCP clients (Claude Code, OpenCode) surface them directly to users.

## Contract

### Definition Of Done

- [x] `BrainfogMCP` (`apps/worker/src/mcp/index.ts`) registers an MCP `prompts` capability with exactly two prompts: `recall-context` and `save-session-notes`.
- [x] `recall-context` accepts optional `topic` (string) and `project_id` (string) arguments and returns a prompt message that names the `recall` tool and includes the given `topic`/`project_id` values when provided, with generic-but-actionable wording when both are omitted.
- [x] `save-session-notes` accepts an optional `project_id` (string) argument and returns a prompt message that names the `record_fact`, `remember`, and `create_task` tools, instructs the agent to scope new records to `project_id` when given, and to persist only durable, non-noisy content.
- [x] `prompts/list` over `/mcp` returns both prompts with their descriptions and argument schemas, and is rejected for connections without a valid bearer token, matching the existing `/mcp` connection-level auth (`specs/platform-setup/spec.md`).
- [x] `prompts/get` succeeds for both prompts with no arguments and with arguments supplied.
- [x] `pnpm test` includes Vitest/Miniflare coverage for `prompts/list` and for `prompts/get` (with and without arguments) for both prompts.

### Regression Guardrails

- The existing `tools/list`/`tools/call` behavior for the 16 memory-model tools (`specs/memory-model/spec.md`) is unchanged.
- `/mcp`'s connection-level bearer-token rejection (`specs/platform-setup/spec.md`) continues to pass, including for prompt requests.

### Scenarios

```gherkin
Feature: Agent prompts

  Scenario: Listing prompts requires authentication
    Given the brainfog Worker is running
    When an MCP client connects to /mcp without a valid bearer token and calls "prompts/list"
    Then the connection is rejected with an authentication error

  Scenario: Listing prompts as an authenticated agent
    Given an authenticated user with a valid bearer token
    When they call "prompts/list"
    Then the response includes the "recall-context" and "save-session-notes" prompts with descriptions and argument schemas

  Scenario: recall-context prompts the agent to recall relevant memory
    Given an authenticated user with a valid bearer token
    When they call "prompts/get" for "recall-context" with topic "supplement adherence" and a project_id
    Then the returned prompt message names the "recall" tool
    And references the given topic and project_id

  Scenario: recall-context works with no arguments
    Given an authenticated user with a valid bearer token
    When they call "prompts/get" for "recall-context" with no arguments
    Then the returned prompt message still names the "recall" tool with general guidance

  Scenario: save-session-notes prompts the agent to persist durable memory
    Given an authenticated user with a valid bearer token
    When they call "prompts/get" for "save-session-notes" with a project_id
    Then the returned prompt message names "record_fact", "remember", and "create_task"
    And instructs scoping new records to the given project_id

  Scenario: save-session-notes works with no arguments
    Given an authenticated user with a valid bearer token
    When they call "prompts/get" for "save-session-notes" with no arguments
    Then the returned prompt message still names "record_fact", "remember", and "create_task" without project scoping
```
