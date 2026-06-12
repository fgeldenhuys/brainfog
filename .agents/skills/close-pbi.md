# Skill: Close A PBI

Use this once a PBI's Verification has passed and its scoped DoD items are satisfied.

## Steps

1. Confirm every command/check in the PBI's Verification section was actually run and passed — re-run anything that was only reported, not verified.
2. In the PBI's spec (`specs/<feature>/spec.md`), check off the Definition Of Done items this PBI covered.
3. If the PBI's Context section noted a follow-up (e.g. updating `AGENTS.md`'s "Current Mode"), do that follow-up now if it's in scope, or open a new PBI for it if it's substantial enough to need its own verification.
4. Summarize what was actually built/changed and which evidence was produced (for the person/agent that asked — this summary doesn't need to live anywhere after it's communicated).
5. Delete `tasks/PBI-NNN-*.md`. The PBI's content is now reflected in the code, the spec's checked DoD items, and git history — keeping the file around duplicates that information and goes stale.

## Rules

- Don't close a PBI with unchecked DoD items it claimed to cover — either finish the work, or edit the PBI's Scope to reflect what was actually covered and open a new PBI for the rest before closing this one.
- If verification revealed the spec itself needs to change, hand off to the architect before closing.
