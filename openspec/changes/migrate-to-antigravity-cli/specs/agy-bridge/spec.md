## ADDED Requirements

### Requirement: Headless AGY invocation
The bridge SHALL invoke `agy` with the `--print` flag to run a single prompt non-interactively and return the response to stdout. The bridge SHALL NOT forward `--output-format` or `--model` flags to `agy` since AGY headless mode does not expose them.

#### Scenario: Successful headless call
- **WHEN** `spawnSync("agy", ["--print", prompt])` is called
- **THEN** the bridge SHALL capture stdout and write it to process.stdout

#### Scenario: AGY not on PATH
- **WHEN** `spawnSync` throws ENOENT
- **THEN** the bridge SHALL print an install guidance message referencing the official AGY installer URLs and exit with code 1

### Requirement: Plugin namespace uses cc-antigravity-plugin
The Claude Code plugin SHALL be registered under the name `cc-antigravity-plugin` and expose the slash command `/cc-antigravity-plugin:antigravity`.

#### Scenario: Command invocation
- **WHEN** the user runs `/cc-antigravity-plugin:antigravity <task>`
- **THEN** the bridge SHALL execute with the provided task

### Requirement: Codex skill uses antigravity-integration
The Codex-facing SKILL.md SHALL declare `name: antigravity-integration` and be invocable as `$antigravity-integration`.

#### Scenario: Skill invocation
- **WHEN** Codex activates `$antigravity-integration`
- **THEN** the bridge script SHALL be used as the execution path

### Requirement: Model flag is accepted but not forwarded to AGY
The bridge CLI SHALL accept `--model <name>` for API compatibility but SHALL NOT forward it to the `agy` invocation since AGY headless mode does not expose a model flag.

#### Scenario: Model flag present
- **WHEN** the user passes `--model gemini-2.5-pro` to the bridge
- **THEN** the bridge SHALL parse the value without error and SHALL NOT include it in the `agy` argument list

### Requirement: JSON format is not supported in AGY headless mode
The bridge SHALL remove `--output-format` forwarding to `agy`. The `--format` option SHALL remain parseable for backwards API compatibility but SHALL be ignored when building AGY args.

#### Scenario: Format flag ignored
- **WHEN** the user passes `--format json` to the bridge
- **THEN** the bridge SHALL invoke `agy --print <prompt>` without any output-format flag

### Requirement: Auth requires prior interactive AGY session
The README SHALL document that users MUST run `agy` interactively at least once before using the plugin so that keyring credentials are established.

#### Scenario: Plugin used before AGY auth
- **WHEN** AGY keyring has no credentials and the plugin is invoked
- **THEN** `agy --print` SHALL fail with an auth error and the bridge SHALL propagate stderr to the user
