---
description: Invoke the Antigravity (AGY) bridge as an agentic coding assistant — creates, edits, and searches files autonomously using AGY's native tools
allowed-tools: Bash, Glob, Read
argument-hint: "[--model name] [--generate-image] [--dirs path,...] [--add-dir path] [--files pattern,...] [--read-only] [--continue] [--conversation id] [--timeout duration] <task>"
---

# /cc-antigravity-plugin:antigravity Command

Runs an Antigravity CLI (AGY) agentic session to complete coding tasks. AGY receives
the task and uses its native tools (`write_to_file`, `replace_file_content`,
`grep_search`, `run_command`, etc.) to complete the work autonomously.

By default, the bridge runs with `--dangerously-skip-permissions` and adds the current
working directory to the AGY workspace. Pass `--read-only` for analysis-only tasks.

## Usage

```bash
/cc-antigravity-plugin:antigravity <task>
/cc-antigravity-plugin:antigravity --dirs <path,...> <task>
/cc-antigravity-plugin:antigravity --files <pattern,...> <task>
/cc-antigravity-plugin:antigravity --add-dir <path> <task>
/cc-antigravity-plugin:antigravity --read-only <task>
```

## Arguments

| Argument | Description | Example |
|----------|-------------|---------|
| `--model <name>` | Model to use. Written to AGY's `settings.json` before spawn and restored after. AGY has no `--model` CLI flag. Available: `gemini-3.5-flash-low/medium/high`, `gemini-3.1-pro-low/high`, `claude-4.6-sonnet-thinking`, `claude-4.6-opus-thinking`, `gpt-oss-120b-medium`, `nano-banana` | `--model gemini-3.1-pro-low` |
| `--generate-image` | Generate an image from the task description using AGY's Nano Banana model. Automatically sets `--model nano-banana` unless overridden with `--model`. | `--generate-image` |
| `--dirs <paths>` | Recursively inline directories into the bridge prompt | `--dirs src,docs` |
| `--add-dir <path>` | Add a directory to AGY's native workspace. Repeatable | `--add-dir src` |
| `--files <pattern,...>` | Inline matching files into the bridge prompt | `--files "schemas/**/*.json"` |
| `--read-only` | Disable skip-permissions and workspace auto-add (analysis mode) | `--read-only` |
| `--continue`, `-c` | Continue the most recent AGY conversation | `--continue` |
| `--conversation <id>` | Resume a specific AGY conversation | `--conversation abc123` |
| `--timeout <duration>` | Forward `--print-timeout` to AGY | `--timeout 10m` |
| `--interactive` | Use AGY `--prompt-interactive` for a human-at-terminal session | `--interactive` |
| `--sandbox` | Enable AGY sandbox mode | `--sandbox` |
| `<task>` | Coding task or question | required |

## Defaults

- `--dangerously-skip-permissions` is always forwarded (agentic mode)
- The current working directory is added to AGY's workspace via `--add-dir <cwd>`
- Timeout: 10 minutes (override with `--timeout`)

## Execution Instructions

Parse arguments into bridge flags, then execute through the shared bridge:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/antigravity-bridge.js" [options] -- "<TASK>"
```

Guidance:
- Default invocation is agentic: AGY will create/edit/delete files and run commands.
- Use `--read-only` when the task is pure analysis and should not modify files.
- Use `--dirs` to inline broad module slices into the prompt for context.
- Use `--files` for precise globs or structured data (JSON, CSV, YAML).
- Use `--add-dir` when AGY should access additional directories through its workspace.
- Keep the task direct, scoped, and explicit about the expected output.

## Exit Codes

| Code | Meaning | Action |
|------|---------|--------|
| `0` | Success | — |
| `1` | Generic error | Check stderr |
| `10` | `QUOTA_EXAUSTED` | Retry later or switch model; structured JSON emitted to stdout |
| `11` | `AUTH_REQUIRED` | Run `agy` once interactively to sign in |
| `12` | `TIMEOUT` | Increase `--timeout` or narrow the task scope |
| `13` | `AGY_MISSING` | Install AGY (see below) |

When exit code `10` or `11` is returned, a JSON line is written to stdout:
```json
{"status":"QUOTA_EXAUSTED","reason":"quota or rate limit reached","model":"gemini-3.5-flash-medium"}
```

## Examples

### Coding task (default agentic mode)
```bash
/cc-antigravity-plugin:antigravity refactor the auth module to use async/await throughout
```

### Create a file
```bash
/cc-antigravity-plugin:antigravity create relatorio-impostos.html with a full HTML tax report
```

### Analysis only (read-only)
```bash
/cc-antigravity-plugin:antigravity --read-only --dirs src explain the architecture of this codebase
```

### Inline context + coding
```bash
/cc-antigravity-plugin:antigravity --dirs src,docs add OpenAPI annotations to all Express routes
```

### Continue previous session
```bash
/cc-antigravity-plugin:antigravity --continue fix the failing tests from the previous session
```

### Generate an image (Nano Banana model)
```bash
/cc-antigravity-plugin:antigravity --generate-image a futuristic city skyline at sunset
```

### Generate an image with style context from files
```bash
/cc-antigravity-plugin:antigravity --generate-image --files "brand/style.json" a logo for our product
```

## Error Handling

| Error | Solution |
|-------|----------|
| Authentication error | Launch `agy` once interactively and sign in. Use `/logout` inside the TUI to clear cached credentials. |
| AGY missing on PATH | macOS/Linux: `curl -fsSL https://antigravity.google/cli/install.sh \| bash`  Windows: `irm https://antigravity.google/cli/install.ps1 \| iex` |
| QUOTA_EXAUSTED | Wait for quota reset or use `--continue` to resume with a narrower scope. |
| Timeout | Increase `--timeout 15m`, reduce the task scope, or split into steps. |
