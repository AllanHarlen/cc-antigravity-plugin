---
description: Invoke the shared Antigravity (AGY) bridge for long-context code exploration, analysis, and documentation generation
allowed-tools: Bash, Glob, Read
argument-hint: "[--model name] [--dirs path,...] [--add-dir path] [--files pattern,...] [--continue] [--conversation id] [--timeout duration] <task>"
---

# /cc-antigravity-plugin:antigravity Command

Use the shared Antigravity bridge for long-context code exploration,
architecture review, documentation synthesis, and structured data analysis.
The bridge collects optional local context, maps supported runtime flags to AGY,
and makes one deterministic CLI call.

## Usage

```bash
/cc-antigravity-plugin:antigravity <task>
/cc-antigravity-plugin:antigravity --dirs <path,...> <task>
/cc-antigravity-plugin:antigravity --files <pattern,...> <task>
/cc-antigravity-plugin:antigravity --add-dir <path> <task>
```

## Arguments

| Argument | Description | Example |
|----------|-------------|---------|
| `--model <name>` | Temporarily set the AGY model for this call | `--model gemini-2.5-flash` |
| `--dirs <paths>` | Recursively inline directories into the bridge prompt | `--dirs src,docs,data` |
| `--add-dir <path>` | Add a directory to AGY's native workspace support. Repeatable | `--add-dir src` |
| `--files <pattern,...>` | Inline matching files into the bridge prompt | `--files "schemas/**/*.json,data/**/*.csv"` |
| `--continue`, `-c` | Continue the most recent AGY conversation | `--continue` |
| `--conversation <id>` | Resume a specific AGY conversation | `--conversation abc123` |
| `--timeout <duration>` | Forward `--print-timeout` to AGY | `--timeout 3m` |
| `--sandbox` | Enable AGY sandbox mode | `--sandbox` |
| `--skip-permissions` | Forward `--dangerously-skip-permissions` to AGY | `--skip-permissions` |
| `<task>` | Analysis task or question | required |

## Execution Instructions

Parse arguments into bridge flags, then execute through the shared bridge:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/antigravity-bridge.js" [options] -- "<TASK>"
```

Guidance:
- Use `--dirs` for broad module or service areas that should be inlined.
- Use `--files` for precise globs or structured data slices.
- Use `--add-dir` when AGY should access the directory through its own workspace mechanism.
- Use `--model` for per-call model selection; the bridge restores AGY settings afterward.
- Keep the task direct, scoped, and explicit about the output shape.
- `--format json` is not supported; AGY headless mode returns text.

## Examples

### Simple query
```bash
/cc-antigravity-plugin:antigravity what is 2+2
```

### Architecture review
```bash
/cc-antigravity-plugin:antigravity --dirs src,docs explain the architecture of this codebase
```

### Native AGY workspace
```bash
/cc-antigravity-plugin:antigravity --add-dir src analyze the refactor impact of the auth module
```

### Resume work with a faster model
```bash
/cc-antigravity-plugin:antigravity --model gemini-2.5-flash --continue summarize the next migration steps
```

## Error Handling

| Error | Solution |
|-------|----------|
| Authentication error | Launch `agy` once interactively and sign in. Use `/logout` inside the TUI to clear cached credentials. |
| AGY missing on PATH | macOS/Linux: `curl -fsSL https://antigravity.google/cli/install.sh \| bash`  Windows: `irm https://antigravity.google/cli/install.ps1 \| iex` |
| Model override failed | Set the model in AGY with `/model`, then retry without `--model`. |
| Token limit exceeded | Narrow the inlined scope with `--files` or fewer `--dirs`. |
| Timeout | Increase `--timeout`, reduce the context set, or tighten the task. |
