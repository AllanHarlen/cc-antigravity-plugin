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

By default, the bridge is **agentic**: the current working directory is added to the AGY
workspace and AGY acts without permission confirmations. With AGY 1.5.x it uses Auto mode
(`--mode auto`, no bypass) where the CLI offers it — AGY 1.3.5+ on Linux/macOS, 1.4.4+ on
Windows 11 24H2+. If AGY reports Auto as unavailable for the account, the bridge stops the
run before any step and retries once with `--dangerously-skip-permissions` (remembered for
24h). Elsewhere it forwards `--dangerously-skip-permissions` as before.

Runs on AGY 1.5.0+ have **no time ceiling** by default: AGY waits until the turn and its
background work finish, and a 15-minute stall watchdog (`--stall-timeout`) stops silent runs.
Claude Code's Bash tool stops commands after 2 minutes by default (10 at most), so launch long
tasks with `run_in_background: true` plus `--output-file <path>` and Read the file afterwards.

Pass `--read-only` to force AGY's native `--mode plan`, disable skip-permissions,
and disable workspace auto-add for tasks that must not modify files.

## Live Output (run in a visible terminal)

Long AGY runs are invisible under `--format json`: output is buffered and returned
once, so a 10-minute task looks like a hang. Prefer live progress in Claude Code:

1. In terminal-panel environments, run the bridge in the user's Terminal panel
   (the `run_in_terminal` tool) instead of a batch Bash call, so the user watches
   progress while it happens. This also avoids the Bash tool's 2-minute stop.
2. Pass `--format stream-json`: live progress lines land on stderr —
   `[agy] tool write_file {…}` per tool call, `[agy] subagent started: <role>` /
   `[agy] subagent done: <role> (<id>) (12s)`, `[agy] 🧠 turn done (15s) · 1292
   thinking tokens` after a slow or thinking-heavy turn, `[agy] ⏱ tool done in
   42s`, and `[agy] … still working` every 30s of stream silence — with the
   final result still on stdout.
3. Relay notable progress to the user by polling the terminal tab
   (`read_terminal`): "AGY is now writing component X".

Edge: model thinking does NOT stream — AGY's headless event protocol carries no
thinking text, only per-turn `thinking_tokens`/`duration_seconds` counts (above).
During an in-flight thinking turn the stream is fully silent, which is exactly
what the 30s heartbeat disambiguates from a hang.

Fallbacks without a visible terminal (cron/headless): run in the background with
`--output-file <path>` and Read it after, or set `CC_ANTIGRAVITY_LOG_OUTPUT=1`
and tail `%LOCALAPPDATA%\agy\cc-plugin-logs\plugin-YYYY-MM-DD.jsonl` (`agy.output.chunk`
events) — `runs.jsonl` tracks run state by runId (STARTING→RUNNING→DONE).

## Natural Language → Flags Contract

Translate the user's prose into explicit flags before invoking the bridge so the session
runs exactly as requested. The bridge normalizes loose model names defensively, but pass
the canonical id whenever you can.

### Model selection

| User says (natural language) | Pass | Resolves to |
|------------------------------|------|-------------|
| "flash" | `--model gemini-3.8-flash-high` | Newest matching Flash member from `agy models` |
| "gemini 3.7 flash" | `--model gemini-3.7-flash-high` | Version pinned; newest tier within that family |
| "gemini 3.7 flash medium" | `--model gemini-3.7-flash-medium` | Gemini 3.7 Flash (Medium), when available |
| "claude opus", "opus" | `--model opus` | Newest Opus available from `agy models` |
| "claude sonnet", "sonnet" | `--model sonnet` | Newest Sonnet available from `agy models` |
| "gpt oss" | `--model gpt-oss-120b-medium` | GPT-OSS 120B (Medium) |
| "hydrogen", "neon", "argon", "carbon" (Gemini 4) | `--model hydrogen` | Highest tier of that Gemini 4 family in `agy models` |
| "orchestrator" | `--model orchestrator` | Orchestrator (default planner); `orchestrator neon`/`argon` pick the planner |
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
parsing, defaults (Auto mode or skip-permissions, workspace auto-add, disabled slash
commands, timeout policy), file ingestion, prompt assembly, structured error detection,
and AGY invocation.

## Bridge Options

