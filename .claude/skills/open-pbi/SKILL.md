---
name: open-pbi
description: Use when a brainfog spec or slice of a spec is ready to become a scoped PBI under tasks/ for implementation.
---

# Skill: Open A PBI

Use this when a spec, or a slice of one, is ready to be implemented.

## Steps

1. Pick the spec: `specs/<feature>/spec.md`. Identify which Definition Of Done items this PBI will cover. A PBI can cover all of a spec's DoD if it is the first or only PBI for that spec, or a subset if work is being split.
2. Determine the next PBI number: one higher than the highest existing `tasks/PBI-NNN-*.md`. If `tasks/` has none yet, start at `PBI-001`.
3. Create `tasks/PBI-NNN-short-kebab-title.md` using the template in `tasks/README.md`, filling in:
   - **Directive**: what to build, as an instruction.
   - **Scope**: the spec, the DoD items covered, and what's explicitly out of scope.
   - **Dependencies**: other PBIs or ADRs this depends on.
   - **Context**: background the implementor needs, including relevant ADRs, prior decisions, and gotchas.
   - **Intent Preservation**: invariants or constraints that are easy to lose during implementation.
   - **Implementation Plan**: detailed enough for `implementor` to execute safely. Include file scope, ordered steps, acceptance criteria, and verification commands. For very complex work, split the plan into multiple bounded implementation steps.
   - **Verification**: concrete commands and expected evidence. See `tasks/README.md`'s Evidence Types.
   - **Refinement Protocol**: what to do if the directive conflicts with the spec or ADRs during implementation.
4. Hand off to `implementor` only after the PBI has a detailed implementation plan and bounded scope.

## Rules

- A PBI references exactly one spec. If the work spans multiple specs, open multiple PBIs.
- Don't redefine the spec's Contract inside the PBI. Reference it.
- Do not hand vague PBIs to `implementor`. Add the missing plan first.
