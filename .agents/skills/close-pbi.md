---
name: close-pbi
description: Use when finishing a brainfog PBI: verify implementation against the task and spec, update completion evidence, and prepare closeout without pushing unless asked. Works for OpenCode and Claude Code.
---

# Skill: close-pbi

Use when closing an implemented `tasks/PBI-NNN-*.md`.

## Required Reading

1. `AGENTS.md`
2. The target `tasks/PBI-NNN-*.md`
3. The referenced `specs/<feature>/spec.md`
4. `ARCHITECTURE.md` and any ADRs named by the spec or PBI

## Workflow

1. Identify the PBI and referenced spec.
2. Preflight the worktree with `git status --short --branch`; separate intended PBI changes from unrelated or user-owned changes.
3. Confirm changed files are inside the PBI Scope. If scope expanded, stop and report the mismatch.
4. If the referenced spec Contract changed, confirm the PBI Refinement Protocol was followed and flag the change for human review.
5. Run verification: `pnpm check`, `pnpm typecheck`, and `pnpm test`, plus any PBI-specific gates such as `pnpm test:e2e`, `pnpm db:migrate`, or `pnpm build`.
6. Update completion evidence according to the PBI/spec convention: mark only evidenced DoD checkboxes complete, record exact commands and results, and preserve useful implementation context.
7. If the repo convention for this PBI is to delete the task after closure, delete only after the spec and completion evidence fully preserve the outcome.
8. Prepare a closeout summary with files changed, commands run, issue/PR references if present, remaining risks, and required human review flags.
9. Commit, push, deploy, or close GitHub issues only if the user explicitly requested that external action in this turn.

## Rules

1. Verification evidence is mandatory. Do not mark a PBI complete based on intent.
2. Do not close a PBI with failed required gates.
3. Do not silently close a PBI with unresolved Contract, schema, dependency, auth, provenance, Cloudflare binding, or scope concerns.
4. Do not push, deploy, or close externally visible GitHub state unless explicitly requested.
5. Completion evidence must cover brainfog invariants: authenticated `/mcp` and `/api/v1/*` paths, provenance on memory writes, D1 canonical storage, Vectorize rebuildability, and no committed secrets where relevant.
