## Why

Google deprecated Gemini CLI in favor of Antigravity CLI (`agy`), its next-generation terminal agent. The current plugin invokes `gemini -p` as a subprocess — a binary that is being sunset — so all existing users will lose functionality unless we migrate to `agy --print`.

## What Changes

- **BREAKING** Plugin namespace renamed: `cc-gemini-plugin` → `cc-antigravity-plugin`
- **BREAKING** Command renamed: `/cc-gemini-plugin:gemini` → `/cc-antigravity-plugin:antigravity`
- **BREAKING** Agent renamed: `gemini-agent` → `antigravity-agent`
- **BREAKING** Codex skill renamed: `gemini-integration` → `antigravity-integration`
- **BREAKING** Version bump: `1.3.5` → `2.0.0`
- Bridge binary invocation changed: `spawnSync("gemini", ["-p", ...])` → `spawnSync("agy", ["--print", ...])`
- Install instructions updated: `@google/gemini-cli` / `brew install gemini-cli` → official AGY installer script
- Auth instructions updated: `gemini auth` → launch `agy` once (keyring/browser auto-auth)
- File renames: `gemini-bridge.js` → `antigravity-bridge.js`, `gemini-agent.md` → `antigravity-agent.md`, `commands/gemini.md` → `commands/antigravity.md`, `tests/gemini-bridge.test.js` → `tests/antigravity-bridge.test.js`
- Internal function renames: `buildGeminiArgs` → `buildAntigravityArgs`, `buildGeminiPrompt` → `buildAntigravityPrompt`, `ensureGeminiInstalled` → `ensureAgyInstalled`
- No backwards-compatibility aliases introduced

## Capabilities

### New Capabilities
- `agy-bridge`: Headless AGY CLI bridge — invokes `agy --print <prompt>` as subprocess; `--model` and `--format` are accepted by the bridge CLI for API compatibility but are NOT forwarded to `agy` (AGY headless mode does not expose these flags); provides file/directory context ingestion

### Modified Capabilities
<!-- No existing openspec/specs/ — first change on this repo -->

## Impact

- All files in the repo are touched (rename + content update)
- Users must reinstall: old plugin name no longer exists; new name `cc-antigravity-plugin` requires fresh `/plugin install` or marketplace update
- Codex skill path changes from `$gemini-integration` to `$antigravity-integration`
- `npm test` must pass with renamed exports and updated flag assertions
- No database, authentication, or external API changes beyond the CLI binary substitution
