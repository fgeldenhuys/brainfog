# Skill: Open A PBI

Use this when a spec (or a slice of one) is ready to be implemented.

## Steps

1. Pick the spec: `specs/<feature>/spec.md`. Identify which Definition Of Done items this PBI will cover — a PBI can cover all of a spec's DoD (if it's the first/only PBI for that spec) or a subset (if work is being split).
2. Determine the next PBI number: one higher than the highest existing `tasks/PBI-NNN-*.md` (if `tasks/` has none yet, start at `PBI-001`).
3. Create `tasks/PBI-NNN-short-kebab-title.md` using the template in `tasks/README.md`, filling in:
   - **Directive** — what to build, as an instruction.
   - **Scope** — the spec, the DoD items covered, and what's explicitly out of scope.
   - **Dependencies** — other PBIs or ADRs this depends on.
   - **Context** — background the implementor needs (relevant ADRs, prior decisions, gotchas).
   - **Intent Preservation** — invariants/constraints that are easy to lose during implementation.
   - **Verification** — concrete commands and expected evidence (see `tasks/README.md`'s Evidence Types).
   - **Refinement Protocol** — what to do if the directive conflicts with the spec/ADRs during implementation.
4. Hand off to the implementor.

## Rules

- A PBI references exactly one spec. If the work spans multiple specs, open multiple PBIs.
- Don't redefine the spec's Contract inside the PBI — reference it.
