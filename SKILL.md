---
name: antigravity-integration
description: Use Antigravity CLI (AGY) for long-context codebase exploration, architecture review, refactor impact analysis, documentation synthesis, or structured data analysis when the host should hand off a large cross-file problem instead of solving it file-by-file.
allowed-tools: Bash, Glob, Read
---

# Antigravity CLI Integration

Antigravity CLI (AGY) is the large-context handoff in this repository. Use it
when the task is about the shape of a system, a broad slice of a repo, or a
mixed text dataset that should be synthesized in one pass.

## When to Use Antigravity

| Scenario | Why Antigravity Fits |
|----------|----------------------|
| Whole-codebase architecture | Broad cross-file synthesis |
| Cross-file security review | Traces flows across modules |
| Refactor impact analysis | Finds dependencies and callers |
| Codebase orientation | Produces a high-level map quickly |
| Documentation generation | Synthesizes behavior from many files |
| Structured data review | Reads JSON, YAML, TOML, CSV, Markdown, and code together |

Avoid Antigravity for quick single-file edits, tight interactive debugging, or
narrow tasks with no cross-file context.

## Host Entry Points

### Claude Code

Use the slash command:

```bash
/cc-antigravity-plugin:antigravity <task>
/cc-antigravity-plugin:antigravity --dirs src,docs <task>
/cc-antigravity-plugin:antigravity --files "schemas/**/*.json" <task>
```

Claude can also spawn `antigravity-agent` when the task benefits from a
large-context pass.

### Codex

- Mention the skill explicitly with `$antigravity-integration`.
- Or ask Codex to use the Antigravity integration for a large analysis task.

## Shared Runtime Contract

Always prefer the shared bridge script over hand-written `agy` commands:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/antigravity-bridge.js" [options] -- "<task>"
```

The bridge owns argument parsing, file ingestion, prompt assembly, model
override, conversation flags, and AGY invocation.

## Bridge Options

| Option | Behavior |
|--------|----------|
| `--dirs <path,...>` | Inline directories into the bridge prompt |
| `--files <glob,...>` | Inline targeted globs and mixed data formats |
| `--add-dir <path>` | Pass native AGY `--add-dir`; repeatable |
| `--model <name>` | Temporarily set the AGY model and restore settings after execution |
| `--continue`, `-c` | Continue the most recent AGY conversation |
| `--conversation <id>` | Resume a specific AGY conversation |
| `--timeout <duration>` | Forward `--print-timeout` to AGY |
| `--sandbox` | Enable AGY sandbox mode |
| `--skip-permissions` | Forward AGY `--dangerously-skip-permissions` |
| `--print-command` | Inspect the resolved AGY command without running it |

`--format json` is not supported; AGY headless mode returns text.

## Good Patterns

### Architecture

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/antigravity-bridge.js" --dirs src,docs \
  "Explain the architecture and cite the key files."
```

### Refactor impact

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/antigravity-bridge.js" --add-dir src --continue \
  "Analyze the impact of refactoring the auth module. Include affected files and migration steps."
```

### Structured data

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/antigravity-bridge.js" --files "schemas/**/*.json,data/**/*.csv" \
  "Summarize the data contracts and identify breaking changes."
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Authentication error | Launch `agy` once interactively and sign in. |
| AGY missing on PATH | macOS/Linux: `curl -fsSL https://antigravity.google/cli/install.sh \| bash`  Windows: `irm https://antigravity.google/cli/install.ps1 \| iex` |
| Model override failed | Set the model in AGY with `/model`, then retry without `--model`. |
| Rate limiting | Retry with a narrower task or smaller context set. |
| Token pressure | Reduce the number of inlined files. |
