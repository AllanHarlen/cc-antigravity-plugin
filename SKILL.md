---
name: antigravity-integration
description: Use Antigravity CLI (AGY) for long-context codebase exploration, architecture review, refactor impact analysis, documentation synthesis, or structured data analysis when the host should hand off a large cross-file problem instead of solving it file-by-file.
allowed-tools: Bash, Glob, Read
---

# Antigravity CLI Integration

Antigravity CLI (AGY) is the large-context handoff in this repository. Use it when the
task is about the shape of a system, a broad slice of a repo, or a mixed text
dataset that should be synthesized in one pass.

## When to Use Antigravity

### Ideal Cases

| Scenario | Why Antigravity Fits |
|----------|----------------------|
| Whole-codebase architecture | Broad cross-file synthesis |
| Cross-file security review | Traces flows across modules |
| Refactor impact analysis | Finds dependencies and callers |
| Codebase orientation | Produces a high-level map quickly |
| Documentation generation | Synthesizes behavior from many files |
| Structured data review | Reads JSON, YAML, TOML, CSV, Markdown, and code together |

### Not Ideal

| Scenario | Why |
|----------|-----|
| Quick single-file edits | The handoff adds latency you do not need |
| Tight interactive debugging | Better handled directly by the host model |
| Narrow tasks with no cross-file context | Antigravity adds little value |

## Host Entry Points

### Claude Code

Use the slash command:

```bash
/cc-antigravity-plugin:antigravity <task>
/cc-antigravity-plugin:antigravity --dirs src,docs <task>
/cc-antigravity-plugin:antigravity --files "schemas/**/*.json" <task>
```

Claude can also spawn `antigravity-agent` when the task obviously benefits from a
large-context pass.

### Codex

- Mention the skill explicitly with `$antigravity-integration`.
- Or ask Codex to use the Antigravity integration for a large analysis task.

Codex reads this skill definition directly when the repository is installed as a
user-level skill.

## Shared Runtime Contract

Always prefer the shared bridge script over hand-written `agy` commands:

```bash
node scripts/antigravity-bridge.js [options] <task>
```

The bridge owns:
- argument parsing
- directory and file ingestion
- structured prompt assembly
- Antigravity CLI invocation

Use:
- `--dirs <path,...>` for broad module trees
- `--files <glob,...>` for targeted globs and mixed data formats
- `--print-command` when you need to inspect the resolved agy command
- Note: `--model` is accepted but not forwarded to agy; AGY headless mode does not expose a model flag
- Note: `--format json` is not supported; AGY headless mode always returns text

## Good Patterns

### Architecture

```bash
node scripts/antigravity-bridge.js --dirs src,docs \
  "Explain the architecture and cite the key files."
```

### Refactor impact

```bash
node scripts/antigravity-bridge.js --dirs src \
  "Analyze the impact of refactoring the auth module. Include affected files and migration steps."
```

### Structured data

```bash
node scripts/antigravity-bridge.js --files "schemas/**/*.json,data/**/*.csv" \
  "Summarize the data contracts and identify breaking changes."
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Authentication error | Launch `agy` once interactively; sign in via keyring or browser. Use `/logout` inside the TUI to clear cached credentials. |
| AGY missing on PATH | macOS/Linux: `curl -fsSL https://antigravity.google/cli/install.sh \| bash`  Windows: `irm https://antigravity.google/cli/install.ps1 \| iex` |
| Rate limiting | Retry with a narrower task or smaller context set |
| Token pressure | Reduce the number of inlined files |
