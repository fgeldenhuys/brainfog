---
name: write-spec
description: Use when starting a new brainfog feature spec under specs/ or adding a major capability to an existing spec.
---

# Skill: Write A Spec

Use this when starting a new feature area under `specs/`, or adding a major capability to an existing one.

## Naming

`specs/<feature-kebab-name>/spec.md`. One directory per feature; the spec file is always named `spec.md`. Supporting design notes for that feature can live alongside it in the same directory.

## Template

Copy `specs/TEMPLATE.md`. A spec has two parts:

- **Blueprint**: Context (why this exists, what depends on it, links to `VISION.md`/`ARCHITECTURE.md`/ADRs) and Architecture (API Contracts, Data Models, Dependencies, Constraints).
- **Contract**: Definition Of Done (a checklist of concrete, checkable outcomes), Regression Guardrails (existing behavior that must not break, and how that's verified), and Scenarios (Gherkin).

## Rules

- The Contract is what PBIs are scoped against and what critics review against. Write DoD items and scenarios precisely enough to verify mechanically with a command, test, or observable response.
- New dependencies, Cloudflare bindings, or paid services named in "Dependencies" that aren't already covered by an ADR need a new ADR before or alongside the spec, per `AGENTS.md`'s ASK rules.
- A spec's Architecture section must not silently contradict `ARCHITECTURE.md`'s invariants or an Accepted ADR. If it needs to, that's a new ADR first.
- Specs are living documents during planning/implementation of the feature, but once DoD items are checked off and the feature has shipped, treat the spec as describing the current system. Update it if the system changes later, the same as any other documentation.
