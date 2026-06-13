---
name: apply-critic-review
description: Use when applying a Critic review after PBI implementation: assess findings, challenge questionable items, plan fixes, and delegate bounded fixes to planned-implementor.
---

# Apply Critic Review

Use this skill after `critic` has reviewed an implemented PBI and the user wants the findings fixed or processed.

## Goal

Turn a `critic` report into a verified follow-up diff without blindly obeying the review. The review is evidence, not authority. The PBI, referenced spec, `ARCHITECTURE.md`, ADRs, and repository state remain authoritative.

## Workflow

1. Read the active PBI, its referenced `specs/<feature>/spec.md`, `ARCHITECTURE.md`, and the Critic report.
2. Classify each review item as `accept`, `reject`, `needs clarification`, or `already fixed`.
3. For every accepted item, write a concrete fix task with file scope, expected behavior, and verification command or evidence.
4. For every rejected or questionable item, state the concern clearly with evidence from the PBI, spec, code, tests, or architecture docs. Do not implement fixes for rejected findings unless the user confirms.
5. Delegate accepted, well-bounded code changes to the `planned-implementor` subagent. Keep ownership of review interpretation, task sequencing, integration, and final evidence.
6. After delegated fixes return, inspect the diff and run the required verification gates.
7. Summarize which critic findings were fixed, which were rejected or deferred, which commands ran, and any residual risk.

## Review Judgment Rules

1. Do not blindly follow the critic. If a finding conflicts with the spec, PBI scope, architecture invariants, or AGENTS.md boundaries, raise the concern before changing code.
2. Prefer minimal fixes. Address the cited defect directly; avoid opportunistic refactors or broad rewrites.
3. Respect PBI scope. If a valid finding requires files outside scope, surface the scope expansion need rather than silently taking it.
4. Preserve contracts. Do not weaken spec Contract sections, Definition-of-Done items, regression guardrails, provenance requirements, auth requirements, or storage invariants to satisfy a review.
5. Verification is part of the fix. Every accepted finding needs machine-checkable evidence when practical.
6. Escalate ambiguity. If the critic report lacks enough detail to reproduce or verify a finding, ask one focused question or mark the item `needs clarification`.

## Delegation Prompt Shape

When calling `planned-implementor`, pass a bounded prompt with:

- PBI path and spec path.
- Accepted critic finding text.
- Files in scope.
- Exact expected behavior.
- Tests or verification command to run.
- Explicit instruction not to address rejected or unrelated findings.

## Final Response Shape

Return:

1. `Fixed`: accepted findings addressed, with file references.
2. `Not changed`: rejected, deferred, or unclear findings, with rationale.
3. `Verification`: commands run and outcomes.
4. `Residual risk`: anything still requiring human decision or follow-up PBI.
