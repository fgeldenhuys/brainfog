---
name: write-adr
description: Use when an architecture decision needs to be recorded as an ADR under docs/adrs/.
---

# Skill: Write An ADR

Use this when a decision needs to be recorded as an Architecture Decision Record under `docs/adrs/`. Delegate ADR writing to `@architect`.

## Naming

`ADR-NNN-short-kebab-title.md`, where `NNN` is the next number after the highest existing ADR. Numbers are never reused, even if an ADR is later superseded.

## Template

```markdown
# ADR-NNN: <Decision summary>

## Status

<Proposed | Accepted | Deprecated | Superseded by ADR-MMM> - <YYYY-MM-DD>

## Context

<What forces/requirements/constraints led to this decision being needed.>

## Decision

<The decision itself, stated plainly - "We will ...".>

## Consequences

**Positive**
- ...

**Negative**
- ...

**Neutral**
- ...

## Alternatives Considered

- **<Alternative>:** rejected because <specific reason>.
- **<Alternative>:** rejected because <specific reason>.
```

## Rules

- An Accepted ADR's `## Decision` and `## Status` are immutable. If a decision changes, write a new ADR that supersedes the old one, and update the old ADR's `## Status` to `Superseded by ADR-MMM`.
- Every alternative in "Alternatives Considered" needs a specific reason, not "didn't fit". Make it specific enough that someone re-litigating the decision later can see what would have to change for the alternative to become the right choice.
- Cross-reference: if the decision affects an invariant or boundary in `ARCHITECTURE.md`, update `ARCHITECTURE.md` in the same change.
- Use today's date in `## Status`.
