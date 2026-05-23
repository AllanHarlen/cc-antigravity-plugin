# cc-antigravity-plugin

Dual-host Antigravity CLI (AGY) integration for Claude Code and Codex.

This repository uses one shared Antigravity runtime and two thin host adapters:
- Claude Code exposes `/cc-antigravity-plugin:antigravity` and `antigravity-agent`.
- Codex exposes the bundled `antigravity-integration` skill.

It gives each host a clean way to hand large, cross-file analysis tasks to
Antigravity instead of solving everything file-by-file.

## Architecture

- Shared bridge runtime at `scripts/antigravity-bridge.js`
- Claude Code integration through the plugin manifest, `/cc-antigravity-plugin:antigravity`
  command, and `antigravity-agent`
- Codex integration through the root `SKILL.md` skill definition and
  `agents/openai.yaml`
- Bridge coverage in `tests/antigravity-bridge.test.js`

## Use Cases

- whole-codebase architecture understanding
- cross-file security audits
- refactor impact analysis
- unfamiliar codebase orientation
- documentation generation
- structured text data synthesis across JSON, YAML, TOML, CSV, Markdown, and code

## Prerequisites

1. Install Antigravity CLI

```bash
# macOS/Linux
curl -fsSL https://antigravity.google/cli/install.sh | bash
# Windows (PowerShell)
irm https://antigravity.google/cli/install.ps1 | iex
```

2. Authenticate

Launch `agy` once interactively to complete Google Sign-In via keyring or browser:

```bash
agy
```

3. Verify AGY works

```bash
agy --print "what is 2+2"
```

## Installation

### Claude Code

This is a user-level install. Once you add the marketplace and install the
plugin, it stays available in new Claude Code sessions on this machine.

Add the marketplace from GitHub, install the plugin, then reload plugins:

```bash
/plugin marketplace add AllanHarlen/cc-antigravity-plugin
/plugin install cc-antigravity-plugin@cc-antigravity-plugin
/reload-plugins
```

After installation, use:

```bash
/cc-antigravity-plugin:antigravity <task>
```

To update the plugin:

```bash
/plugin marketplace update cc-antigravity-plugin
/reload-plugins
```

### Codex

Codex does not need a plugin for this repository. Install it as a user-level
skill so it is available in new Codex sessions on this machine across
repositories.

Install it by cloning the repository into `~/.agents/skills`:

```bash
mkdir -p ~/.agents/skills
git clone https://github.com/AllanHarlen/cc-antigravity-plugin.git \
  ~/.agents/skills/cc-antigravity-plugin
```

Restart Codex after cloning the skill.

To update it later:

```bash
git -C ~/.agents/skills/cc-antigravity-plugin pull
```

After installation, use the bundled skill:

```text
$antigravity-integration
```

## Shared Runtime

Both hosts route through:

```bash
node scripts/antigravity-bridge.js [options] <task>
```

Supported options:
- `--model <name>` (accepted for API compatibility; not forwarded to agy)
- `--dirs <path,...>`
- `--files <glob,...>`
- `--max-files <n>`
- `--max-file-bytes <n>`
- `--print-command`

The bridge:
- collects files and directories locally
- inlines text-like content into a structured prompt
- skips unsupported binary files
- invokes Antigravity CLI in headless mode via `agy --print`

## Host Entry Points

### Claude Code

Use:

```bash
/cc-antigravity-plugin:antigravity <task>
/cc-antigravity-plugin:antigravity --dirs src,docs <task>
/cc-antigravity-plugin:antigravity --files "schemas/**/*.json,data/**/*.csv" <task>
```

### Codex

Use the bundled skill:

```text
$antigravity-integration
```

Or ask Codex to use the Antigravity integration for a large-context pass.

Codex-specific skill metadata lives in `agents/openai.yaml`.

## Examples

Architecture review:

```bash
node scripts/antigravity-bridge.js --dirs src,docs \
  "Explain the architecture and cite the key files."
```

Refactor impact:

```bash
node scripts/antigravity-bridge.js --dirs src \
  "Analyze the impact of refactoring the auth module. Include affected files and migration steps."
```

Structured data review:

```bash
node scripts/antigravity-bridge.js --files "schemas/**/*.json,data/**/*.csv" \
  "Summarize the data contracts and identify breaking changes."
```

## Development

Run the bridge tests:

```bash
npm test
```

## Repository Structure

```text
cc-antigravity-plugin/
├── .claude-plugin/
│   ├── marketplace.json
│   └── plugin.json
├── SKILL.md
├── agents/
│   ├── antigravity-agent.md
│   └── openai.yaml
├── commands/
│   └── antigravity.md
├── scripts/
│   └── antigravity-bridge.js
├── tests/
│   └── antigravity-bridge.test.js
└── package.json
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Authentication error | Launch `agy` once interactively; sign in via keyring or browser. Use `/logout` inside the TUI to clear cached credentials. |
| AGY missing on PATH | macOS/Linux: `curl -fsSL https://antigravity.google/cli/install.sh \| bash`  Windows: `irm https://antigravity.google/cli/install.ps1 \| iex` |
| Model override ignored | AGY headless mode does not expose `--model`; configure the model via `~/.gemini/antigravity-cli/settings.json` |
| Token pressure | Narrow the inlined scope with fewer directories or more specific globs |
| Timeout | Reduce the context set and tighten the task |

## License

MIT
