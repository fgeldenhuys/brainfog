# Tasks (PBIs)

This directory holds **Product Backlog Items (PBIs)** — transient, single-purpose units of execution. A PBI is not a spec: it directs implementation of (a slice of) exactly one `specs/<feature>/spec.md`, and it is removed once its work has landed and been verified.

## Naming

`PBI-NNN-short-kebab-title.md`, where `NNN` is a zero-padded, monotonically increasing number (`PBI-001`, `PBI-002`, ...). Numbers are never reused.

## Lifecycle

1. **Open** — a PBI is created (see `.agents/skills/open-pbi.md`) pointing at exactly one spec under `specs/`. It states what slice of that spec's Definition Of Done it covers.
2. **Execute** — an implementor works the PBI, following its Directive/Scope and respecting its Intent Preservation notes.
3. **Verify** — the PBI's Verification section is run; evidence is attached or referenced in the close-out.
4. **Close** — once verification passes and the relevant spec checkboxes are satisfied, the PBI is closed (see `.agents/skills/close-pbi.md`) and removed from `tasks/`. The spec and ADRs remain; the PBI does not.

## PBI Template

```markdown
# PBI-NNN: <Short Title>

## Directive

<One or two sentences: what to build or change, stated as an instruction.>

## Scope

- Spec: `specs/<feature>/spec.md`
- Covers DoD items: <list the checklist items from the spec this PBI is responsible for>
- Out of scope: <anything explicitly NOT covered, to prevent scope creep>

## Dependencies

- <Other PBIs, ADRs, or external setup this PBI requires before it can start>

## Context

<Background needed to do this work well: relevant ADRs, prior decisions, gotchas, links to `VISION.md`/`ARCHITECTURE.md` sections.>

## Intent Preservation

<Constraints that must survive implementation even if the implementor has to make judgment calls — invariants, naming, security/auth requirements, things that are easy to accidentally simplify away.>

## Verification

<How to prove this PBI is done. Concrete commands and expected evidence — see "Evidence Types" below.>

## Refinement Protocol

<What to do if, during implementation, the PBI's directive turns out to be wrong, ambiguous, or in conflict with the spec/ADRs — e.g. pause and ask, or note the discrepancy and proceed with the spec as authority.>
```

## Evidence Types

When a PBI's Verification section is run, evidence should be one or more of:

- **Vitest unit evidence** — `pnpm test` output (or a filtered run) showing new/changed tests passing.
- **Miniflare Worker test evidence** — `pnpm test` output for tests run under `@cloudflare/vitest-pool-workers`, exercising Worker bindings (D1, Vectorize, Workers AI) against local emulation.
- **Playwright web E2E evidence** — `pnpm test:e2e` output showing the relevant browser scenario passing.
- **Drizzle/D1 migration check** — `pnpm db:migrate` (or drizzle-kit's check/diff command) output showing the migration applies cleanly with no drift.
- **Generated report** — output of `pnpm check`, `pnpm typecheck`, `pnpm build`, or a Wrangler dry-run/deploy preview.
- **Reviewable artifact** — a diff, screenshot, or rendered page output a human can review directly (e.g. for the web UI).

## Conventions

- A PBI references exactly one spec. If work spans multiple specs, open multiple PBIs.
- A PBI does not redefine the spec's Contract — it only states which part it executes and any implementation-specific context.
- Keep PBIs small enough to verify in one pass. If a PBI grows too large during execution, split it rather than letting scope creep.
- PBIs are not a history log — once closed, the work they describe is reflected in the code, the spec's checked-off DoD items, and (if relevant) git history. Do not keep closed PBIs around "for the record".
