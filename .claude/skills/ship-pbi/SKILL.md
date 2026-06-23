---
name: ship-pbi
description: Implement a brainfog PBI end-to-end using subagents: Implementor writes code from a detailed plan, Critic reviews, loop repeats until green, then close-pbi verifies and closes the task.
---

# Skill: ship-pbi

Orchestrates the full PBI lifecycle: plan -> implement -> deterministic gates -> probabilistic review -> loop until green -> close.

## Inputs

The user provides either:

- A PBI number: `ship-pbi PBI-002` resolves `tasks/PBI-002-*.md`
- A PBI file path: `ship-pbi tasks/PBI-002-memory-model.md`

## Workflow

### Step 0 - Resolve The PBI

Find the target `tasks/PBI-NNN-*.md`. Read it. Confirm:

- It has a `Scope` section.
- It references exactly one `specs/<feature>/spec.md`.
- It is not already complete.

If any check fails, stop and report before spawning any agent.

### Step 1 - Build Or Confirm The Implementation Plan

Before spawning `@implementor`, ensure there is a detailed implementation plan. The plan must include:

- PBI path and referenced spec path.
- DoD items or scenarios being implemented.
- Files in scope and files explicitly out of scope.
- Ordered implementation steps.
- Acceptance criteria for each step.
- Tests and verification commands.
- Risks, invariants, and Intent Preservation items to protect.

If the PBI does not already contain enough detail, write this plan yourself from the PBI, spec, `AGENTS.md`, `ARCHITECTURE.md`, and relevant ADRs before spawning an agent.

For very complex work, break the plan into multiple bounded implementation steps. Spawn `@implementor` separately for each step or coherent group, then integrate and verify before continuing.

### Step 2 - Implement (`@implementor` Subagent)

Spawn `@implementor` with:

- The full path to the PBI file.
- The referenced spec path.
- The detailed plan from Step 1.
- Instruction to read `AGENTS.md`, `ARCHITECTURE.md`, the referenced spec, and the PBI's `Intent Preservation` section before touching any file.
- Instruction to edit only files inside the PBI Scope.
- Instruction to stop if the plan is incomplete, conflicts with the spec or ADRs, or requires scope expansion.
- Instruction to run `pnpm check && pnpm typecheck && pnpm test` plus PBI-specific gates and report results.
- Instruction to produce a hand-off summary listing DoD items, passing tests, and any spec-refinement notes.

Wait for the implementor to finish.

### Step 3 - Deterministic Gate

Run gates directly, not via subagent:

```bash
pnpm check && pnpm typecheck && pnpm test
```

If gates fail and the implementor already tried to fix them, treat this as a Critic iteration failure. Otherwise give the implementor one more pass with a detailed fix plan based on the gate output before counting.

### Step 4 - Probabilistic Review (`@critic` Subagent)

Spawn `@critic` with:

- The full path to the PBI file.
- The referenced spec path.
- Instruction to run `git diff main -- .` and review only files inside the PBI Scope.
- Instruction to produce the standard Critic report: Contract fit, Test evidence, Regression risk, Scope drift, Intent preservation, Refinement protocol, and brainfog invariants.

Wait for the Critic report.

### Step 5 - Evaluate Critic Report

Parse the Critic output for blocking issues:

- Any DoD item marked `x`, `✗`, or `missing`.
- Any Scope drift finding.
- Any Intent preservation risk.
- Any violation of `ARCHITECTURE.md` invariants, especially auth, provenance, D1 canonical storage, Vectorize rebuildability, or secret handling.

If no blocking issues exist, proceed to Step 5.

If blocking issues exist and iterations < 3:

- Spawn `@implementor` again.
- Pass the Critic's full report verbatim.
- Provide a detailed fix plan with file scope, expected behavior, acceptance criteria, and verification.
- Instruct it to address only flagged items without touching files outside Scope.
- Instruct it to re-run gates before handing off.
- Return to Step 3.

If blocking issues persist after 3 iterations:

- Stop and surface the Critic's last report in full.
- Ask the user whether to retry once, skip findings and close anyway, or abandon.
- Do not push or close until the user responds.

### Step 6 - Close (`close-pbi` Skill)

Invoke the `close-pbi` skill. It will verify the implementation, update completion evidence or closeout state, and avoid external push/deploy/issue-close actions unless explicitly requested.

## Iteration Budget

Default: 3 implementor passes before pausing for human input.

One pass = implementor runs + deterministic gate + critic runs. A pass where deterministic gates fail before critic runs still counts.

## Rules

1. Never push, deploy, or close external GitHub state unless the user explicitly requested that action.
2. Never spawn a subagent without first reading the PBI yourself.
3. Never spawn `@implementor` with vague intent. Provide a detailed plan with scope, acceptance criteria, and verification.
4. Pass the Critic's full report verbatim to the next implementor pass.
5. If implementation requires scope expansion, a Contract change, a new dependency, a new Cloudflare product/binding, or auth/token changes, stop and ask.
6. Do not skip deterministic gates between implementor passes.
7. Record iteration count and each Critic report in a `## Ship-PBI Log` section appended to the PBI file when the run is substantial.
