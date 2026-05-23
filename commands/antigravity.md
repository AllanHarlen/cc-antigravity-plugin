---
description: Invoke the shared Antigravity (AGY) bridge for long-context code exploration, analysis, and documentation generation
allowed-tools: Bash, Glob, Read
argument-hint: "[--model name] [--dirs path,...] [--files pattern,...] <task>"
---

# /cc-antigravity-plugin:antigravity Command

Use the shared Antigravity bridge for long-context code exploration, architecture
review, documentation synthesis, and structured data analysis. The bridge keeps
Claude Code and Codex aligned by collecting local context first and then making
one deterministic AGY CLI call.

## Usage

```bash
/cc-antigravity-plugin:antigravity <task>
/cc-antigravity-plugin:antigravity --dirs <path,...> <task>
/cc-antigravity-plugin:antigravity --files <pattern,...> <task>
```

## Arguments

| Argument | Description | Example |
|----------|-------------|---------|
| `--model <name>` | Model override (accepted for API compatibility; not forwarded to agy) | `--model gemini-2.5-pro` |
| `--dirs <paths>` | Recursively inline directories into the bridge context | `--dirs src,docs,data` |
| `--files <pattern,...>` | Inline matching files into the bridge context | `--files "schemas/**/*.json,data/**/*.csv"` |
| `<task>` | Analysis task or question | (required) |

## Execution Instructions

Parse arguments into:
1. `DIRS` from `--dirs` if present
2. `FILES` from `--files` if present
3. `TASK` from the remaining text

Always execute through the shared bridge script:

```bash
node scripts/antigravity-bridge.js [--dirs <DIRS>] [--files <FILES>] -- "<TASK>"
```

Guidance:
- Use `--dirs` for broad module or service areas.
- Use `--files` for precise globs or structured data slices.
- Keep the task direct, scoped, and explicit about the output shape.
- `--model` is accepted but not forwarded to agy; model selection is done via AGY settings.
- `--format json` is not supported; AGY headless mode always returns text.

## Examples

### Simple query
```bash
/cc-antigravity-plugin:antigravity what is 2+2
```

### Architecture review
```bash
/cc-antigravity-plugin:antigravity --dirs src,docs explain the architecture of this codebase
```

### Structured data review
```bash
/cc-antigravity-plugin:antigravity --files "schemas/**/*.json,data/**/*.csv" summarize the data contracts and highlight breaking changes
```

### With context directories
```bash
/cc-antigravity-plugin:antigravity --dirs src analyze the refactor impact of the auth module
```

## Best Use Cases

Antigravity fits:
- whole-codebase architecture understanding
- cross-file security audits
- refactoring impact analysis
- unfamiliar codebase orientation
- documentation generation
- structured text data synthesis

Antigravity is not the right tool for:
- quick single-file edits
- tight interactive debugging loops
- trivial tasks with no cross-file or data-shape component

## Error Handling

| Error | Solution |
|-------|----------|
| Authentication error | Launch `agy` once interactively; sign in via browser. Use `/logout` inside the TUI to clear cached credentials. |
| AGY missing on PATH | macOS/Linux: `curl -fsSL https://antigravity.google/cli/install.sh \| bash`  Windows: `irm https://antigravity.google/cli/install.ps1 \| iex` |
| Model override ignored | AGY headless mode does not expose `--model`; use AGY settings at `~/.gemini/antigravity-cli/settings.json` to configure the model |
| Token limit exceeded | Narrow the inlined scope with `--files` or fewer `--dirs` |
| Timeout | Reduce the context set and tighten the task |
