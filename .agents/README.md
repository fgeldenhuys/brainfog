# .agents/

This directory holds brainfog's canonical, tool-neutral agent definitions. They are written once here and made available to specific tools (Claude Code, OpenCode) via the mechanisms below — don't edit the per-tool copies directly except where noted.

## Layout

- `personas/<name>.md` — agent persona definitions (architect, implementor, critic, researcher). Each has frontmatter (`name`, `description`, `tools`, `model`) plus working rules, hand-offs, and tone.
- `skills/<name>.md` — ASDLC workflow skills (write-adr, write-spec, open-pbi, close-pbi). Each is a single Markdown file describing a procedure.

## Claude Code

- Personas are exposed as flat symlinks:
  ```sh
  ln -s ../../.agents/personas/<name>.md .claude/agents/<name>.md
  ```
- Skills are exposed as a subdirectory containing a `SKILL.md` symlink (Claude Code's skill format expects `.claude/skills/<name>/SKILL.md`):
  ```sh
  mkdir -p .claude/skills/<name>
  ln -s ../../../.agents/skills/<name>.md .claude/skills/<name>/SKILL.md
  ```

## OpenCode

- Personas are **not** symlinked. OpenCode's agent frontmatter format differs from Claude Code's (no string-form `tools` field; uses `mode: subagent`). Each `.opencode/agents/<name>.md` is a separate file with OpenCode-compatible frontmatter and the persona body copied verbatim from `.agents/personas/<name>.md`. If you change a persona's working rules, hand-offs, or tone, update both files.
- Skills **are** symlinked, same shape as Claude Code:
  ```sh
  mkdir -p .opencode/skills/<name>
  ln -s ../../../.agents/skills/<name>.md .opencode/skills/<name>/SKILL.md
  ```

## Adding A New Persona Or Skill

1. Write the canonical file under `personas/` or `skills/`.
2. Wire it into `.claude/` per the commands above.
3. For personas, also create the OpenCode adapter under `.opencode/agents/` (frontmatter differs; body matches). For skills, symlink as above.
4. If the persona/skill should be invocable as a subagent from `opencode.json`, add or update its entry there.
