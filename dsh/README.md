# DeepSeek Harness (dsh) variant

This directory contains the DSH-specific skill for the Antigravity bridge. The
Claude Code plugin keeps its original entry points in `skills/SKILL.md`
(`Skill("cc-antigravity-plugin:antigravity", ...)` and
`/cc-antigravity-plugin:antigravity`). The two variants are intentionally
separate: DSH does not load Claude Code commands or subagents, and Claude Code
does not scan `~/.dsh/skills`.

## Install (Windows)

1. Copy `skills/antigravity/SKILL.md` to
   `%USERPROFILE%\.dsh\skills\antigravity\SKILL.md`.
2. Copy the bridge and its local imports to
   `%USERPROFILE%\.dsh\tools\cc-antigravity\scripts\`:
   - `scripts/antigravity-bridge.js`
   - `scripts/utils.js`
   - `scripts/check-agy.js`
3. Confirm `agy` is on PATH and signed in: `agy --version`.
4. In DSH, invoke `/antigravity <task>` or let the model load the skill.

## Update

Re-copy `scripts/` and `skills/antigravity/SKILL.md` after a plugin update. The
bridge is version-coupled to this skill's flag guidance.

## Optional: SessionStart policy

DSH can run the plugin's command hooks through
`@deepseek-ai/dsh-hooks-claude-code`, but the policy text references Claude Code
entry points. Prefer this skill's own instructions instead.
