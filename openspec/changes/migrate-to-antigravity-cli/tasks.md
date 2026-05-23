## 1. File Renames (git mv)

- [ ] 1.1 Rename `agents/gemini-agent.md` → `agents/antigravity-agent.md`
- [ ] 1.2 Rename `commands/gemini.md` → `commands/antigravity.md`
- [ ] 1.3 Rename `scripts/gemini-bridge.js` → `scripts/antigravity-bridge.js`
- [ ] 1.4 Rename `tests/gemini-bridge.test.js` → `tests/antigravity-bridge.test.js`

## 2. Plugin Metadata

- [ ] 2.1 Update `package.json`: name → `cc-antigravity-plugin`, version → `2.0.0`
- [ ] 2.2 Update `.claude-plugin/plugin.json`: name → `cc-antigravity-plugin`, version → `2.0.0`, description and keywords updated
- [ ] 2.3 Update `.claude-plugin/marketplace.json`: name, plugin name, description, version, keywords, homepage, repository URLs

## 3. Bridge Script (`scripts/antigravity-bridge.js`)

- [ ] 3.1 Update USAGE string: script path reference and binary name
- [ ] 3.2 Rename `buildGeminiArgs` → `buildAntigravityArgs`; update flag mapping: emit only `["--print", prompt]`; remove all `--output-format` and `-m`/`--model` forwarding
- [ ] 3.2b Update `SUPPORTED_FORMATS` constant and `parseCliArgs` format validation to reflect that `--format` is parsed but not forwarded; remove `stream-json` from supported set or document it as no-op
- [ ] 3.3 Rename `buildGeminiPrompt` → `buildAntigravityPrompt`
- [ ] 3.4 Rename `ensureGeminiInstalled` → `ensureAgyInstalled`; update error message with AGY install URLs
- [ ] 3.5 Update `printResolvedCommand`: `["gemini", ...]` → `["agy", ...]`
- [ ] 3.6 Update `spawnSync("gemini", ...)` → `spawnSync("agy", ...)`
- [ ] 3.7 Update all exported function references in `main()`

## 4. Claude Code Command (`commands/antigravity.md`)

- [ ] 4.1 Update frontmatter description to reference AGY bridge
- [ ] 4.2 Update heading and all command examples: `/cc-gemini-plugin:gemini` → `/cc-antigravity-plugin:antigravity`
- [ ] 4.3 Update bridge script path in execution instructions
- [ ] 4.4 Update Error Handling table: auth and install instructions for AGY
- [ ] 4.5 Document model override limitation (accepted but not forwarded to AGY)

## 5. Agent Definition (`agents/antigravity-agent.md`)

- [ ] 5.1 Update frontmatter: `name: antigravity-agent`
- [ ] 5.2 Update description examples (replace gemini-agent references)
- [ ] 5.3 Update body: role description, bridge script path, Antigravity CLI invocation

## 6. Codex Skill (`SKILL.md` and `agents/openai.yaml`)

- [ ] 6.1 Update SKILL.md: `name: antigravity-integration`, description, all Gemini CLI mentions, slash command examples, skill reference `$antigravity-integration`, auth/install table
- [ ] 6.2 Update `agents/openai.yaml`: `display_name`, `short_description`, `default_prompt` (replace `$gemini-integration`)

## 7. Tests (`tests/antigravity-bridge.test.js`)

- [ ] 7.1 Update import path: `../scripts/antigravity-bridge.js`
- [ ] 7.2 Update imported names: `buildAntigravityArgs`, `buildAntigravityPrompt`
- [ ] 7.3 Update `buildAntigravityArgs` test: pass non-empty `model` and `format` as input; assert output is exactly `["--print", prompt]` — model and format must NOT appear in the array
- [ ] 7.4 Update `mkdtemp` prefixes: `antigravity-bridge-`, `antigravity-ignore-`
- [ ] 7.5 Run `npm test` and confirm all tests pass

## 8. README

- [ ] 8.1 Update title, description, and all use-case references
- [ ] 8.2 Update Prerequisites: AGY install commands (curl/irm), auth instruction (run `agy` once)
- [ ] 8.3 Update Installation (Claude Code): new plugin marketplace/install commands
- [ ] 8.4 Update Installation (Codex): new git clone path
- [ ] 8.5 Update Shared Runtime section: new script name and command examples
- [ ] 8.6 Update Host Entry Points: new slash command name
- [ ] 8.7 Update Repository Structure: new file names
- [ ] 8.8 Update Troubleshooting table: AGY-specific entries

## 9. Verification

- [ ] 9.1 Run `node scripts/antigravity-bridge.js --help` — USAGE prints correctly
- [ ] 9.2 Run `node scripts/antigravity-bridge.js --print-command -- "test"` — emits `agy --print "test"`
- [ ] 9.3 Run `npm test` — all 5 tests pass
- [ ] 9.4 Install plugin locally: run `/plugin marketplace add <local-path>` then `/plugin install cc-antigravity-plugin@cc-antigravity-plugin`; verify plugin appears in `/plugin list` as `cc-antigravity-plugin`
- [ ] 9.5 Test AGY as subagent: run `/cc-antigravity-plugin:antigravity what is 2+2` inside Claude Code; expect AGY to respond with a numeric answer and exit 0; verify no auth/ENOENT error in stderr