| Option | Behavior |
|--------|----------|
| `--dirs <path,...>` | Inline directories into the bridge prompt |
| `--files <glob,...>` | Inline targeted globs and mixed data formats |
| `--design-system <dir,...>` | Inline an Open Design package's core files in full (outside `--max-files`/`--max-file-bytes`) and list the rest for on-demand reads; prefer it over `--dirs` for design packages |
| `--add-dir <path>` | Pass native AGY `--add-dir`; repeatable |
| `--model <name>` | Native AGY slug or alias resolved against `agy models` with a 24-hour cache. Omit to preserve the user's AGY model; `auto` selects a tier from the newest Flash family. |
| `--format <format>` | `text`, `json`, or `stream-json` (default `json`). Stream progress goes to stderr and only the final result to stdout. |
| `--effort <level>` | Forward native `low`, `medium`, `high`, `xhigh`, or `max` (model-dependent) effort only when requested. |
| `--mode <mode>` | Forward native `plan`, `accept-edits`, or `auto` (AGY 1.3.5+ on Linux/macOS, 1.4.4+ on Windows 11 24H2+; no permission bypass). |
| `--agent <name>` | Select a named custom AGY agent. `--interactive` remains the PTY mode. |
| `--json-schema <value>` | Validate an object-root JSON Schema string/file before spawning AGY; force JSON format. |
| `--allow-slash-commands` | Opt into slash-command expansion; disabled by default in headless mode. |
| `--parallel` | Allow AGY to fan the task out across native Gemini subagents (`DefineSubagent` / `invoke_subagent` / `ManageSubagents`); AGY chooses the count |
| `--subagent-model <name>` | Model the spawned subagents should use (conveyed via the prompt). Implies `--parallel`; defaults to the main model |
| `--read-only` | Force `--mode plan`, disable skip-permissions/workspace auto-add, and keep slash expansion enabled because AGY 1.1.16 otherwise ignores plan mode |
| `--continue`, `-c` | Continue the most recent AGY conversation |
| `--conversation <id>` | Resume a specific AGY conversation (aliases `-r`, `--resume`) |
| `--timeout <duration>` | Hard ceiling forwarded as `--print-timeout`; default none on AGY 1.5.0+ (10m on older CLIs) |
| `--stall-timeout <duration>` | Runs without a ceiling: stop AGY (exit 12) after this long without progress events; default `15m`, `0` disables |
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
| `10` | QUOTA_EXAUSTED | Retry later; JSON signal emitted to stdout (includes spend-cap, prepaid-balance, weekly-quota stops) |
| `11` | AUTH_REQUIRED | Run `agy` once interactively |
| `12` | TIMEOUT | `--timeout` expired (partial `response` kept) or the stall watchdog fired; raise `--timeout`/`--stall-timeout` or narrow task scope |
| `13` | AGY_MISSING | Install AGY |

Exits `10`, `11`, and `12` emit a machine-readable JSON line to stdout:
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
| TIMEOUT (exit 12) | Raise `--timeout`/`--stall-timeout`, split the task, or resume the signal's `--conversation <id>`. |

## AGY CLI 1.5 compatibility

- Use AGY 1.5.16 for current behavior; the baseline remains 1.1.8. Below 1.5.0 the
  bridge keeps its legacy defaults (10-minute ceiling, permission bypass).
- Pass `--mode auto` explicitly only when requested: it is validated against the detected
  AGY version and Windows build and never falls back to the bypass.
- `-r`/`--resume <id>` are accepted and forwarded as `--conversation <id>`.
- Gemini 4 families resolve by name (`hydrogen`, `neon`, `argon`, `carbon`, `orchestrator`);
  `--model auto` still picks the newest Flash tier.
- AGY 1.5.16 discovers skills in `~/.agents/skills`. Keep using this plugin from Claude
  Code: imported into AGY it would delegate AGY to itself.

## AGY CLI 1.4 compatibility

- Auto mode requires 1.3.5+ on Linux/macOS (1.4.4+ on Windows 11 24H2+). The bridge
  disables its permission bypass in Auto mode and rejects `--skip-permissions` with it.
  Headless runs cannot answer approval prompts; use `--interactive` when review is needed.
- Pass an exact base slug such as `--model gemini-3.8-flash` on AGY 1.3.4+ to let
  AGY pick the model's default effort. Omit `--effort` unless explicitly requested.
  Generic `opus`/`sonnet` aliases follow the authenticated runtime catalog, including
  Claude 5.5 when available to the account; do not invent unavailable model IDs.
- Use the search tools AGY loaded for the run: AGY 1.5.16 lists `grep_search`,
  `find_by_name`, `list_dir`, and `view_file` (some 1.2.7-1.4 builds exposed
  `code_search` instead). Read-only tasks must still avoid `run_command` and all writes.
- Treat a structured `AGY_ERROR` signal as failure even if it contains a partial
  `response`. The `agy_error` field preserves upstream status, code, retryability,
  and error ID when supplied. Quota/auth/timeout still map to exits 10/11/12.
- `--mode plan` no longer auto-approves artifacts just because permission bypass is
  enabled (AGY 1.3.2+). Configure Artifact Review in AGY when that workflow needs it.
- Native AGY marketplace commands (`agy plugin list --json` and
  `agy plugin validate <path> --strict --json`) manage AGY plugins. This repository
  remains a Claude Code plugin; do not validate its manifest as an AGY plugin.
