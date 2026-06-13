---
name: ship-pbi
description: Implement a brainfog PBI end-to-end using subagents: pbi-implementor writes code, critic reviews, apply-critic-review fixes findings, loop repeats until green, then close-pbi verifies and closes the task.
---

# Skill: ship-pbi

Orchestrates the full PBI lifecycle in OpenCode: implement -> deterministic gates -> probabilistic review -> fix findings -> repeat until green -> close.

## Agents Used

| Role | Agent | Model |
|---|---|---|
| Implement | `@pbi-implementor` (delegates bounded tasks to `@planned-implementor`) | default unless configured |
| Review | `@critic` | configured critic model |
| Fix findings | `apply-critic-review` skill | via `@planned-implementor` |
| Close | `close-pbi` skill | session model |

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

### Step 1 - Implement (`@pbi-implementor`)

Invoke `@pbi-implementor` with:

- The full path to the PBI file.
- Instruction to read `AGENTS.md`, `ARCHITECTURE.md`, the referenced spec, and the PBI's `Intent Preservation` section before touching any file.
- Instruction to run `pnpm check && pnpm typecheck && pnpm test` plus PBI-specific gates and report results.
- Instruction to produce a hand-off summary listing DoD items, passing tests, and any spec-refinement notes.

Wait for the hand-off summary.

### Step 2 - Deterministic Gate

Run gates directly, not via subagent:

```bash
pnpm check && pnpm typecheck && pnpm test
```

If gates fail and `@pbi-implementor` already attempted to fix them, count this as a loop iteration failure. Otherwise give `@pbi-implementor` one more focused pass with the gate output before counting.

### Step 3 - Probabilistic Review (`@critic`)

Invoke `@critic` with:

- The full path to the PBI file.
- The referenced spec path.
- Instruction to run `git diff main -- .` and review only files inside the PBI Scope.
- Instruction to produce the standard Critic report: Contract fit, Test evidence, Regression risk, Scope drift, Intent preservation, Refinement protocol, and brainfog invariants.

Wait for the Critic report.

### Step 4 - Evaluate Critic Report

Parse the Critic output for blocking issues:

- Any DoD item marked `x`, `✗`, or `missing`.
- Any Scope drift finding.
- Any Intent preservation risk.
- Any violation of `ARCHITECTURE.md` invariants, especially auth, provenance, D1 canonical storage, Vectorize rebuildability, or secret handling.

If no blocking issues exist, proceed to Step 5.

If blocking issues exist and iterations < 3:

- Increment iteration counter.
- Invoke the `apply-critic-review` skill, passing the Critic's full report, the PBI path, and the referenced spec path.
- After `apply-critic-review` completes, return to Step 2.

If blocking issues persist after 3 iterations:

- Stop and surface the Critic's last report in full.
- Ask the user whether to retry once, skip findings and close anyway, or abandon.
- Do not push or close until the user responds.

### Step 5 - Close (`close-pbi` Skill)

Invoke the `close-pbi` skill. It will:

- Verify the implementation against the PBI and spec.
- Mark covered DoD checkboxes complete with evidence when appropriate.
- Update completion evidence or delete the PBI according to the repo's closeout convention.
- Prepare commit/push guidance only when the user explicitly requested that external action.

## Iteration Budget

Default: 3 fix iterations before pausing for human input.

One iteration = `@pbi-implementor` or `apply-critic-review` runs + deterministic gate + `@critic` runs.

## Briefing Templates

When invoking `@pbi-implementor`:

```text
PBI: <path>
Spec: <path>

Read AGENTS.md, ARCHITECTURE.md, the referenced spec, and the PBI's Intent Preservation section first.
Edit only files inside the PBI Scope.
Run pnpm check && pnpm typecheck && pnpm test plus: <PBI-specific gates>.
Report DoD items, passing tests, gate commands and results, spec-refinement notes, and any follow-up PBIs.
```

When invoking `@critic`:

```text
PBI: <path>
Spec: <path>
Diff scope: git diff main -- .

Produce the standard Critic report.
Focus on DoD fit, test evidence, scope drift, intent preservation, and brainfog invariants.
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
Delegate only accepted, well-bounded fixes to @planned-implementor.
Re-run pnpm check && pnpm typecheck && pnpm test after fixes.
```

## Rules

1. Never push, deploy, or close external GitHub state unless the user explicitly requested that action.
2. Read the PBI yourself before spawning any agent.
3. Pass the Critic's full report verbatim to `apply-critic-review`.
4. If implementation requires scope expansion, a Contract change, a new dependency, a new Cloudflare product/binding, or auth/token changes, stop and ask.
5. Do not skip deterministic gates between iterations.
6. Append a `## Ship-PBI Log` section to the PBI file during the run recording iteration count and each Critic report when the run is substantial.
