---
name: antigravity-integration
description: Use Antigravity CLI (AGY) as an agentic coding assistant for tasks that require creating, editing, or searching files across the codebase — or for large-context analysis that benefits from synthesizing many files in one pass.
allowed-tools: Bash(node *antigravity-bridge.js*), Glob, Read
---

# Antigravity CLI Integration

Antigravity CLI (AGY) runs as an agentic assistant that can create, edit, delete,
and search files using its native tools. Use it when the task spans multiple files,
requires deep codebase understanding, or needs actual file modifications.

## When to Use Antigravity

| Scenario | Mode |
|----------|------|
| Multi-file refactor or code generation | Agentic (default) |
| Create new files or reports | Agentic (default) |
| Whole-codebase architecture review | Read-only (`--read-only`) |
| Cross-file security audit | Read-only (`--read-only`) |
| Refactor impact analysis | Read-only (`--read-only`) |
| Documentation generation | Agentic or read-only |
| Structured data analysis | Read-only (`--read-only`) |

## Default Behavior

By default, the bridge is **agentic**: `--dangerously-skip-permissions` is forwarded
and the current working directory is added to the AGY workspace. AGY will use its
native tools to complete the task without requiring permission confirmations.

Pass `--read-only` to force AGY's native `--mode plan`, disable skip-permissions,
and disable workspace auto-add for tasks that must not modify files.

## Natural Language → Flags Contract

Translate the user's prose into explicit flags before invoking the bridge so the session
runs exactly as requested. The bridge normalizes loose model names defensively, but pass
the canonical id whenever you can.

### Model selection

| User says (natural language) | Pass | Resolves to |
|------------------------------|------|-------------|
| "gemini 3.7 flash", "flash" | `--model gemini-3.7-flash-high` | Newest matching Flash member from `agy models` |
| "gemini 3.7 flash medium" | `--model gemini-3.7-flash-medium` | Gemini 3.7 Flash (Medium), when available |
| "claude opus", "opus" | `--model claude-opus-4-6-thinking` | Claude Opus 4.6 (Thinking) |
| "claude sonnet", "sonnet" | `--model claude-sonnet-4-6` | Claude Sonnet 4.6 (Thinking) |
| "gpt oss" | `--model gpt-oss-120b-medium` | GPT-OSS 120B (Medium) |
| "pick the model for me" | `--model auto` | Flash tier chosen by context size |
| (no model mentioned) | omit `--model` | Preserve the user's current AGY `/model` |

### Mode selection

Default is **agentic**. Choose from the verb in the request:

- develop / create / build / refactor / fix / implement / generate → agentic (default)
- explain / analyze / review / audit / map / plan (no writes) → `--read-only`

### Worked example

*"use o gemini 3.7 flash e desenvolva um front-end"* → model `gemini-3.7-flash-high`, agentic mode:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/antigravity-bridge.js" \
  --model gemini-3.7-flash-high -- "desenvolva um front-end <escopo>"
```

## Host Entry Points

### Claude Code

For coding tasks, use the command/skill directly. Do not spawn
`antigravity-agent` for work that creates, edits, deletes, moves, or formats
files; that agent is read-only analysis only.

```bash
/cc-antigravity-plugin:antigravity <task>
/cc-antigravity-plugin:antigravity --dirs src,docs <task>
/cc-antigravity-plugin:antigravity --files "schemas/**/*.json" <task>
/cc-antigravity-plugin:antigravity --read-only --dirs src <task>
```

### Codex

- Mention the skill explicitly with `$antigravity-integration`.
- Or ask Codex to use the Antigravity integration for a coding or analysis task.

## Shared Runtime Contract

Always prefer the shared bridge script over hand-written `agy` commands:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/antigravity-bridge.js" [options] -- "<task>"
```

The bridge owns argument parsing, dynamic model discovery/cache, native JSON/NDJSON
parsing, defaults (skip-permissions, workspace auto-add, disabled slash commands),
file ingestion, prompt assembly, structured error detection, and AGY invocation.

## Bridge Options

