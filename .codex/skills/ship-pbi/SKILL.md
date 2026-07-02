---
name: ship-pbi
description: Implement a PBI end-to-end using subagents: planned-implementor writes code from a detailed plan, critic reviews, apply-critic-review fixes findings, loop repeats until green, then close-pbi verifies and closes the task.
---

# Skill: ship-pbi

Orchestrates the full PBI lifecycle in Codex: plan -> implement -> deterministic gates -> probabilistic review -> fix findings -> repeat until green -> close.

## Agents Used

| Role | Agent |
|---|---|
| Implement | `@planned-implementor` |
| Review | `@critic` |
| Fix findings | `apply-critic-review` skill, delegating planned fixes to `@planned-implementor` |
| Close | `close-pbi` skill |

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

Before invoking `@planned-implementor`, ensure there is a detailed implementation plan. The plan must include:

- PBI path and referenced spec path.
- DoD items or scenarios being implemented.
- Files in scope and files explicitly out of scope.
- Ordered implementation steps.
- Acceptance criteria for each step.
- Tests and verification commands.
- Risks, invariants, and Intent Preservation items to protect.

If the PBI does not already contain enough detail, write this plan yourself from the PBI, spec, `AGENTS.md`, `ARCHITECTURE.md`, and relevant ADRs before spawning an agent.

For very complex work, break the plan into multiple bounded implementation steps. Invoke `@planned-implementor` separately for each step or coherent group, then integrate and verify before continuing.

### Step 2 - Implement (`@planned-implementor`)

Invoke `@planned-implementor` with:

- The full path to the PBI file.
- The referenced spec path.
- The detailed plan from Step 1.
- Instruction to read `AGENTS.md`, `ARCHITECTURE.md`, the referenced spec, and the PBI's Intent Preservation section before touching any file.
- Instruction to edit only files inside the PBI Scope.
- Instruction to stop if the plan is incomplete, conflicts with the spec or ADRs, or requires scope expansion.
- Instruction to run `pnpm check && pnpm typecheck && pnpm test` plus PBI-specific gates and report results when the step warrants broad verification.
- Instruction to produce a hand-off summary listing DoD items, passing tests, gate commands and results, and any spec-refinement notes.

Wait for the hand-off summary.

### Step 3 - Deterministic Gate

Run gates directly, not via subagent:

```bash
pnpm check && pnpm typecheck && pnpm test
```

If gates fail and `@planned-implementor` already attempted to fix them, count this as a loop iteration failure. Otherwise give `@planned-implementor` one more focused pass with a detailed fix plan based on the gate output before counting.

### Step 4 - Probabilistic Review (`@critic`)

Invoke `@critic` with:

- The full path to the PBI file.
- The referenced spec path.
- Instruction to run `git diff main -- .` and review only files inside the PBI Scope.
- Instruction to produce the standard Critic report: Contract fit, Test evidence, Regression risk, Scope drift, Intent preservation, Refinement protocol, and project invariants.

Wait for the Critic report.

### Step 5 - Evaluate Critic Report

Parse the Critic output for blocking issues:

- Any DoD item marked `x`, `X`, `✗`, or `missing`.
- Any Scope drift finding.
- Any Intent preservation risk.
- Any violation of `ARCHITECTURE.md` invariants, especially auth, OAuth token handling, provenance, D1 canonical structured storage, R2 canonical document-content storage, Vectorize rebuildability, or secret handling.

If no blocking issues exist, proceed to Step 6.

If blocking issues exist and iterations < 2:

- Increment iteration counter.
- Invoke the `apply-critic-review` skill, passing the Critic's full report, the PBI path, and the referenced spec path.
- Ensure every accepted finding has a detailed fix plan before `planned-implementor` is invoked.
- After `apply-critic-review` completes, return to Step 3.

If blocking issues persist after 2 iterations:

- Stop and surface the Critic's last report in full.
- Ask the user whether to retry once, skip findings and close anyway, or abandon.
- Do not push or close until the user responds.

### Step 6 - Close (`close-pbi` Skill)

Invoke the `close-pbi` skill. It will:

- Verify the implementation against the PBI and spec.
- Mark covered DoD checkboxes complete with evidence when appropriate.
- Update completion evidence or delete the PBI according to the repo's closeout convention.
- Prepare commit/push guidance only when the user explicitly requested that external action.

## Iteration Budget

Default: 2 fix iterations before pausing for human input.

One iteration = `@planned-implementor` or `apply-critic-review` runs + deterministic gate + `@critic` runs.

## Briefing Templates

When invoking `@planned-implementor`:

```text
PBI: <path>
Spec: <path>

Detailed plan:
<ordered implementation plan with file scope, acceptance criteria, tests, and verification commands>

Read AGENTS.md, ARCHITECTURE.md, the referenced spec, and the PBI's Intent Preservation section first.
Edit only files inside the PBI Scope.
Stop if the plan is incomplete, unsafe, conflicts with the spec/ADRs, or requires scope expansion.
Run pnpm check && pnpm typecheck && pnpm test plus: <PBI-specific gates> when warranted.
Report DoD items, passing tests, gate commands and results, spec-refinement notes, and any follow-up PBIs.
```

When invoking `@critic`:

```text
PBI: <path>
Spec: <path>
Diff scope: git diff main -- .

Produce the standard Critic report.
Focus on DoD fit, test evidence, scope drift, intent preservation, and project invariants.
Be specific: cite paths and line numbers.
```

When invoking `apply-critic-review`:

```text
PBI: <path>
Spec: <path>
Iteration: N of 3
Critic report:
<paste full report>

Challenge questionable findings with evidence from the PBI, spec, architecture, and code.
For every accepted finding, write a detailed fix plan before invoking @planned-implementor.
Delegate only accepted, well-bounded fixes to @planned-implementor.
For complex work, split fixes into multiple planned implementation steps.
Re-run pnpm check && pnpm typecheck && pnpm test after fixes.
```

## Rules

1. Never push, deploy, or close external GitHub state unless the user explicitly requested that action.
2. Read the PBI yourself before spawning any agent.
3. Never invoke `@planned-implementor` with vague intent. Provide a detailed plan with scope, acceptance criteria, and verification.
4. Pass the Critic's full report verbatim to `apply-critic-review`.
5. If implementation requires scope expansion, a Contract change, a new dependency, a new Cloudflare product/binding, auth/token/OAuth changes, or a new category of personal or sensitive data, stop and ask.
6. Do not skip deterministic gates between iterations.
7. Append a `## Ship-PBI Log` section to the PBI file during the run recording iteration count and each Critic report when the run is substantial.
