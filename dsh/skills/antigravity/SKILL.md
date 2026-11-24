---
name: antigravity
description: >
  Delegate coding work to Antigravity CLI (AGY) through the Node bridge. Use when
  the task creates, edits, deletes, moves, or formats files, or needs a
  large-context codebase pass. Defaults to Gemini 4 Hydrogen with xhigh reasoning.
whenToUse: >
  Implementation, refactoring, fixes, file generation, and multi-file changes.
  Use --read-only for analysis, review, or architecture mapping.
user-invocable: true
---

# Antigravity CLI (DeepSeek Harness variant)

This skill targets DeepSeek Harness (`dsh`). The Claude Code variant lives in the
`cc-antigravity-plugin` at `skills/SKILL.md` and keeps `Skill(...)` /
`/cc-antigravity-plugin:antigravity`; do not use those entry points here. DSH does
not load Claude Code commands, subagents, or `CLAUDE_PLUGIN_OPTION_*` defaults.

## Prerequisites

- `agy` on PATH and signed in (`agy --version`).
- Node >= 22.
- Bridge installed at `C:/Users/richa/.dsh/tools/cc-antigravity/scripts/antigravity-bridge.js`.
  Re-copy it after a plugin update.

## Default invocation

Use DSH's shell tool:

```bash
node "C:/Users/richa/.dsh/tools/cc-antigravity/scripts/antigravity-bridge.js" \
  --model gemini-4-hydrogen --effort xhigh \
  --format stream-json --timeout 30m \
  -- "<task>"
```

- Pass `--model` and `--effort` explicitly: DSH does not inject the plugin's userConfig.
- `--format stream-json` streams live progress to stderr and the final answer to stdout.
- The bridge renders AGY 1.5 events one line per action: `[agy] tool write_file {…}`
  per tool call (ACTIVE only — no duplicate DONE line), `[agy] subagent started: <role>` /
  `[agy] subagent done: <role> (<id>) (12s)`, `[agy] 🧠 turn done (15s) · 1292 thinking tokens`
  after a slow or thinking-heavy turn, and `[agy] … still working` every 30s of stream
  silence so a long quiet thinking turn reads as alive, not hung. Model thinking text
  itself never enters the headless event stream — only per-turn token/duration counts.
- `--timeout 30m` matches the plugin default; use `--timeout 45m` for test-heavy tasks.
- The bridge adds the current workspace via `--add-dir` unless `--read-only`.
- Add `--add-dir "D:/path"` for extra directories. Under `--read-only` AGY 1.5 has no
  directory-listing tool; to inspect a directory's contents pass `--dirs <path>` (inlined)
  instead of `--add-dir`.

## Mode selection

| Intent | Flags |
|---|---|
| develop / create / build / refactor / fix / implement / generate | default (agentic) |
| explain / analyze / review / audit / map / plan (no writes) | `--read-only` |
| independent front-end components or screens | `--parallel` (AGY fans out to native subagents) |
| image generation | `--generate-image --output-dir <dir>` |

## Model routing

| Request | Pass |
|---|---|
| default, "hydrogen", "gemini 4 hydrogen" | `--model gemini-4-hydrogen --effort xhigh` |
| "gemini 4 argon" | `--model gemini-4-argon-high` |
| "flash" | `--model gemini-3.8-flash-high` |
| "sonnet" / "opus" | `--model sonnet` / `--model opus` |
| "gpt oss" | `--model gpt-oss-120b-medium` |

AGY has no `extra` effort tier; the highest Hydrogen tier is `xhigh`. Valid
`--effort` values are `low|medium|high|xhigh|max` (model-dependent).

## Exit codes

| Code | Meaning | Action |
|---|---|---|
| 0 | success | — |
| 1 | generic error | read stderr |
| 10 | quota exhausted | wait or switch model |
| 11 | auth required | run `agy` once interactively |
| 12 | timeout | raise `--timeout` or split the task |
| 13 | AGY missing | install AGY |

On timeout, a killed run can be resumed with `--conversation <id>` when the id is
available; otherwise narrow the task and re-run.

## Safety

- Default agentic mode forwards `--dangerously-skip-permissions` to AGY. AGY can
  create/edit/delete files and run commands; DSH's approval covers only the
  bridge invocation, not AGY's internal tools.
- Use `--read-only` for analysis that must not modify files.
- Do not run this skill in a workspace you do not trust with file writes.
