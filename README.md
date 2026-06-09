<p align="center">
  <img src="banner.png" alt="cc-antigravity-plugin banner" />
</p>

# cc-antigravity-plugin

A plugin for Claude Code and Codex that integrates the [Antigravity CLI (AGY)](https://antigravity.google) as an agentic coding assistant — creates, edits, searches files, and executes commands autonomously over your codebase.

📖 **Documentation in other languages:**
- [Português (Brazilian Portuguese)](./README.pt-BR.md)

> **Fork:** This plugin is a fork of [gemini-cli-plugin](https://github.com/google-gemini/gemini-cli), originally created by [thepushkarp](https://www.linkedin.com/in/thepushkarp) for process automation with Gemini CLI.

## Overview

AGY is Google's long-context CLI terminal (2M token window). This plugin bridges AGY to Claude Code and Codex via a shared Node.js bridge, exposing AGY as a [tool_use](https://www.anthropic.com/research/tool-use) endpoint that Claude can invoke.

**When to use instead of native Claude Code:**
- Multi-file refactorings needing broad repository context
- Code generation spanning multiple project layers
- Architecture analysis and change impact with complete context
- Tasks benefiting from Gemini Pro deep-reasoning models
- Multiple independent deliverables that can run in parallel via native Gemini subagents (`--parallel`)

### Claude invoking `agy` directly vs via plugin

Claude can call `agy` directly via Bash (`agy --print "task" --dangerously-skip-permissions --add-dir .`) without any intermediary. However, the plugin delivers capabilities that raw `agy` cannot:

| Capability | `agy` direct | Via plugin (bridge) |
|---|---|---|
| Headless model selection | No — lacks `--model` flag | Yes, via `settings.json` patch |
| Guaranteed coding-agent behavior | No — AGY tends to respond in text | Yes — `<constraints>` block instructs use of `write_to_file`, `grep_search`, etc. |
| Structured quota/auth signals | No — free-form text, no exit codes | Exit codes 10/11 + JSON-line parseable |
| Automatic file ingestion | Manual | `--dirs`, `--files` with binary detection and truncation |
| Parallelism via Gemini subagents | Manual | `--parallel` + `--subagent-model` |
| Fallback for 28k char limit (Windows) | Silent breakage | Auto-drop of inline files |
| Auditable logging | No | JSONL in `%LOCALAPPDATA%\agy\cc-plugin-logs\` |
| Process overhead | None | Node.js + ConPTY + version check |
| Visibility of AGY actions | Full — direct output | Black box — Claude doesn't validate before exec |
| Quota dependency | Claude only | Claude + AGY/Gemini |

**Summary:** for automated workflows, skills, and coding tasks where consistent agentic behavior is required, the bridge is the right choice. For simple ad-hoc invocations, raw `agy` suffices.

## Prerequisites

- **Node.js 18+**
- **Antigravity CLI** installed and authenticated

```bash
# macOS / Linux
curl -fsSL https://antigravity.google/cli/install.sh | bash

# Windows PowerShell
irm https://antigravity.google/cli/install.ps1 | iex
```

After installing, run `agy` once to log in and verify it works:

```bash
agy --print "what is 2+2"
```

> The `SessionStart` hook automatically checks if AGY is installed and accessible on each Claude Code session start.

## Installation

### Claude Code (recommended)

**Via CLI (terminal):**

```bash
# Add the GitHub repository as a marketplace source
claude plugin marketplace add AllanHarlen/cc-antigravity-plugin

# Install the plugin
claude plugin install cc-antigravity-plugin@AllanHarlen/cc-antigravity-plugin
```

**Via slash command (inside Claude Code):**

```
/plugin marketplace add AllanHarlen/cc-antigravity-plugin
/plugin install cc-antigravity-plugin@AllanHarlen/cc-antigravity-plugin
```

**To test a local copy of the repository:**

```bash
cc --plugin-dir /path/to/cc-antigravity-plugin
```

### Codex

```bash
git clone https://github.com/AllanHarlen/cc-antigravity-plugin.git \
  ~/.agents/skills/cc-antigravity-plugin
```

Restart Codex after cloning.

## Usage

```bash
# Agentic task — default, creates and edits files in workspace
/cc-antigravity-plugin:antigravity "Refactor the auth module for async/await and update all callers"

# With inline directory context
/cc-antigravity-plugin:antigravity --dirs src,docs "Explain the architecture and cite key files"

# Analysis only, no file modifications
/cc-antigravity-plugin:antigravity --read-only --dirs src "Analyze the impact of removing the cache module"

# Specific model
/cc-antigravity-plugin:antigravity --model gemini-3.1-pro-low "Design the database schema for module X"

# Auto model (selected by inline context size)
/cc-antigravity-plugin:antigravity --model auto --dirs src "Refactor the controllers"

# Parallel subagents — AGY splits task into native concurrent Gemini subagents
/cc-antigravity-plugin:antigravity --parallel "Create two HTML reports in reports/: electric vehicle taxes and ICE vehicle taxes in Brazil"

# Parallel subagents in cheaper model, under a Pro orchestrator
/cc-antigravity-plugin:antigravity --model gemini-3.1-pro-low --subagent-model gemini-3.5-flash-medium "Generate three independent React components: Header, Sidebar, and Footer"

# Resume previous session
/cc-antigravity-plugin:antigravity --continue "Continue from step 3 of the previous refactoring"

# Image generation with Nano Banana
/cc-antigravity-plugin:antigravity --generate-image "a futuristic skyline at sunset, cyberpunk style, purple and orange tones"

# With style context and destination directory
/cc-antigravity-plugin:antigravity --generate-image --files "brand/style.json" --output-dir ./assets "logo following the visual identity guide"
```

In Codex, use the agent via:

```text
@antigravity-agent <task>
```

## Options

| Option | Description |
|---|---|
| `--dirs <path,...>` | Recursively inject directories as inline context in the prompt |
| `--files <glob,...>` | Inject files matching comma-separated globs |
| `--add-dir <path>` | Add directory to AGY's native workspace via `--add-dir`; repeatable |
| `--model <name>` | Model to use; written to `settings.json` before spawn and restored after. See table below. |
| `--parallel` | Allow AGY to split the task among multiple native Gemini subagents (`DefineSubagent` / `invoke_subagent` / `ManageSubagents`). AGY decides how many. Requires TTY or prompt injection. |
| `--subagent-model <name>` | Model for spawned subagents (passed via prompt — AGY has no per-subagent CLI flag). Enables `--parallel` automatically. Default: model of main session. |
| `--read-only` | Disables `--dangerously-skip-permissions` and auto-add of cwd. Use for pure analysis without modifying files. |
| `--continue`, `-c` | Resume the most recent AGY conversation |
| `--conversation <id>` | Resume a specific AGY conversation by ID |
| `--timeout <duration>` | Pass `--print-timeout` to AGY (e.g., `3m`, `300s`). Timer resets per output chunk. |
| `--interactive`, `--agent` | Use `--prompt-interactive` for interactive session (requires TTY) |
| `--sandbox` | Enable AGY sandbox mode |
| `--max-files <n>` | Maximum files injected as inline context. Default: `40` |
| `--max-file-bytes <n>` | Maximum bytes per file. Default: `32768` |
| `--generate-image`, `--generate-imagem` | Generate an image from the description in task using Nano Banana model. Sets `--model nano-banana` automatically. |
| `--output-dir <path>` | Directory where generated images are saved. Default: current directory. |
| `--print-command` | Print the resolved `agy` command without executing |

**Agentic defaults:** by default, `--dangerously-skip-permissions` is passed and cwd is added to AGY's workspace via `--add-dir`. Use `--read-only` to disable.

## Available Models

| Identifier | Recommended for |
|---|---|
| `gemini-3.5-flash-medium` | **Default** — most tasks |
| `gemini-3.5-flash-low` | Simple tasks, faster response |
| `gemini-3.5-flash-high` | Flash with more reasoning effort |
| `gemini-3.1-pro-low` | Deeper reasoning |
| `gemini-3.1-pro-high` | Maximum reasoning |
| `claude-4.6-sonnet-thinking` | Complex tasks with Claude |
| `claude-4.6-opus-thinking` | Maximum capacity |
| `gpt-oss-120b-medium` | Alternative GPT |
| `nano-banana` | Image generation (used by `--generate-image`) |
| `auto` | Auto-select by inline context size |

**`--model auto` — thresholds:**

| Total inline context | Selected model |
|---|---|
| < 32 KB | `gemini-3.5-flash-low` |
| 32 KB – 256 KB | `gemini-3.5-flash-medium` |
| ≥ 256 KB | `gemini-3.5-flash-high` |

The model is applied by writing AGY's `settings.json` before spawn and restored immediately after — no persistent effect on AGY.

## Parallel Subagents (`--parallel`)

AGY exposes native subagent tools (`DefineSubagent`, `invoke_subagent` / `Agent`, `ManageSubagents`) that allow you to **fan-out work within a single `agy` session** — multiple independent tasks run concurrently under a single model context.

With `--parallel`, the bridge attaches an instruction block to the prompt authorizing AGY to decompose the task into independent subtasks and execute them concurrently. **AGY itself decides how many subagents to spawn** (subject to rate limits).

```bash
# AGY decides the number of subagents
/cc-antigravity-plugin:antigravity --parallel "Create two independent HTML reports in reports/"

# Pro orchestrator coordinating cheap Flash subagents
/cc-antigravity-plugin:antigravity --model gemini-3.1-pro-low --subagent-model gemini-3.5-flash-medium "Generate three independent components"
```

**Details:**
- `--subagent-model` enables `--parallel` automatically and is transmitted via **prompt text** (AGY has no per-subagent CLI flag). Without it, subagents inherit the session model.
- Works in default headless mode (`--print`) — no TTY required.
- Ideal for **independent deliverables** (multiple reports, components, or files). For sequential steps or state-sharing, keep execution on the main agent.
- Without the flag, the prompt remains identical to default behavior — zero impact on existing calls.
- `--parallel` is ignored when combined with `--generate-image`.

## Exit Codes

The bridge emits structured JSON for orchestrators to react to failures:

```json
{"status":"QUOTA_EXAUSTED","reason":"...","model":"gemini-3.5-flash-medium","retry":"--continue"}
```

The `retry` field indicates how to resume: pass `--continue` on the next call to resume the interrupted session.

| Code | Meaning | Action |
|---|---|---|
| `0` | Success | — |
| `1` | Generic error | Check the log |
| `10` | `QUOTA_EXAUSTED` | Wait for reset; use `--continue` to resume |
| `11` | `AUTH_REQUIRED` | Run `agy` interactively once |
| `12` | `TIMEOUT` | Increase `--timeout` or reduce scope |
| `13` | `AGY_MISSING` | Install AGY |

> **Heartbeat:** the timeout timer resets on each chunk of AGY output. Long-running tasks that produce continuous output are not cancelled — the timeout only fires if AGY becomes completely silent for the specified duration.

## Tests

```bash
npm test
```

```
ℹ pass 94
ℹ fail 0
```

Coverage: argument parsing · context collection · prompt generation · parallelism block (`--parallel` / `--subagent-model`) · ConPTY spawn · timeout heartbeat · encoding detection · model selection · exit codes.

For practical usage examples in real scenarios, see [`CASOS_USO.md`](CASOS_USO.md) — 11 use cases covering architecture analysis, multi-file refactoring, documentation generation, and parallel task decomposition.

## Development

### Environment Variables

| Variable | Description |
|---|---|
| `CC_ANTIGRAVITY_LOG_PATH` | Custom path for the JSONL log file |
| `CC_ANTIGRAVITY_LOG_OUTPUT` | Set to `1` to include AGY output in logs |

Default log: `%LOCALAPPDATA%\agy\cc-plugin-logs\plugin-YYYY-MM-DD.jsonl` (Windows) or `~/.local/share/agy/cc-plugin-logs/` (Linux/macOS).

### Local testing with real-time logs (Windows)

```powershell
.\scripts\run-claude-plugin-dev.ps1
```

The script sets `CC_ANTIGRAVITY_LOG_PATH` for the session and opens a second window with `Get-Content -Wait` on the log.

## Troubleshooting

| Problem | Solution |
|---|---|
| Authentication error | Run `agy` interactively and log in. |
| `agy` not found | Run the AGY installer and confirm the binary is in PATH. |
| Model not changing | Verify `%LOCALAPPDATA%\agy\settings.json` (Win) or `~/.config/agy/settings.json` (Linux) is read by AGY. Confirm via T02 in `MANUAL_TESTS.md`. |
| Token pressure | Reduce `--dirs`, restrict `--files`, or lower `--max-files`. |
| Premature timeout | Increase `--timeout`. With heartbeat active, timer resets per output — verify AGY is producing output. |
| Plugin not loaded | Run `/reload-plugins` or restart Claude Code. |
| Wrong encoding file skipped | Non-UTF-8 files (e.g., Windows-1252) are skipped with `encoding-error`. Re-save as UTF-8. |

## License

[MIT](LICENSE)
