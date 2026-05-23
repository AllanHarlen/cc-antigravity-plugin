# cc-antigravity-plugin

Give Claude Code and Codex a long-context Antigravity CLI (AGY) handoff for
architecture review, refactor impact analysis, documentation synthesis, and
mixed text-data analysis.

Claude Code is strongest for precise local edits. AGY is useful when a broad
slice of a repository should be read and synthesized in one pass. This plugin
connects both through a shared Node.js bridge.

## Prerequisites

Install and authenticate AGY:

```bash
# macOS / Linux
curl -fsSL https://antigravity.google/cli/install.sh | bash

# Windows PowerShell
irm https://antigravity.google/cli/install.ps1 | iex

agy
agy --print "what is 2+2"
```

## Install

### Claude Code

```bash
/plugin marketplace add AllanHarlen/cc-antigravity-plugin
/plugin install cc-antigravity-plugin@cc-antigravity-plugin
/reload-plugins
```

### Codex

```bash
mkdir -p ~/.agents/skills
git clone https://github.com/AllanHarlen/cc-antigravity-plugin.git \
  ~/.agents/skills/cc-antigravity-plugin
```

Restart Codex after cloning.

## Usage

```bash
/cc-antigravity-plugin:antigravity <task>
/cc-antigravity-plugin:antigravity --dirs src,docs <task>
/cc-antigravity-plugin:antigravity --files "schemas/**/*.json,data/**/*.csv" <task>
/cc-antigravity-plugin:antigravity --add-dir src <task>
```

Codex can use the root skill with:

```text
$antigravity-integration
```

## Options

| Option | Description |
|--------|-------------|
| `--dirs <path,...>` | Recursively inline directories into the bridge prompt |
| `--files <glob,...>` | Inline files that match comma-separated glob patterns |
| `--add-dir <path>` | Pass native AGY `--add-dir`; repeatable |
| `--model <name>` | Temporarily set the AGY model and restore settings afterward |
| `--continue`, `-c` | Continue the most recent AGY conversation |
| `--conversation <id>` | Resume a specific AGY conversation |
| `--timeout <duration>` | Forward `--print-timeout` to AGY, for example `3m` |
| `--sandbox` | Enable AGY sandbox mode |
| `--skip-permissions` | Forward AGY `--dangerously-skip-permissions` |
| `--max-files <n>` | Maximum files to inline, default `40` |
| `--max-file-bytes <n>` | Maximum bytes per inlined file, default `32768` |
| `--print-command` | Print the resolved `agy` command without running it |

`--format json` is not supported because AGY headless print mode returns text.

## Examples

```bash
/cc-antigravity-plugin:antigravity --dirs src,docs \
  "Explain the architecture. Cite key files and data flows."
```

```bash
/cc-antigravity-plugin:antigravity --add-dir src --model gemini-2.5-flash \
  "Analyze the refactor impact of the auth module."
```

```bash
/cc-antigravity-plugin:antigravity --continue --timeout 5m \
  "Summarize the migration plan from the previous answer."
```

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/antigravity-bridge.js" --dirs src --print-command -- "analyze auth"
```

## How It Works

The shared bridge at `scripts/antigravity-bridge.js`:

1. Parses bridge flags.
2. Resolves `--dirs` and `--files` without Node 22-only glob APIs.
3. Filters ignored paths and binary files.
4. Builds a structured prompt with inventory, inline payloads, task, and constraints.
5. Maps AGY-native flags such as `--add-dir`, `--continue`, `--conversation`,
   `--sandbox`, `--dangerously-skip-permissions`, and `--print-timeout`.
6. Applies `--model` by temporarily updating `~/.gemini/antigravity-cli/settings.json`.
7. Runs AGY through `node-pty` when available and streams output as it arrives,
   with a `spawnSync` fallback.

## Repository Layout

```text
cc-antigravity-plugin/
├── .claude-plugin/
│   ├── marketplace.json
│   └── plugin.json
├── agents/
│   └── antigravity-agent.md
├── bin/
│   └── antigravity-bridge
├── commands/
│   └── antigravity.md
├── hooks/
│   └── hooks.json
├── scripts/
│   ├── antigravity-bridge.js
│   └── check-agy.js
├── tests/
│   ├── antigravity-bridge.test.js
│   └── antigravity-main.test.js
├── SKILL.md
├── LICENSE
└── package.json
```

## Development

```bash
npm test
```

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Authentication error | Run `agy` interactively and sign in. |
| `agy` not found | Re-run the AGY installer and make sure the binary is on PATH. |
| Model override failed | Set the model inside AGY with `/model`, then retry without `--model`. |
| Token pressure | Reduce `--dirs`, narrow `--files`, or lower `--max-files`. |
| Timeout | Increase `--timeout`, reduce context, or tighten the task. |

## License

MIT
