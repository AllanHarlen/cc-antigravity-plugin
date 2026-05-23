## Context

The cc-gemini-plugin is a Claude Code plugin that delegates large-context analysis to an external CLI (currently `gemini`) via Node.js `spawnSync`. The bridge script (`scripts/gemini-bridge.js`) collects local files, assembles a structured XML prompt, and invokes the CLI in headless one-shot mode. Both Claude Code and Codex route through this single bridge, maintaining a shared contract.

Google is replacing Gemini CLI with Antigravity CLI (`agy`). The `agy` binary supports headless mode via `--print` / `-p` flags (confirmed from `agy --help`). The migration is a hard cut with no backwards-compatibility layer.

## Goals / Non-Goals

**Goals:**
- Replace every reference to `gemini` binary with `agy --print`
- Rename all namespaces, files, and identifiers consistently
- Bump version to 2.0.0 (major, breaking change)
- Keep the bridge's behavior identical: collect files → build XML prompt → invoke CLI → pipe stdout/stderr
- Update install/auth docs to reflect AGY installer and keyring-based auth
- Keep tests passing with updated function names and flag assertions

**Non-Goals:**
- Adding new features (sandbox passthrough, `--add-dir`, streaming)
- Supporting both gemini and agy simultaneously
- Python SDK migration
- Backwards-compatible aliases for old command names

## Decisions

**D1 — Flag mapping: `--print` as the headless flag**
`agy --help` confirms `-p` / `--print` / `--prompt` all invoke single-prompt non-interactive mode. We use `--print` (long form) for readability in `buildAntigravityArgs`. Alternative considered: `-p` (terse, matches gemini's flag); rejected to favor explicitness.

**D2 — Model flag: drop `-m` / `--model` from CLI args**
`agy --help` does not expose a `--model` flag at the CLI level. Model selection in AGY is handled via the interactive `/model` slash command or `~/.gemini/antigravity-cli/settings.json`. Consequence: the `--model` bridge option becomes a no-op passed to the bridge for API compatibility but not forwarded to `agy`. The bridge keeps the `model` parameter in `parseCliArgs` and `buildAntigravityArgs` but does not emit it. This is documented in the README and error table.

**D3 — Output format flag: drop `--output-format`**
`agy --help` does not list `--output-format`. AGY is TUI-first; headless `--print` always returns text. We drop `--output-format` from `buildAntigravityArgs`. The `--format` option on the bridge side remains parsed (for future compatibility and to avoid breaking callers) but is not forwarded. `stream-json` format becomes unsupported and the SUPPORTED_FORMATS set should reflect this.

**D4 — No migration path for `--format json`**
Since AGY has no `--output-format json` equivalent in headless mode, structured JSON output is removed from the bridge's capability surface in this migration. Future work: pipe through `jq` or adopt SDK Python if needed.

**D5 — Hard cut, no aliases**
No `/cc-gemini-plugin:gemini` alias pointing to the new command. Users reinstall the plugin under its new name.

## Risks / Trade-offs

- **Model selection silently ignored** → Users who relied on `--model gemini-2.5-pro` will not get an error but model won't be forwarded. Mitigated: document prominently in README troubleshooting table.
- **JSON format removed** → Any automation relying on `--format json` breaks. Mitigated: document as breaking change in CHANGELOG (if added) and in README.
- **`--output-format` drop** → If future AGY versions add this flag, the bridge can re-add it. Low risk.
- **Keyring/TTY auth on first run** → If AGY has never been used, `spawnSync("agy", ...)` may fail or hang waiting for auth. Mitigated: README documents "run `agy` interactively once before using the plugin."

## Migration Plan

1. Rename files (git mv)
2. Update all content (bridge code, plugin manifests, agent md, skill md, tests, README)
3. Run `npm test` — all tests must pass
4. Install plugin locally from directory for smoke test
5. Test AGY invocation as subagent

Rollback procedure:
- **Before publish**: revert all changes with `git checkout .` and `git clean -fd`; no plugin re-installation needed.
- **After publish (user already on v2.0.0)**: user must uninstall `cc-antigravity-plugin` and re-install `cc-gemini-plugin@1.3.5` from the old marketplace entry. Run `/plugin uninstall cc-antigravity-plugin` then `/plugin install cc-gemini-plugin@cc-gemini-plugin`. The old marketplace (`thepushkarp/cc-gemini-plugin`) remains unchanged.
- **Codex skill**: move `~/.agents/skills/cc-antigravity-plugin` back to `~/.agents/skills/cc-gemini-plugin` (or re-clone original repo).

## Open Questions

- None blocking. Model flag behavior (D2) confirmed acceptable since AGY doesn't expose it in headless mode.
