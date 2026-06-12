# Product Vision

Brainfog is a shared memory and context layer for AI-assisted work. It exists so that Claude, OpenCode, and the people working with them stop losing context between sessions, tools, and projects.

## Actual Humans

Brainfog is for a small, trusted group of people who work across multiple AI tools and multiple projects, and who want one place where useful context, decisions, and recurring knowledge persist — instead of being re-explained at the start of every new chat.

## Point Of View

"Brain fog" describes the AI-assisted work experience as much as a human one: context evaporates between sessions, agents re-derive things they were already told, and useful decisions get buried in chat history. Brainfog's job is to make memory a first-class, queryable resource that any connected agent can read from and write to.

Brainfog is not a general note-taking app, a project-management tool, or a chat-log archive. It is a deliberately curated memory: agents and users write what is worth remembering, structured enough to be retrieved by meaning later. Per-project ASDLC artifacts (specs, ADRs, PBIs) remain the source of truth for those projects — brainfog complements them with cross-project and cross-session memory, it does not replace them.

## Taste References

Directionally right:

- OB1's "one database, one AI gateway" idea: any agent can plug in without bespoke per-tool integration.
- A good `AGENTS.md`: dense, current, and actually retrieved — not a wiki nobody reads.
- Source-backed, timestamped memory entries with provenance (who/what wrote this, when, in which project).
- Field-notes brevity: a memory is a short, durable fact or decision, not a transcript.

Directionally wrong:
- A firehose of raw chat transcripts.
- Memory that silently goes stale with no way to tell what's current.
- A UI that competes with the agent for the user's attention — the UI is for human review and curation; agents are the primary readers and writers.

## Voice And Language

Brainfog speaks in short, structured, retrievable units: "memory", "recall", "project", "tag", "source". Avoid vague terms like "stuff", "context dump", or "notes about everything". Every stored memory should be able to answer: what is this, where did it come from, when was it written, and how durable/confident is it.

## Decision Heuristics

1. Agents are first-class users; the web UI is for humans to review, correct, and curate what agents wrote.
2. Memories are retrievable by meaning (semantic search) as well as by structure (project, tag, time).
3. Provenance — source agent/tool, project, timestamp — travels with every memory.
4. Prefer a few well-curated memories over many low-signal ones; make staleness visible rather than hiding it.
5. Cross-tool consistency (Claude, OpenCode, and others later) matters more than any single tool's native format.
6. Build for personal/small-group scale first. Do not add multi-tenant or public-signup complexity before it's needed.
7. Brainfog augments per-project ASDLC artifacts; it is not a replacement for a project's own specs, ADRs, or PBIs.

## Product Promise

Brainfog gives Claude, OpenCode, and the people using them a shared, searchable memory: write once, recall anywhere, with enough provenance to trust what comes back.