| Option | Behavior |
|--------|----------|
| `--dirs <path,...>` | Inline directories into the bridge prompt |
| `--files <glob,...>` | Inline targeted globs and mixed data formats |
| `--add-dir <path>` | Pass native AGY `--add-dir`; repeatable |
| `--model <name>` | Native AGY slug or alias resolved against `agy models` with a 24-hour cache. Omit to preserve the user's AGY model; `auto` selects a tier from the newest Flash family. |
| `--format <format>` | `text`, `json`, or `stream-json` (default `json`). Stream progress goes to stderr and only the final result to stdout. |
| `--effort <level>` | Forward native `low`, `medium`, or `high` effort only when requested. |
| `--mode <mode>` | Forward native `plan` or `accept-edits`. |
| `--agent <name>` | Select a named custom AGY agent. `--interactive` remains the PTY mode. |
| `--json-schema <value>` | Forward a schema string/path and force JSON format. |
| `--allow-slash-commands` | Opt into slash-command expansion; disabled by default in headless mode. |
| `--parallel` | Allow AGY to fan the task out across native Gemini subagents (`DefineSubagent` / `invoke_subagent` / `ManageSubagents`); AGY chooses the count |
| `--subagent-model <name>` | Model the spawned subagents should use (conveyed via the prompt). Implies `--parallel`; defaults to the main model |
| `--read-only` | Force `--mode plan`, disable skip-permissions/workspace auto-add, and keep slash expansion enabled because AGY 1.1.16 otherwise ignores plan mode |
| `--continue`, `-c` | Continue the most recent AGY conversation |
| `--conversation <id>` | Resume a specific AGY conversation |
| `--timeout <duration>` | Forward `--print-timeout` to AGY (default: 10m) |
| `--output-file <path>` | Write the parsed final AGY response to a file instead of stdout |
| `--output-dir <path>` | Destination directory for generated images (with `--generate-image`) |
| `--interactive` | Use AGY `--prompt-interactive` for human-at-terminal sessions |
| `--sandbox` | Enable AGY sandbox mode |
| `--print-command` | Inspect the resolved AGY command without running it |

## Exit Codes

| Code | Meaning | Action |
|------|---------|--------|
| `0` | Success | — |
| `1` | Generic error | Check stderr |
| `10` | QUOTA_EXAUSTED | Retry later; JSON signal emitted to stdout |
| `11` | AUTH_REQUIRED | Run `agy` once interactively |
| `12` | TIMEOUT | Increase `--timeout` or narrow task scope |
| `13` | AGY_MISSING | Install AGY |

Exit `10` and `11` emit a machine-readable JSON line to stdout:
```json
{"status":"QUOTA_EXAUSTED","reason":"Individual quota reached","conversation_id":"...","usage":{},"retry":"--conversation ..."}
```

## Good Patterns

### Agentic coding

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/antigravity-bridge.js" \
  "Refactor the auth module to async/await. Update all callers. Report changed files."
```

### Create a file

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/antigravity-bridge.js" \
  "Create relatorio-impostos.html with a full HTML tax report from data/impostos.json."
```

### Parallel subagents (native Gemini fan-out)

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/antigravity-bridge.js" --parallel \
  --format stream-json --subagent-model gemini-3.7-flash-medium \
  "Create two HTML reports in relatorio/: EV taxes and combustion-car taxes in Brazil."
```

AGY decomposes independent subparts and runs them concurrently through its native subagent
tools, then aggregates the outputs. Best for multi-deliverable tasks with independent outputs.

### Read-only architecture

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/antigravity-bridge.js" --read-only --dirs src,docs \
  "Explain the architecture and cite the key files."
```

### Refactor impact (read-only)

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/antigravity-bridge.js" --read-only --add-dir src --continue \
  "Analyze the impact of refactoring the auth module. Include affected files and migration steps."
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Authentication error | Launch `agy` once interactively and sign in. |
| AGY missing on PATH | macOS/Linux: `curl -fsSL https://antigravity.google/cli/install.sh \| bash`  Windows: `irm https://antigravity.google/cli/install.ps1 \| iex` |
| QUOTA_EXAUSTED (exit 10) | Wait for quota reset; use `--continue` to resume later with a narrower scope. |
| TIMEOUT (exit 12) | Increase `--timeout 15m` or split the task into smaller steps. |
