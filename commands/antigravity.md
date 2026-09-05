---
description: Invoke the Antigravity (AGY) bridge directly as the canonical agentic coding path; creates, edits, and searches files using AGY's native tools
allowed-tools: Bash(node *antigravity-bridge.js*), Glob, Read
argument-hint: "[--model name] [--format text|json|stream-json] [--effort low|medium|high] [--mode plan|accept-edits] [--agent name] [--json-schema value] [--allow-slash-commands] [--generate-image] [--parallel] [--subagent-model name] [--dirs path,...] [--add-dir path] [--files pattern,...] [--read-only] [--interactive] [--continue] [--conversation id] [--timeout duration] <task>"
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
| `--model <name>` | Native AGY model slug or alias. The bridge discovers `agy models` with a 24-hour cache; omit it to preserve the user's AGY `/model`. | `--model gemini-3.8-flash-high` |
| `--format <format>` | Headless output: `text`, `json`, or `stream-json` (default: `json`). Stream progress is written to stderr and only the final result to stdout. | `--format stream-json` |
| `--effort <level>` | Native reasoning effort: `low`, `medium`, or `high`. Only forwarded when explicitly requested. | `--effort high` |
| `--mode <mode>` | Native permission mode: `plan` or `accept-edits`. | `--mode plan` |
| `--agent <name>` | Select a custom AGY agent; this is not an interactive-mode alias. | `--agent code-reviewer` |
| `--json-schema <value>` | Schema string or path for structured output; implies `--format json`. | `--json-schema schema.json` |
| `--allow-slash-commands` | Re-enable slash-command/skill expansion. Headless prompts disable it by default so task text is data. | `--allow-slash-commands` |
| `--generate-image` | Ask AGY to use its `generate_imagem` tool. Image generation does not select a synthetic model slug. | `--generate-image` |
| `--parallel` | Allow AGY to fan the task out across multiple native Gemini subagents. AGY decides how many to spawn based on the task's independent subparts. | `--parallel` |
| `--subagent-model <name>` | Runtime-resolved model hint for spawned subagents. Implies `--parallel`. | `--subagent-model gemini-3.7-flash-medium` |
| `--dirs <paths>` | Recursively inline directories into the bridge prompt | `--dirs src,docs` |
| `--add-dir <path>` | Add a directory to AGY's native workspace. Repeatable | `--add-dir src` |
| `--files <pattern,...>` | Inline matching files into the bridge prompt | `--files "schemas/**/*.json"` |
| `--read-only` | Force native `--mode plan`, disable skip-permissions/workspace auto-add, and keep slash expansion enabled because AGY 1.1.16 otherwise ignores plan mode. | `--read-only` |
| `--continue`, `-c` | Continue the most recent AGY conversation | `--continue` |
| `--conversation <id>` | Resume a specific AGY conversation | `--conversation abc123` |
| `--timeout <duration>` | Forward `--print-timeout` to AGY | `--timeout 10m` |
| `--output-file <path>` | Write the parsed final AGY response to a file instead of stdout. | `--output-file out.txt` |
| `--output-dir <path>` | Destination directory for generated images (used with `--generate-image`) | `--output-dir ./assets` |
| `--interactive` | Use AGY `--prompt-interactive` for a human-at-terminal session | `--interactive` |
| `--sandbox` | Enable AGY sandbox mode | `--sandbox` |
| `<task>` | Coding task or question | required |

## Defaults

- `--dangerously-skip-permissions` is always forwarded (agentic mode)
- The current working directory is added to AGY's workspace via `--add-dir <cwd>`
- Headless mode uses `--output-format json --disable-slash-commands`
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
| "flash" | `--model gemini-3.8-flash-high` | Newest matching Flash member from `agy models` |
| "gemini 3.7 flash" | `--model gemini-3.7-flash-high` | Version pinned; newest tier within that family |
| "gemini 3.7 flash medium" | `--model gemini-3.7-flash-medium` | Gemini 3.7 Flash (Medium), when available |
| "claude opus", "opus" | `--model claude-opus-4-6-thinking` | Claude Opus 4.6 (Thinking) |
| "claude sonnet", "sonnet" | `--model claude-sonnet-4-6` | Claude Sonnet 4.6 (Thinking) |
| "gpt oss" | `--model gpt-oss-120b-medium` | GPT-OSS 120B (Medium) |
| "pick the model for me" | `--model auto` | Flash tier chosen by context size |
| (no model mentioned) | omit `--model` | Preserve the user's current AGY `/model` |

The bridge resolves slugs and display labels against the cached runtime catalog and passes
the selected slug through AGY's native `--model` flag. It never mutates `settings.json`.
Unknown models are omitted with a stderr warning that lists the valid runtime slugs.

### Mode selection (agentic vs read-only)

The default mode is **agentic** (`--dangerously-skip-permissions` + workspace auto-add).
Choose the mode from the verb in the request:

| Intent in the request | Mode |
|-----------------------|------|
| develop, create, build, write, implement, refactor, fix, edit, generate, format | Agentic (default — do **not** pass `--read-only`) |
| explain, analyze, review, audit, map, understand, trace, plan (no file writes) | `--read-only` |

### Worked example

Request: *"use o gemini 3.7 flash e desenvolva um front-end"*

- Model: "gemini 3.7 flash" → latest matching Flash slug (currently `gemini-3.7-flash-high`)
- Verb: "desenvolva" (develop) → agentic (default mode, no `--read-only`)

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/antigravity-bridge.js" \
  --model gemini-3.7-flash-high -- "desenvolva um front-end <detalhes do escopo>"
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
{"status":"QUOTA_EXAUSTED","reason":"Individual quota reached","model":"gemini-3.7-flash-high","conversation_id":"...","usage":{},"retry":"--conversation ..."}
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
/cc-antigravity-plugin:antigravity --format stream-json --parallel --subagent-model gemini-3.7-flash-medium \
  create two HTML reports in relatorio/: EV taxes and combustion-car taxes in Brazil
```
AGY decomposes the task and runs the independent reports concurrently via its native
subagent tools, then aggregates the results and reports each subagent's conversation ID.

### Generate an image (`generate_imagem` tool)
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
