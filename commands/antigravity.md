---
description: Invoke the Antigravity (AGY) bridge directly as the canonical agentic coding path; creates, edits, and searches files using AGY's native tools
allowed-tools: Bash(node *antigravity-bridge.js*), Glob, Read
argument-hint: "[--model name] [--generate-image] [--parallel] [--subagent-model name] [--dirs path,...] [--add-dir path] [--files pattern,...] [--read-only] [--continue] [--conversation id] [--timeout duration] <task>"
---

# /cc-antigravity-plugin:antigravity Command

Runs an Antigravity CLI (AGY) agentic session to complete coding tasks. AGY receives
the task and uses its native tools (`write_to_file`, `replace_file_content`,
`grep_search`, `run_command`, etc.) to complete the work autonomously.

Use this command directly for any task that creates, edits, deletes, moves, or
formats files. Do not route coding work through `antigravity-agent`; that agent is
read-only and exists only for analysis/planning.

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
| `--parallel` | Allow AGY to fan the task out across multiple native Gemini subagents. AGY decides how many to spawn based on the task's independent subparts. | `--parallel` |
| `--subagent-model <name>` | Model the spawned subagents should use (e.g. cheap Flash subagents under a Pro planner). Implies `--parallel`. Defaults to the main model. | `--subagent-model gemini-3.5-flash-medium` |
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

## Natural Language → Flags Contract

This command is the bridge between the user's natural-language request and AGY's
headless execution. Before invoking the bridge, translate the request into explicit
flags. The goal is that the session runs exactly as the prompt asked — the requested
model, in the right mode.

### Model selection

When the user names a model in prose, map it to a canonical `--model` value. The bridge
also normalizes loose names defensively, but pass the canonical id whenever you can.

| User says (natural language) | Pass | Resolves to |
|------------------------------|------|-------------|
| "use gemini 3.1 pro", "with Pro" | `--model gemini-3.1-pro-high` | Gemini 3.1 Pro (High) |
| "gemini 3.1 pro low", "cheap pro" | `--model gemini-3.1-pro-low` | Gemini 3.1 Pro (Low) |
| "gemini flash", "fast", "flash" | `--model gemini-3.5-flash-medium` | Gemini 3.5 Flash (Medium) |
| "claude opus", "opus" | `--model claude-4.6-opus-thinking` | Claude 4.6 Opus (Thinking) |
| "claude sonnet", "sonnet" | `--model claude-4.6-sonnet-thinking` | Claude 4.6 Sonnet (Thinking) |
| "gpt oss" | `--model gpt-oss-120b-medium` | GPT-OSS 120B (Medium) |
| "pick the model for me" | `--model auto` | Flash tier chosen by context size |
| (no model mentioned) | omit `--model` | User default → `gemini-3.5-flash-medium` |

The bridge writes the resolved model to AGY's `settings.json` before spawning and
restores it afterwards. If a model name is not recognized, the bridge warns on stderr
and passes it through unchanged.

### Mode selection (agentic vs read-only)

The default mode is **agentic** (`--dangerously-skip-permissions` + workspace auto-add).
Choose the mode from the verb in the request:

| Intent in the request | Mode |
|-----------------------|------|
| develop, create, build, write, implement, refactor, fix, edit, generate, format | Agentic (default — do **not** pass `--read-only`) |
| explain, analyze, review, audit, map, understand, trace, plan (no file writes) | `--read-only` |

### Worked example

Request: *"use o gemini 3.1 pro e desenvolva um front-end"*

- Model: "gemini 3.1 pro" → `--model gemini-3.1-pro-high`
- Verb: "desenvolva" (develop) → agentic (default mode, no `--read-only`)

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/antigravity-bridge.js" \
  --model gemini-3.1-pro-high -- "desenvolva um front-end <detalhes do escopo>"
```

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

### Parallel subagents (native Gemini fan-out)
```bash
/cc-antigravity-plugin:antigravity --parallel --subagent-model gemini-3.5-flash-medium \
  create two HTML reports in relatorio/: EV taxes and combustion-car taxes in Brazil
```
AGY decomposes the task and runs the independent reports concurrently via its native
subagent tools, then aggregates the results and reports each subagent's conversation ID.

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
