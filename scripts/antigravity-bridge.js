#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";
import { createHash, randomUUID } from "node:crypto";
import { resolveDefaultLogPath, logEvent } from "./utils.js";

const DEFAULT_MAX_FILES = 40;
const DEFAULT_MAX_FILE_BYTES = 32_768;
// Headless prompts above these sizes are streamed to agy over stdin instead of
// `--print <prompt>`: agy reads the prompt from stdin when --print is omitted
// (verified end-to-end on AGY 1.2.2 with a 97k-char prompt). cmd.exe caps a line
// at 8,191 chars and CreateProcess breaks near ~29k after Node's quoting; Linux
// caps a single argv entry at 131,072 bytes (MAX_ARG_STRLEN).
const WIN_ARGV_SAFE_CHARS = 8_191;
const POSIX_ARGV_SAFE_CHARS = 100_000;
const ARGV_PROMPT_LIMIT = 28_000;
// Open Design package files --design-system inlines in full, in priority order.
export const DESIGN_SYSTEM_CORE_FILES = [
  "design-contract.json",
  "DESIGN.md",
  "tokens.css",
  "components.css",
  "components.html",
  "USAGE.md",
  "components.manifest.json",
  "assets/manifest.json",
];
const DESIGN_SYSTEM_MAX_FILE_BYTES = 262_144;
const SUPPORTED_FORMATS = new Set(["text", "json", "stream-json"]);
const SUPPORTED_EFFORTS = new Set(["low", "medium", "high"]);
const SUPPORTED_MODES = new Set(["plan", "accept-edits"]);
const MODEL_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const KNOWN_BINARY_EXTENSIONS = new Set([
  ".7z",
  ".ai",
  ".avif",
  ".bmp",
  ".class",
  ".db",
  ".dll",
  ".dylib",
  ".eot",
  ".exe",
  ".gif",
  ".gz",
  ".ico",
  ".jar",
  ".jpeg",
  ".jpg",
  ".lockb",
  ".mov",
  ".mp3",
  ".mp4",
  ".otf",
  ".pdf",
  ".png",
  ".pyc",
  ".so",
  ".svgz",
  ".tar",
  ".ttf",
  ".wasm",
  ".webm",
  ".webp",
  ".woff",
  ".woff2",
  ".zip",
]);

const IGNORED_PATH_SEGMENTS = new Set([
  ".git",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
]);

const MEDIA_TYPES = new Map([
  [".csv", "text/csv"],
  [".graphql", "application/graphql"],
  [".gql", "application/graphql"],
  [".html", "text/html"],
  [".json", "application/json"],
  [".jsonl", "application/x-ndjson"],
  [".md", "text/markdown"],
  [".sql", "text/sql"],
  [".toml", "application/toml"],
  [".tsv", "text/tab-separated-values"],
  [".xml", "application/xml"],
  [".yaml", "application/yaml"],
  [".yml", "application/yaml"],
]);

// Structured exit codes the caller (Claude Code / orchestrators) can act on.
export const EXIT_SUCCESS = 0;
export const EXIT_QUOTA_EXAUSTED = 10;
export const EXIT_AUTH_REQUIRED = 11;
export const EXIT_TIMEOUT = 12;
export const EXIT_AGY_MISSING = 13;
export const EXIT_ERROR = 1;

// Um log de eventos de execucao e deliberadamente append-only: uma queda de
// energia pode interromper a ultima linha, mas nunca invalida os eventos ja
// confirmados. O orquestrador pode consultar o ultimo estado por runId e nao
// confundir um PID antigo com um processo vivo.
export function resolveRunJournalPath() {
  const logPath = process.env.CC_ANTIGRAVITY_LOG_PATH || resolveDefaultLogPath();
  return process.env.CC_ANTIGRAVITY_RUN_JOURNAL_PATH || path.join(path.dirname(logPath), "runs.jsonl");
}

export function appendRunJournal(entry, journalPath = resolveRunJournalPath()) {
  const record = { timestamp: new Date().toISOString(), ...entry };
  try {
    fs.mkdirSync(path.dirname(journalPath), { recursive: true });
    fs.appendFileSync(journalPath, JSON.stringify(record) + "\n", "utf8");
  } catch {
    // Observabilidade nao pode tornar a execucao indisponivel.
  }
  return record;
}

// Patterns that identify rate-limit / quota responses in AGY output.
const QUOTA_PATTERNS = [
  /QUOTA_EXAUSTED/,
  /individual quota reached/i,
  /upgrade your subscription/i,
  /quota reached/i,
  /quota.*exceeded/i,
  /rate.?limit/i,
  /resource.?exhausted/i,
  /\b429\b/,
  /too many requests/i,
  /daily.*limit/i,
];

const AUTH_PATTERNS = [
  /not authenticated/i,
  /authentication.*required/i,
  /please.{0,20}sign.?in/i,
  /\bunauthorized\b/i,
  /\b401\b/,
];

const USAGE = `Usage:
  node "\${CLAUDE_PLUGIN_ROOT}/scripts/antigravity-bridge.js" [options] <task>

Options:
  --task <text>              Explicit task text.
  --task-file <path>         Read task text from a file instead of argv. Protects the
                             caller-to-bridge hop from OS command-line limits. The
                             bridge-to-agy hop streams large headless prompts over stdin,
                             so it has no size budget either (see --use-stdin). Alias:
                             --prompt-file. Mutually exclusive with --task and positional
                             task text.
  --dirs <path,...>          Directories to ingest recursively.
  --add-dir <path>           Add a directory to AGY's native workspace. Repeatable.
                             Default: current working directory (added automatically).
  --files <glob,...>         File globs to ingest.
  --priority-files <path,...> Relative paths to prioritize before the --max-files cutoff.
                             Without this, files are kept in plain alphabetical order, so
                             a large match set silently drops whichever paths sort last.
  --design-system <dir,...>  Open Design package(s) to hand to AGY without truncation. Uses
                             <dir>/resolved when present. Core files (design-contract.json,
                             DESIGN.md, tokens.css, components.css, components.html, USAGE.md,
                             components.manifest.json, assets/manifest.json) are inlined in
                             full, ahead of and outside --max-files/--max-file-bytes; every
                             other package file is listed for on-demand view_file reads.
  --format <format>          Headless output: text, json, or stream-json. Default: json.
  --model <name>             Model slug or natural-language alias. Resolved dynamically from \`agy models\`.
                             Omitted when not requested so AGY honors the user's own /model setting.
                             Use \`auto\` to select a tier from the newest available Flash family.
  --effort <level>           Reasoning effort: low, medium, or high.
  --mode <mode>              Permission mode: plan or accept-edits.
  --json-schema <value>      JSON Schema string or path. Implies --format json.
  --disable-slash-commands   Treat task text as data (default headless, except --read-only;
                             AGY 1.1.16 otherwise ignores --mode plan). Passing it explicitly
                             with --read-only is honored (task text stays data instead of
                             being interpreted as a slash command).
  --allow-slash-commands     Allow slash-command and skill expansion in headless prompts.
  --generate-image           Generate an image using AGY's generate_imagem tool.
                             Does not override the selected model.
                             Alias: --generate-imagem.
  --parallel                 Allow AGY to fan the task out across multiple native Gemini subagents
                             (DefineSubagent / invoke_subagent / ManageSubagents). AGY decides how
                             many subagents to spawn based on the task's independent subparts.
  --subagent-model <name>    Model the spawned subagents should use. Conveyed via the prompt (AGY has
                             no per-subagent CLI flag). Implies --parallel. Defaults to the main model.
  --timeout <duration>       Forwarded to agy as --print-timeout (for example: 3m, 300s).
  --interactive              Use agy --prompt-interactive instead of --print.
                             Requires PTY support and an interactive terminal (TTY).
                             With --generate-image, accepted as a compatibility hint and
                             normalized to supervised headless stream-json mode.
  --agent <name>             Select an AGY custom agent. Use --interactive for a PTY session.
  --read-only                Imply --mode plan, disable --dangerously-skip-permissions, and
                             disable workspace auto-add.
  --continue, -c             Continue the most recent AGY conversation.
  --conversation <id>        Resume a specific AGY conversation.
  --sandbox                  Enable AGY sandbox mode.
  --skip-permissions         Explicitly forward --dangerously-skip-permissions (on by default).
  --max-files <n>            Maximum --dirs/--files files to inline (--design-system core
                             files are exempt). Default: 40.
  --max-file-bytes <n>       Maximum bytes per --dirs/--files file. Default: 32768.
  --use-stdin, --stdin       Force streaming the prompt to agy over stdin instead of
                             --print <prompt>. Automatic for headless prompts above 8,191
                             chars on Windows and 100,000 chars elsewhere. --interactive
                             always passes the prompt in argv.
  --output-file <path>       Write the full AGY output to a file instead of streaming to
                             stdout. Only the resolved file path is printed to stdout.
                             Designed for callers that use the Read tool: pass this flag,
                             get the path back from the Bash tool, then Read the file.
                             Immune to sandbox pipe limits and stdout buffering.
  --dump-prompt <path>       Write the exact prompt sent to AGY for this run to <path>,
                             plus a JSON sidecar at "<path>.audit.json" with
                             { promptChars, limit, transport, degraded, droppedFiles,
                               included, skipped, designSystems }.
                             Reflects the real run (post prompt-overflow fallback), not a
                             dry run. Prints "BRIDGE_CONTEXT_REPORT: <path>" to stderr.
  --print-command            Print the resolved agy command and exit.
  -h, --help                 Show this help message.

Defaults:
  Agentic mode is ON by default: --dangerously-skip-permissions is forwarded and the current
  working directory is added to AGY's workspace via --add-dir. Pass --read-only to disable.

Exit codes:
   0  Success
   1  Generic error       — also EMPTY_RESPONSE well within the timeout window
  10  QUOTA_EXAUSTED  — quota or rate limit hit; workflow should retry or pause
  11  AUTH_REQUIRED   — AGY needs interactive sign-in (run \`agy\` once)
  12  TIMEOUT         — AGY did not respond within the configured timeout,
                        including EMPTY_RESPONSE close to the effective timeout
  13  AGY_MISSING     — Antigravity CLI not found on PATH

  EMPTY_RESPONSE: an empty response and exit 0 from agy is never treated as
  success, with or without --output-file (including plain stdout redirection,
  e.g. \`> file.json\`) — it is classified (bridge.classified in the log, and a
  {"status":"EMPTY_RESPONSE",...} line on stdout) and exits 1 or 12 depending
  on how close to the effective timeout it happened. With --output-file, the
  0-byte file is never written.

Logging:
  Plugin events are always written to a JSONL log file. Every invocation logs
  exactly one terminal \`bridge.exit\` event ({exitCode, durationMs, model,
  conversationId, outputBytes, classified}), regardless of which code path
  returned — a headless run used to end at \`bridge.agy.args.built\` with no
  way to tell "finished with code 0" from "process was killed".
    Windows:     %LOCALAPPDATA%\\agy\\cc-plugin-logs\\plugin-YYYY-MM-DD.jsonl
    macOS/Linux: ~/.local/share/agy/cc-plugin-logs/plugin-YYYY-MM-DD.jsonl
  Override:      CC_ANTIGRAVITY_LOG_PATH=<path>
  Include output chunks in log: CC_ANTIGRAVITY_LOG_OUTPUT=1
`;

function summarizeParsedArgs(parsed) {
  return {
    dirs: parsed.dirs,
    addDirs: parsed.addDirs,
    files: parsed.files,
    priorityFiles: parsed.priorityFiles,
    designSystems: parsed.designSystems,
    useStdin: parsed.useStdin,
    taskFile: parsed.taskFile,
    dumpPromptPath: parsed.dumpPromptPath,
    format: parsed.format,
    model: parsed.model,
    effort: parsed.effort,
    mode: parsed.mode,
    agent: parsed.agent,
    jsonSchema: parsed.jsonSchema,
    disableSlashCommands: parsed.disableSlashCommands,
    timeout: parsed.timeout,
    interactive: parsed.interactive,
    readOnly: parsed.readOnly,
    continueConversation: parsed.continueConversation,
    conversationId: parsed.conversationId,
    sandbox: parsed.sandbox,
    skipPermissions: parsed.skipPermissions,
    maxFiles: parsed.maxFiles,
    maxFileBytes: parsed.maxFileBytes,
    printCommand: parsed.printCommand,
    generateImagem: parsed.generateImagem,
    outputFile: parsed.outputFile,
    parallel: parsed.parallel,
    subagentModel: parsed.subagentModel,
    help: parsed.help,
    taskLength: parsed.task.length,
  };
}

function summarizeContext(context) {
  return {
    includedCount: context.included.length,
    skippedCount: context.skipped.length,
    included: context.included.map((file) => ({
      path: file.path,
      mediaType: file.mediaType,
      bytes: file.bytes,
      truncated: file.truncated,
    })),
    skipped: context.skipped,
    designSystems: context.designSystems ?? [],
  };
}

function summarizeAgyArgs(args) {
  const summarized = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    summarized.push(arg);
    if ((arg === "--print" || arg === "--prompt-interactive") && index + 1 < args.length) {
      summarized.push(`<prompt:${args[index + 1].length} chars>`);
      index += 1;
    }
  }
  return summarized;
}

function shouldLogAgyOutput() {
  return process.env.CC_ANTIGRAVITY_LOG_OUTPUT === "1";
}

function splitList(value) {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeSlashes(relativePath) {
  return relativePath.split(path.sep).join("/");
}

function relativeToCwd(cwd, targetPath) {
  return normalizeSlashes(path.relative(cwd, targetPath));
}

function getMediaType(filePath) {
  return MEDIA_TYPES.get(path.extname(filePath).toLowerCase()) ?? "text/plain";
}

function isIgnoredPath(relativePath) {
  return relativePath
    .split("/")
    .some((segment) => IGNORED_PATH_SEGMENTS.has(segment));
}

function isBinaryCandidate(filePath, buffer) {
  if (KNOWN_BINARY_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
    return true;
  }

  return buffer.includes(0);
}

function parsePositiveInteger(rawValue, flagName) {
  const value = Number.parseInt(rawValue, 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${flagName} must be a positive integer. Received: ${rawValue}`);
  }
  return value;
}

function takeOptionValue(argv, index, flagName) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flagName}.`);
  }
  return value;
}

export function parseAgyJsonResult(stdout) {
  let envelope;
  try {
    envelope = typeof stdout === "string" ? JSON.parse(stdout.trim()) : stdout;
  } catch (error) {
    throw new Error(
      `AGY returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    throw new Error("AGY returned an invalid JSON envelope.");
  }
  return {
    conversationId: envelope.conversation_id ?? "",
    status: envelope.status ?? "",
    response: envelope.response ?? "",
    error: envelope.error ?? "",
    durationSeconds: envelope.duration_seconds ?? 0,
    numTurns: envelope.num_turns ?? 0,
    usage: envelope.usage ?? undefined,
  };
}

// Classifies structured JSON envelopes first (scanning only their status/error
// fields, never the response body, so a successful task that legitimately talks
// about rate limits or 401s is never misclassified). When there is no envelope —
// a raw-text caller, or a failed/empty JSON parse upstream — text scanning kicks
// in, gated by the process's own exit code: a clean exit (0) is never scanned,
// because the response text itself can discuss the same vocabulary without that
// being a failure of this call to AGY. When the exit code is unknown and the
// caller didn't ask for text-format scanning, this preserves the old
// conservative default of not classifying at all.
export function classifyAgyOutput(output, { format = "text", exitCode } = {}) {
  const envelope = output && typeof output === "object" ? output : null;
  const diagnostic = envelope
    ? `${envelope.status ?? ""}\n${envelope.error ?? ""}`
    : String(output ?? "");
  if (!envelope) {
    if (exitCode === 0) return null;
    if (format !== "text" && exitCode == null) return null;
  }
  if (QUOTA_PATTERNS.some((p) => p.test(diagnostic))) {
    const reasonMatch = diagnostic.match(/QUOTA_EXAUSTED\s+reason="([^"]+)"/);
    const reason = envelope?.error || (reasonMatch ? reasonMatch[1] : "quota or rate limit reached");
    return { type: "QUOTA_EXAUSTED", reason, exitCode: EXIT_QUOTA_EXAUSTED };
  }
  if (AUTH_PATTERNS.some((p) => p.test(diagnostic))) {
    return {
      type: "AUTH_REQUIRED",
      reason: envelope?.error || "authentication required — run `agy` once interactively to sign in",
      exitCode: EXIT_AUTH_REQUIRED,
    };
  }
  return null;
}

// Emits a single machine-readable JSON line that orchestrators / Claude Code can parse.
// Quota signals include the exact conversation when AGY returned one.
function emitStructuredSignal(type, reason, model, result, _stdout) {
  const signal = { status: type, reason, model };
  if (result?.conversationId) signal.conversation_id = result.conversationId;
  if (result?.usage) signal.usage = result.usage;
  if (type === "QUOTA_EXAUSTED") {
    signal.retry = result?.conversationId
      ? `--conversation ${result.conversationId}`
      : "--continue";
  }
  _stdout.write(JSON.stringify(signal) + "\n");
}

export function parseCliArgs(argv) {
  const parsed = {
    dirs: [],
    addDirs: [],
    files: [],
    priorityFiles: [],
    designSystems: [],
    taskFile: undefined,
    promptFile: undefined,
    useStdin: false,
    dumpPromptPath: undefined,
    format: "json",
    model: undefined,
    effort: undefined,
    mode: undefined,
    agent: undefined,
    jsonSchema: undefined,
    disableSlashCommands: true,
    timeout: undefined,
    interactive: false,
    readOnly: false,
    continueConversation: false,
    conversationId: undefined,
    sandbox: false,
    skipPermissions: true,   // agentic by default; --read-only disables
    maxFiles: DEFAULT_MAX_FILES,
    maxFileBytes: DEFAULT_MAX_FILE_BYTES,
    printCommand: false,
    generateImagem: false,
    outputFile: undefined,
    outputDir: undefined,
    parallel: false,
    subagentModel: undefined,
    task: "",
    help: false,
  };

  const taskTokens = [];
  // Tracked separately from parsed.skipPermissions (which the --skip-permissions
  // case above still mutates immediately) so --read-only can be enforced as a
  // terminal boundary after the loop, regardless of flag order.
  let sawSkipPermissionsFlag = false;
  // Tracked separately from parsed.disableSlashCommands for the same reason:
  // a real run (OficinaAI, 2026-09-22) passed --read-only --disable-slash-commands
  // together, expecting the task text to be treated as data, but the read-only
  // block below used to force disableSlashCommands back to false unconditionally
  // — discarding the explicit flag — which let AGY's slash-command expansion
  // reinterpret --mode plan as if the user had typed the bare "/plan" slash
  // command with no goal, instead of running the read-only review task at all.
  let sawDisableSlashCommandsFlag = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === "--") {
      taskTokens.push(...argv.slice(index + 1));
      break;
    }

    switch (token) {
      case "-h":
      case "--help":
        parsed.help = true;
        break;
      case "--task":
        parsed.task = takeOptionValue(argv, index, token);
        index += 1;
        break;
      case "--task-file":
        parsed.taskFile = takeOptionValue(argv, index, token);
        index += 1;
        break;
      case "--prompt-file":
        parsed.promptFile = takeOptionValue(argv, index, token);
        index += 1;
        break;
      case "--use-stdin":
      case "--stdin":
        parsed.useStdin = true;
        break;
      case "--dirs":
        parsed.dirs.push(...splitList(takeOptionValue(argv, index, token)));
        index += 1;
        break;
      case "--add-dir":
        parsed.addDirs.push(takeOptionValue(argv, index, token));
        index += 1;
        break;
      case "--files":
        parsed.files.push(...splitList(takeOptionValue(argv, index, token)));
        index += 1;
        break;
      case "--priority-files":
        parsed.priorityFiles.push(...splitList(takeOptionValue(argv, index, token)));
        index += 1;
        break;
      case "--design-system":
        parsed.designSystems.push(...splitList(takeOptionValue(argv, index, token)));
        index += 1;
        break;
      case "--dump-prompt":
        parsed.dumpPromptPath = takeOptionValue(argv, index, token);
        index += 1;
        break;
      case "--model":
        parsed.model = takeOptionValue(argv, index, token);
        index += 1;
        break;
      case "--timeout":
        parsed.timeout = takeOptionValue(argv, index, token);
        index += 1;
        break;
      case "--interactive":
        parsed.interactive = true;
        break;
      case "--agent":
        try {
          parsed.agent = takeOptionValue(argv, index, token);
        } catch {
          throw new Error("Missing value for --agent. Use --interactive for an interactive PTY session.");
        }
        index += 1;
        break;
      case "--effort": {
        const effort = takeOptionValue(argv, index, token);
        if (!SUPPORTED_EFFORTS.has(effort)) {
          throw new Error(
            `Unsupported --effort value "${effort}". Expected one of: ${[...SUPPORTED_EFFORTS].join(", ")}`,
          );
        }
        parsed.effort = effort;
        index += 1;
        break;
      }
      case "--mode": {
        const mode = takeOptionValue(argv, index, token);
        if (!SUPPORTED_MODES.has(mode)) {
          throw new Error(
            `Unsupported --mode value "${mode}". Expected one of: ${[...SUPPORTED_MODES].join(", ")}`,
          );
        }
        parsed.mode = mode;
        index += 1;
        break;
      }
      case "--json-schema":
        parsed.jsonSchema = takeOptionValue(argv, index, token);
        index += 1;
        break;
      case "--disable-slash-commands":
        parsed.disableSlashCommands = true;
        sawDisableSlashCommandsFlag = true;
        break;
      case "--allow-slash-commands":
        parsed.disableSlashCommands = false;
        break;
      case "--read-only":
        parsed.readOnly = true;
        parsed.skipPermissions = false;
        break;
      case "--continue":
      case "-c":
        parsed.continueConversation = true;
        break;
      case "--conversation":
        parsed.conversationId = takeOptionValue(argv, index, token);
        index += 1;
        break;
      case "--sandbox":
        parsed.sandbox = true;
        break;
      case "--skip-permissions":
        parsed.skipPermissions = true;
        sawSkipPermissionsFlag = true;
        break;
      case "--format": {
        const format = takeOptionValue(argv, index, token);
        if (!SUPPORTED_FORMATS.has(format)) {
          throw new Error(
            `Unsupported --format value "${format}". Expected one of: ${[
              ...SUPPORTED_FORMATS,
            ].join(", ")}`,
          );
        }
        parsed.format = format;
        index += 1;
        break;
      }
      case "--max-files":
        parsed.maxFiles = parsePositiveInteger(takeOptionValue(argv, index, token), token);
        index += 1;
        break;
      case "--max-file-bytes":
        parsed.maxFileBytes = parsePositiveInteger(
          takeOptionValue(argv, index, token),
          token,
        );
        index += 1;
        break;
      case "--print-command":
        parsed.printCommand = true;
        break;
      case "--generate-imagem":
      case "--generate-image":
        parsed.generateImagem = true;
        break;
      case "--parallel":
        parsed.parallel = true;
        break;
      case "--subagent-model":
        parsed.subagentModel = takeOptionValue(argv, index, token);
        parsed.parallel = true;   // a subagent model is meaningless without fan-out
        index += 1;
        break;
      case "--output-file":
        parsed.outputFile = takeOptionValue(argv, index, token);
        index += 1;
        break;
      case "--output-dir":
        parsed.outputDir = takeOptionValue(argv, index, token);
        index += 1;
        break;
      default:
        taskTokens.push(token);
        break;
    }
  }

  if (!parsed.task) {
    parsed.task = taskTokens.join(" ").trim();
  }

  if (parsed.promptFile && !parsed.taskFile) {
    parsed.taskFile = parsed.promptFile;
  }

  if (parsed.taskFile) {
    if (parsed.task) {
      throw new Error("Use either --task-file or an explicit task/--task, not both.");
    }
    let fileContent;
    try {
      fileContent = fs.readFileSync(path.resolve(parsed.taskFile), "utf8");
    } catch (error) {
      throw new Error(
        `Failed to read --task-file "${parsed.taskFile}": ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    parsed.task = fileContent;
  }

  if (parsed.readOnly) {
    // --read-only is a hard boundary: enforced last, independent of flag order,
    // so no later --skip-permissions can escalate a run that was requested as
    // read-only. An explicit conflicting flag is rejected rather than silently
    // overridden.
    if (sawSkipPermissionsFlag) {
      throw new Error(
        "--read-only cannot be combined with --skip-permissions: that would grant write " +
          "access in a run requested as read-only.",
      );
    }
    parsed.mode = "plan";
    parsed.skipPermissions = false;
    // AGY 1.1.16 warns that --mode plan has no effect while slash expansion is
    // disabled, so the default for read-only (no explicit flag either way) is
    // to enable expansion. But an explicit --disable-slash-commands is the
    // caller asking for the task text to be treated as data — honor it rather
    // than silently discarding it, since AGY has no other way to distinguish
    // "review this text" from "run this slash command".
    if (!sawDisableSlashCommandsFlag) {
      parsed.disableSlashCommands = false;
    }
  }
  if (parsed.jsonSchema) parsed.format = "json";

  if (!parsed.help && !parsed.task && parsed.agent) {
    throw new Error(
      "--agent now selects a named AGY agent and also requires a task. " +
        "Use --interactive for an interactive PTY session.",
    );
  }

  if (!parsed.help && !parsed.task) {
    throw new Error("A task is required.\n\n" + USAGE);
  }

  return parsed;
}

function walkDirSync(dir, baseCwd = dir) {
  const results = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (IGNORED_PATH_SEGMENTS.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkDirSync(fullPath, baseCwd));
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }
  return results;
}

function escapeRegex(raw) {
  return raw.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globToRegExp(pattern) {
  const normalized = normalizeSlashes(pattern);
  let source = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const next = normalized[index + 1];

    if (char === "*") {
      if (next === "*") {
        const afterGlobstar = normalized[index + 2];
        if (afterGlobstar === "/") {
          source += "(?:.*\\/)?";
          index += 2;
        } else {
          source += ".*";
          index += 1;
        }
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += escapeRegex(char);
    }
  }
  return new RegExp(`^${source}$`);
}

function collectDirectoryMatches(cwd, dirPath) {
  const absoluteDir = path.resolve(cwd, dirPath.replace(/[\\/]+$/, ""));
  return walkDirSync(absoluteDir);
}

function collectPatternMatches(cwd, patterns) {
  if (patterns.length === 0) return [];
  const workspaceRoot = path.resolve(cwd);
  const matchers = patterns.map(globToRegExp);
  return walkDirSync(workspaceRoot).filter((absolutePath) => {
    const rel = relativeToCwd(workspaceRoot, absolutePath);
    return matchers.some((m) => m.test(rel));
  });
}

export async function collectContextFiles({
  cwd,
  dirs = [],
  patterns = [],
  maxFiles,
  maxFileBytes,
  priorityPaths = [],
}) {
  const workspaceRoot = path.resolve(cwd);
  const allMatches = new Set();

  for (const dirPath of dirs) {
    for (const match of collectDirectoryMatches(cwd, dirPath)) {
      allMatches.add(path.resolve(workspaceRoot, match));
    }
  }

  for (const match of collectPatternMatches(cwd, patterns)) {
    allMatches.add(path.resolve(workspaceRoot, match));
  }

  const included = [];
  const skipped = [];

  // Priority ranking runs before the max-files cutoff so a caller can protect files
  // it already knows matter (e.g. from the task classification) from being dropped by
  // plain alphabetical order. With no priorityPaths, every match ranks equally and the
  // result is identical to a pure localeCompare sort — unchanged default behavior.
  const prioritySet = new Set(priorityPaths.map((entry) => normalizeSlashes(entry)));
  const rankedMatches = [...allMatches]
    .map((absolutePath) => ({ absolutePath, relativePath: relativeToCwd(cwd, absolutePath) }))
    .sort((left, right) => {
      const leftRank = prioritySet.has(left.relativePath) ? 0 : 1;
      const rightRank = prioritySet.has(right.relativePath) ? 0 : 1;
      if (leftRank !== rightRank) return leftRank - rightRank;
      return left.relativePath.localeCompare(right.relativePath);
    });

  for (const { absolutePath, relativePath } of rankedMatches) {
    if (isIgnoredPath(relativePath)) {
      skipped.push({ path: relativePath, reason: "ignored-path" });
      continue;
    }

    if (included.length >= maxFiles) {
      skipped.push({ path: relativePath, reason: "max-files-exceeded" });
      continue;
    }

    try {
      const stat = await fsp.stat(absolutePath);
      if (!stat.isFile()) {
        skipped.push({ path: relativePath, reason: "not-a-file" });
        continue;
      }

      const fileBuffer = await fsp.readFile(absolutePath);
      if (isBinaryCandidate(absolutePath, fileBuffer)) {
        skipped.push({ path: relativePath, reason: "unsupported-extension" });
        continue;
      }

      const truncated = fileBuffer.length > maxFileBytes;
      const trimmedBuffer = truncated ? fileBuffer.subarray(0, maxFileBytes) : fileBuffer;

      let content;
      try {
        // Use fatal decode for non-truncated files so invalid encodings (e.g. Windows-1252)
        // are caught early. Truncated buffers may cut a multi-byte sequence mid-stream, so
        // fall back to the lenient decoder which replaces invalid sequences silently.
        content = truncated
          ? trimmedBuffer.toString("utf8")
          : new TextDecoder("utf-8", { fatal: true }).decode(trimmedBuffer);
      } catch {
        skipped.push({ path: relativePath, reason: "encoding-error" });
        continue;
      }

      included.push({
        path: relativePath,
        mediaType: getMediaType(absolutePath),
        bytes: fileBuffer.length,
        truncated,
        content,
      });
    } catch (error) {
      skipped.push({
        path: relativePath,
        reason: error instanceof Error ? `read-error: ${error.message}` : "read-error",
      });
    }
  }

  return { included, skipped };
}

function hasDesignSystemMarker(dir) {
  return ["design-contract.json", "DESIGN.md", "tokens.css"].some((name) =>
    fs.existsSync(path.join(dir, name)),
  );
}

// Resolves --design-system packages into inline context. Unlike --dirs, a package's core
// files are never cut by --max-files nor truncated by --max-file-bytes: a visual contract
// that reaches the model half-read is worse than none. The rest of the package (previews,
// kits, sources, assets) is only listed, so AGY can view_file what a decision needs.
export async function collectDesignSystemContext({ cwd, designSystems = [] }) {
  const packages = [];
  const included = [];
  const skipped = [];

  for (const entry of designSystems) {
    const requestedRoot = path.resolve(cwd, entry);
    const resolvedRoot = path.join(requestedRoot, "resolved");
    const packageRoot = hasDesignSystemMarker(resolvedRoot) ? resolvedRoot : requestedRoot;
    if (!hasDesignSystemMarker(packageRoot)) {
      throw new Error(
        `--design-system "${entry}" is not an Open Design package: expected ` +
          `design-contract.json, DESIGN.md or tokens.css in ${packageRoot}.`,
      );
    }

    const coreFiles = [];
    const handledPaths = new Set();
    for (const name of DESIGN_SYSTEM_CORE_FILES) {
      const absolutePath = path.join(packageRoot, name);
      let buffer;
      try {
        if (!(await fsp.stat(absolutePath)).isFile()) continue;
        buffer = await fsp.readFile(absolutePath);
      } catch {
        continue;
      }
      const relativePath = relativeToCwd(cwd, absolutePath);
      handledPaths.add(relativePath);
      if (isBinaryCandidate(absolutePath, buffer)) {
        skipped.push({ path: relativePath, reason: "unsupported-extension" });
        continue;
      }
      const truncated = buffer.length > DESIGN_SYSTEM_MAX_FILE_BYTES;
      included.push({
        path: relativePath,
        mediaType: getMediaType(absolutePath),
        bytes: buffer.length,
        truncated,
        content: (truncated ? buffer.subarray(0, DESIGN_SYSTEM_MAX_FILE_BYTES) : buffer).toString("utf8"),
      });
      coreFiles.push(relativePath);
    }

    const onDemand = walkDirSync(packageRoot)
      .map((absolutePath) => relativeToCwd(cwd, absolutePath))
      .filter((relativePath) => !handledPaths.has(relativePath))
      .sort((left, right) => left.localeCompare(right));
    for (const relativePath of onDemand) {
      skipped.push({ path: relativePath, reason: "design-system-on-demand" });
    }

    const rootName = path.basename(packageRoot);
    packages.push({
      id: rootName === "resolved" ? path.basename(path.dirname(packageRoot)) : rootName,
      root: relativeToCwd(cwd, packageRoot) || ".",
      coreFiles,
      onDemandCount: onDemand.length,
    });
  }

  return { packages, included, skipped };
}

// Design files go first so they are the last ones an argv-budget fallback drops, and a
// --dirs walk that also covers the package cannot re-add them truncated.
export function mergeDesignSystemContext(designContext, generalContext) {
  const corePaths = new Set(designContext.included.map((file) => file.path));
  const generalIncluded = generalContext.included.filter((file) => !corePaths.has(file.path));
  const generalIncludedPaths = new Set(generalIncluded.map((file) => file.path));
  const designSkipped = designContext.skipped.filter((entry) => !generalIncludedPaths.has(entry.path));
  const designSkippedPaths = new Set(designSkipped.map((entry) => entry.path));
  const generalSkipped = generalContext.skipped.filter(
    (entry) => !corePaths.has(entry.path) && !designSkippedPaths.has(entry.path),
  );
  return {
    included: [...designContext.included, ...generalIncluded],
    skipped: [...designSkipped, ...generalSkipped],
    designSystems: designContext.packages,
  };
}

export function resolvePromptTransport({
  promptLength,
  platform = process.platform,
  interactive = false,
  forceStdin = false,
}) {
  // `--prompt-interactive` under a PTY has no stdin channel for the prompt.
  if (interactive) return "argv";
  if (forceStdin) return "stdin";
  const argvSafeChars = platform === "win32" ? WIN_ARGV_SAFE_CHARS : POSIX_ARGV_SAFE_CHARS;
  return promptLength > argvSafeChars ? "stdin" : "argv";
}

// Drops inline files from the end of `included` (lowest priority first) one at a time
// until the prompt fits, instead of discarding the whole context at once.
export function fitContextToPromptBudget({
  context,
  buildPrompt,
  limit,
  reason = "prompt-overflow-windows",
}) {
  const included = [...context.included];
  const dropped = [];
  const snapshot = () => ({
    ...context,
    included: [...included],
    skipped: [...context.skipped, ...dropped],
  });
  let current = snapshot();
  let prompt = buildPrompt(current);
  while (prompt.length > limit && included.length > 0) {
    const file = included.pop();
    dropped.unshift({ path: file.path, reason });
    current = snapshot();
    prompt = buildPrompt(current);
  }
  return { prompt, context: current, droppedFiles: dropped.length };
}

// Returns "" without packages so the default prompt stays byte-for-byte unchanged.
export function buildDesignSystemBlock(packages = []) {
  if (!packages || packages.length === 0) return "";
  return packages
    .map(
      (pkg) => `

<design_system id="${pkg.id}" root="${pkg.root}">
- Authoritative visual package. Its core files are inlined in full in <context_files>: ${pkg.coreFiles.join(", ") || "none"}.
- Build UI from its tokens (var(--*)) and the component patterns and states in components.html; do not invent colors, spacing, radii, shadows or font stacks.
- Import components.css (when present) in the global stylesheet right after tokens.css: it is the only component stylesheet of the package. Never copy preview CSS or the scaffolding classes of components.html (.page, .scope, .grid, .state) into the product.
- ${pkg.onDemandCount} other package file(s) are listed in <context_inventory> as design-system-on-demand; read them with view_file only when a decision needs them.
- "${pkg.id}" identifies where this package came from, not the product being built. Never put that name or its brand wordmarks into product UI text, page titles, metadata, alt text or code comments unless the task explicitly asks for it.
</design_system>`,
    )
    .join("");
}

// Builds the optional <parallelism> block appended to the constraints when --parallel is set.
// Returns "" when parallelism is disabled so the default prompt stays byte-for-byte unchanged.
export function buildParallelismBlock({ parallel = false, subagentModel } = {}) {
  if (!parallel) return "";
  const modelLine = subagentModel
    ? `- Configure each subagent to use the model "${subagentModel}".\n`
    : "";
  const decompositionVerb = subagentModel ? "MUST" : "MAY";
  const spawnConstraint = subagentModel
    ? "- Each independent part of the task MUST be handled by a dedicated subagent."
    : "- Spawn subagents only for genuinely independent work; keep shared or sequential steps in the main agent.";
  return `

<parallelism>
- You ${decompositionVerb} decompose this task into independent subtasks and run them concurrently using your
  native subagent tools (DefineSubagent, invoke_subagent / Agent, ManageSubagents).
${spawnConstraint}
- Decide the number of subagents yourself based on how many independent subparts the task has.
${modelLine}- Wait for every subagent to finish (poll with ManageSubagents) before concluding.
- Aggregate the subagents' outputs into one final report, and list each subagent's purpose and conversation ID.
</parallelism>`;
}

export function buildAntigravityPrompt({
  task,
  context,
  parallel = false,
  subagentModel,
  readOnly = false,
}) {
  const inventoryLines = [];

  if (context.included.length > 0) {
    inventoryLines.push("Included files:");
    for (const file of context.included) {
      inventoryLines.push(
        `- ${file.path} | ${file.mediaType} | ${file.bytes} bytes | truncated=${file.truncated}`,
      );
    }
  } else {
    inventoryLines.push("Included files: none");
  }

  if (context.skipped.length > 0) {
    inventoryLines.push("Skipped files:");
    for (const skipped of context.skipped) {
      inventoryLines.push(`- ${skipped.path} (${skipped.reason})`);
    }
  }

  const fileBlocks =
    context.included.length === 0
      ? "No inline file payloads were collected."
      : context.included
          .map(
            (file) => `<file path="${file.path}" media_type="${file.mediaType}" truncated="${file.truncated}">
${file.content.replaceAll("</", "<\\/")}
</file>`,
          )
          .join("\n\n");

  const executionConstraints = readOnly
    ? `- You are a read-only analysis assistant. Analyze, inspect, and report without modifying files.
- Do not call write_to_file, replace_file_content, multi_replace_file_content, or run_command.
- Inspect the workspace only with grep_search, view_file, and list_dir. Headless read-only runs cannot
  approve the "command" permission, so any run_command call is auto-denied and aborts the analysis
  with no output (observed in a real front-end review, OficinaAI 2026-09-22).`
    : `- You are an agentic coding assistant. Complete the task fully using your available tools.
- Use write_to_file, replace_file_content, and multi_replace_file_content to create and edit files.
- Use grep_search, view_file, and list_dir to explore and search the workspace.
- Use run_command to execute shell commands when needed.`;
  const completionConstraint = readOnly
    ? "- Complete the entire analysis without stopping mid-way. Report findings and cited paths at the end."
    : "- Complete the entire task without stopping mid-way. Report all changes made at the end.";

  return `<context_inventory>
${inventoryLines.join("\n")}
</context_inventory>

<context_files>
${fileBlocks}
</context_files>${buildDesignSystemBlock(context.designSystems)}

<task>
${task}
</task>

<constraints>
${executionConstraints}
- Use the provided inline context when relevant; cite file paths when referencing it.
- If inline context is partial or truncated, read the full files with view_file before acting.
${completionConstraint}
- If you hit a quota or rate limit, immediately output on its own line and then stop:
  QUOTA_EXAUSTED reason="<specific reason>" model="<model name>"
</constraints>${buildParallelismBlock({ parallel, subagentModel })}`;
}

export function buildImagePrompt({ task, context }) {
  const inventoryLines = [];

  if (context.included.length > 0) {
    inventoryLines.push("Included files:");
    for (const file of context.included) {
      inventoryLines.push(
        `- ${file.path} | ${file.mediaType} | ${file.bytes} bytes | truncated=${file.truncated}`,
      );
    }
  } else {
    inventoryLines.push("Included files: none");
  }

  if (context.skipped.length > 0) {
    inventoryLines.push("Skipped files:");
    for (const skipped of context.skipped) {
      inventoryLines.push(`- ${skipped.path} (${skipped.reason})`);
    }
  }

  const fileBlocks =
    context.included.length === 0
      ? "No inline file payloads were collected."
      : context.included
          .map(
            (file) => `<file path="${file.path}" media_type="${file.mediaType}" truncated="${file.truncated}">
${file.content.replaceAll("</", "<\\/")}
</file>`,
          )
          .join("\n\n");

  return `<context_inventory>
${inventoryLines.join("\n")}
</context_inventory>

<context_files>
${fileBlocks}
</context_files>

<task>
${task}
</task>

<constraints>
- You are an image generation assistant. Call the generate_image tool exactly once.
- Pass the exact description from the task above as the image prompt and request its stated aspect ratio.
- Do not call grep_search, view_file, list_dir, run_command, write_to_file, or any other tool.
- Do not inspect the workspace and do not try to copy the generated file. The caller observes and copies the
  image from this conversation's private output directory.
- As soon as generate_image returns, reply only IMAGE_GENERATION_COMPLETE and stop immediately.
- If inline context files are provided, use them to inform the visual style or content of the image.
- If you hit a quota or rate limit, immediately output on its own line and then stop:
  QUOTA_EXAUSTED reason="<specific reason>" model="<model name>"
</constraints>`;
}

export function buildAntigravityArgs({
  prompt,
  model,
  format = "json",
  effort,
  mode,
  agent,
  jsonSchema,
  disableSlashCommands = true,
  timeout,
  interactive = false,
  continueConversation = false,
  conversationId,
  addDirs = [],
  sandbox = false,
  skipPermissions = false,
  useStdin = false,
} = {}) {
  const args = [];
  if (continueConversation) args.push("--continue");
  if (conversationId) args.push("--conversation", conversationId);
  for (const dir of addDirs) {
    args.push("--add-dir", dir);
  }
  if (sandbox) args.push("--sandbox");
  if (skipPermissions) args.push("--dangerously-skip-permissions");
  if (model) args.push("--model", model);
  if (effort) args.push("--effort", effort);
  if (mode) args.push("--mode", mode);
  if (agent) args.push("--agent", agent);
  if (interactive) {
    args.push("--prompt-interactive", prompt);
  } else {
    args.push("--output-format", format);
    if (jsonSchema) args.push("--json-schema", jsonSchema);
    if (disableSlashCommands) args.push("--disable-slash-commands");
    if (!useStdin && prompt !== undefined) {
      args.push("--print", prompt);
    }
    // Sempre explicito: sem isso, agy usa seu proprio default de 5 min quando
    // `--timeout` nao e informado, silenciosamente mais curto que o
    // CONPTY_TIMEOUT_MS de 10 min do bridge. Numa run real, 7 de 9 dispatches
    // sem `--timeout` morreram aos ~5m05s gravando `bytes: 0` e exit de
    // sucesso — nenhum `bridge.classified`/`bridge.error` no log, porque o
    // bridge nunca soube que havia um timeout em jogo (Achado 7).
    args.push("--print-timeout", timeout || `${CONPTY_TIMEOUT_MS}ms`);
  }
  return args;
}

export function resolveAgyExe(_spawnSync = spawnSync, _fs = fs) {
  const isWin = process.platform === "win32";
  const whichCmd = isWin ? "where" : "which";
  const result = _spawnSync(whichCmd, ["agy"], { encoding: "utf8", shell: false });
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  if (result.status === 0 && stdout.trim()) {
    return stdout.trim().split(/\r?\n/)[0];
  }
  if (isWin) {
    return path.join(
      process.env.LOCALAPPDATA ?? path.join(process.env.USERPROFILE ?? "", "AppData", "Local"),
      "agy",
      "bin",
      "agy.exe",
    );
  }

  const home = process.env.HOME ?? "";
  for (const candidate of [path.join(home, ".local", "bin", "agy"), "/usr/local/bin/agy"]) {
    try {
      _fs.accessSync(candidate, _fs.constants.X_OK);
      return candidate;
    } catch {
      // try next candidate
    }
  }
  return "agy";
}

export function loadNodePty() {
  const require = createRequire(import.meta.url);
  const candidates = [];
  if (process.platform === "win32") {
    candidates.push(path.join(
      process.env.LOCALAPPDATA ?? path.join(process.env.USERPROFILE ?? "", "AppData", "Local"),
      "agy",
      "node_modules",
      "node-pty",
    ));
  }
  candidates.push("node-pty");
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch {
      // try next candidate
    }
  }
  return null;
}

export function stripAnsi(raw) {
  return raw
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/\x1b\][^\x07]*\x07/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

// 10 minutes: agentic coding tasks routinely take longer than the old 2-minute default.
const CONPTY_TIMEOUT_MS = 600_000;

// Accepts a bare number of milliseconds ("5000"), a single unit ("5m", "30s",
// "1h", "500ms"), or a compound Go-style duration ("5m30s", "1h30m", "5m0s").
// Unparseable input (garbage, empty compound) falls back to CONPTY_TIMEOUT_MS.
const TIMEOUT_UNIT_MS = { h: 3_600_000, m: 60_000, s: 1_000, ms: 1 };
const TIMEOUT_TOKEN_PATTERN = /(\d+)(ms|h|m|s)/g;

export function parseTimeoutMs(timeout) {
  if (!timeout) return CONPTY_TIMEOUT_MS;
  const str = String(timeout).trim();
  if (/^\d+$/.test(str)) return Number.parseInt(str, 10);

  let totalMs = 0;
  let matchedLength = 0;
  for (const match of str.matchAll(TIMEOUT_TOKEN_PATTERN)) {
    totalMs += Number.parseInt(match[1], 10) * TIMEOUT_UNIT_MS[match[2]];
    matchedLength += match[0].length;
  }
  // Every character of the input must belong to a matched token — a partial
  // match (e.g. "5m30x") is treated as unparseable, not silently truncated.
  if (matchedLength === 0 || matchedLength !== str.length) return CONPTY_TIMEOUT_MS;
  return totalMs;
}

function buildAgyMissingError() {
  const err = new Error(
    "Antigravity CLI (agy) is not installed or not on PATH.\n" +
      "Install it with:\n" +
      "  macOS/Linux:  curl -fsSL https://antigravity.google/cli/install.sh | bash\n" +
      "  Windows:      irm https://antigravity.google/cli/install.ps1 | iex\n" +
      "Then authenticate by launching `agy` once.",
  );
  err.code = "EAGYMISSING";
  return err;
}

// Emergency catalog used only when both the 24-hour cache and `agy models` are unavailable.
// The runtime catalog remains authoritative.
export const FALLBACK_MODEL_CATALOG = Object.freeze([
  { slug: "gemini-3.8-flash-low", label: "Gemini 3.8 Flash (Low)" },
  { slug: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium)" },
  { slug: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" },
  { slug: "gemini-3.7-flash-low", label: "Gemini 3.7 Flash (Low)" },
  { slug: "gemini-3.7-flash-medium", label: "Gemini 3.7 Flash (Medium)" },
  { slug: "gemini-3.7-flash-high", label: "Gemini 3.7 Flash (High)" },
  { slug: "gemini-3.6-flash-low", label: "Gemini 3.6 Flash (Low)" },
  { slug: "gemini-3.6-flash-medium", label: "Gemini 3.6 Flash (Medium)" },
  { slug: "gemini-3.6-flash-high", label: "Gemini 3.6 Flash (High)" },
  { slug: "gemini-3.5-flash-low", label: "Gemini 3.5 Flash (Low)" },
  { slug: "gemini-3.5-flash-medium", label: "Gemini 3.5 Flash (Medium)" },
  { slug: "gemini-3.5-flash-high", label: "Gemini 3.5 Flash (High)" },
  { slug: "gemini-3.1-pro-low", label: "Gemini 3.1 Pro (Low)" },
  { slug: "gemini-3.1-pro-high", label: "Gemini 3.1 Pro (High)" },
  { slug: "claude-opus-4-6-thinking", label: "Claude Opus 4.6 (Thinking)" },
  { slug: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (Thinking)" },
  { slug: "gpt-oss-120b-medium", label: "GPT-OSS 120B (Medium)" },
]);

// Lowercases and collapses whitespace, underscores, parentheses, and repeated dashes so
// that "Gemini 3.1 Pro (High)", "gemini_3.1_pro_high", and "gemini-3.1-pro-high" all
// normalize to the same canonical token.
function normalizeModelToken(raw) {
  return String(raw)
    .toLowerCase()
    .replace(/[()]/g, " ")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function modelVersion(slug) {
  const dotted = slug.match(/(\d+)\.(\d+)/);
  if (dotted) return [Number(dotted[1]), Number(dotted[2])];
  const dashed = slug.match(/-(\d+)-(\d+)(?:-|$)/);
  if (dashed) return [Number(dashed[1]), Number(dashed[2])];
  return [0, 0];
}

function compareModelsNewestFirst(left, right) {
  const [leftMajor, leftMinor] = modelVersion(left.slug);
  const [rightMajor, rightMinor] = modelVersion(right.slug);
  if (leftMajor !== rightMajor) return rightMajor - leftMajor;
  if (leftMinor !== rightMinor) return rightMinor - leftMinor;
  const tierRank = (slug) => slug.endsWith("-high") ? 3 : slug.endsWith("-medium") ? 2 : slug.endsWith("-low") ? 1 : 0;
  return tierRank(right.slug) - tierRank(left.slug) || left.slug.localeCompare(right.slug);
}

export function parseAgyModelsOutput(stdout) {
  const models = [];
  const seen = new Set();
  for (const rawLine of String(stdout ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^fetching available models/i.test(line) || /^error:/i.test(line)) continue;
    const match = line.match(/^([a-z0-9][a-z0-9._-]*)\s+(.*)$/i);
    if (!match || seen.has(match[1])) continue;
    seen.add(match[1]);
    models.push({ slug: match[1], label: match[2].trim() });
  }
  return models;
}

export function resolveModelCachePath() {
  const home = process.env.USERPROFILE ?? process.env.HOME;
  if (home) {
    return path.join(home, ".gemini", "antigravity-cli", "cache", "cc-antigravity-models.json");
  }
  return path.join(path.dirname(resolveDefaultLogPath()), "models-cache.json");
}

export async function resolveModelCatalog({
  agyExe,
  _spawnSync = spawnSync,
  cachePath = resolveModelCachePath(),
  now = Date.now(),
  ttlMs = MODEL_CACHE_TTL_MS,
  _fsp = fsp,
} = {}) {
  try {
    const cached = JSON.parse(await _fsp.readFile(cachePath, "utf8"));
    if (
      Number.isFinite(cached.fetchedAt) &&
      now - cached.fetchedAt < ttlMs &&
      Array.isArray(cached.models) &&
      cached.models.length > 0
    ) {
      return cached.models;
    }
  } catch {
    // Cache miss, stale cache, or malformed cache: query the CLI.
  }

  try {
    const executable = agyExe ?? resolveAgyExe(_spawnSync);
    const result = _spawnSync(executable, ["models"], {
      encoding: "utf8",
      shell: false,
      timeout: 30_000,
    });
    const models = result.status === 0 ? parseAgyModelsOutput(result.stdout) : [];
    if (models.length > 0) {
      try {
        await _fsp.mkdir(path.dirname(cachePath), { recursive: true });
        await _fsp.writeFile(cachePath, JSON.stringify({ fetchedAt: now, models }, null, 2), "utf8");
      } catch (error) {
        logEvent("agy.models.cache.write_failed", {
          cachePath,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      logEvent("agy.models.catalog", { source: "cli", count: models.length });
      return models;
    }
  } catch (error) {
    logEvent("agy.models.query_failed", {
      message: error instanceof Error ? error.message : String(error),
    });
  }

  logEvent("agy.models.catalog", { source: "fallback", count: FALLBACK_MODEL_CATALOG.length });
  return FALLBACK_MODEL_CATALOG.map((model) => ({ ...model }));
}

function familyCandidates(normalized, catalog) {
  let family;
  if (normalized.includes("flash")) family = "flash";
  // Matches "pro", "pro-high", "gemini-pro", and "gemini-pro-high" — i.e. "pro" as a
  // standalone token bounded by the string edges or a hyphen on either side. A plain
  // `.includes("-pro")` or `.includes("pro-")` alone missed the router's own
  // "pro-high"/"pro-low" aliases (adaptive-router.mjs AGY_MODELS), which start with
  // "pro-" but don't contain "-pro".
  else if (/(^|-)pro(-|$)/.test(normalized)) family = "pro";
  else if (normalized.includes("opus") || normalized === "claude") family = "opus";
  else if (normalized.includes("sonnet")) family = "sonnet";
  else if (normalized === "gpt" || normalized.includes("gpt-oss")) family = "gpt-oss";
  if (!family) return [];

  let candidates = catalog.filter(({ slug }) => slug.toLowerCase().includes(family));
  const requestedVersion = normalized.match(/(\d+)[.-](\d+)/);
  if (requestedVersion) {
    const [major, minor] = [Number(requestedVersion[1]), Number(requestedVersion[2])];
    const sameVersion = candidates.filter(({ slug }) => {
      const version = modelVersion(slug);
      return version[0] === major && version[1] === minor;
    });
    if (sameVersion.length > 0) candidates = sameVersion;
  }
  const requestedTier = ["high", "medium", "low"].find((tier) => normalized.includes(tier));
  if (requestedTier) {
    const sameTier = candidates.filter(({ slug }) => slug.endsWith(`-${requestedTier}`));
    if (sameTier.length > 0) candidates = sameTier;
  }
  return candidates.sort(compareModelsNewestFirst);
}

// Resolves slugs and labels against the runtime catalog. Unknown input is returned unchanged
// so the caller can warn and omit it instead of sending an invalid slug to AGY.
export function resolveModelAlias(raw, catalog = FALLBACK_MODEL_CATALOG) {
  if (!raw) return raw;
  const norm = normalizeModelToken(raw);
  if (norm === "auto") return "auto";
  const direct = catalog.find(
    ({ slug, label }) => normalizeModelToken(slug) === norm || normalizeModelToken(label) === norm,
  );
  if (direct) return direct.slug;
  const [familyMatch] = familyCandidates(norm, catalog);
  if (familyMatch) return familyMatch.slug;
  return raw;
}

export function isKnownModel(model, catalog = FALLBACK_MODEL_CATALOG) {
  return model === "auto" || catalog.some(({ slug }) => slug === model);
}

// Selects a tier from the newest available Flash family when --model auto is requested.
export function resolveAutoModel(context, catalog = FALLBACK_MODEL_CATALOG) {
  const flashModels = catalog.filter(({ slug }) => slug.includes("flash")).sort(compareModelsNewestFirst);
  if (flashModels.length === 0) return undefined;
  const newestVersion = modelVersion(flashModels[0].slug);
  const newestFamily = flashModels.filter(({ slug }) => {
    const version = modelVersion(slug);
    return version[0] === newestVersion[0] && version[1] === newestVersion[1];
  });
  const totalBytes = context.included.reduce((sum, file) => sum + file.bytes, 0);
  const tier = totalBytes < 32_768 ? "low" : totalBytes < 262_144 ? "medium" : "high";
  return newestFamily.find(({ slug }) => slug.endsWith(`-${tier}`))?.slug
    ?? newestFamily.sort(compareModelsNewestFirst)[0]?.slug;
}

export function checkAgyConnectivity(agyExe, _spawnSync = spawnSync) {
  const result = _spawnSync(agyExe, ["--version"], {
    encoding: "utf8",
    shell: false,
    timeout: 5_000,
  });

  if (result.error) {
    logEvent("agy.connectivity.check", { agyExe, ok: false, errorCode: result.error.code });
    if (result.error.code === "ENOENT") {
      throw buildAgyMissingError();
    }
    throw result.error;
  }

  const version = result.stdout?.trim() || result.stderr?.trim() || "(unknown)";
  const ok = result.status === 0;

  logEvent("agy.connectivity.check", { agyExe, ok, version, exitCode: result.status });

  if (!ok) {
    const diagnostic = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    const err = new Error(
      `Antigravity CLI responded with exit code ${result.status} to --version. ` +
        "It may require authentication — run `agy` once interactively to complete setup.\n" +
        `Binary: ${agyExe}`,
    );
    // Some AGY builds report an auth failure in the --version output itself; surface
    // it as EXIT_AUTH_REQUIRED (11) instead of the generic EXIT_ERROR (1) so callers
    // get the same structured signal they'd get from a task-level auth failure.
    if (AUTH_PATTERNS.some((p) => p.test(diagnostic))) {
      err.code = "EAGYAUTHREQUIRED";
    }
    throw err;
  }
}

// A plain `child.kill()`/`term.kill()` sends SIGTERM only to the direct child.
// On Windows that never reaches grandchildren (agy's own tool subprocesses:
// node, git, test runners), which are orphaned on timeout. `taskkill /T /F`
// kills the whole process tree; on POSIX we fall back to the direct kill,
// since the child was not spawned in its own process group.
export function killProcessTree(
  pid,
  fallbackKill,
  { _spawnSync = spawnSync, platform = process.platform } = {},
) {
  if (!pid) {
    try {
      fallbackKill();
      return { ok: true, method: "direct", pid: null };
    } catch (error) {
      return {
        ok: false,
        method: "direct",
        pid: null,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }
  if (platform === "win32") {
    const result = _spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
      stdio: "ignore",
      shell: false,
    });
    if (result.status === 0) {
      return { ok: true, method: "taskkill", pid, status: result.status };
    }
  }
  try {
    fallbackKill();
    return { ok: true, method: "direct", pid };
  } catch (error) {
    return {
      ok: false,
      method: "direct",
      pid,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

// PTY merges stdout and stderr into a single stream by design; agy error output
// (auth failures, rate limits) will appear in the same stream as the response body.
// outputAccumulator, if provided, receives each clean chunk for post-run classification.
export async function spawnViaConPty(
  agyExe,
  agyArgs,
  pty,
  timeoutMs = CONPTY_TIMEOUT_MS,
  _stdout = process.stdout,
  outputAccumulator = null,
) {
  return new Promise((resolve, reject) => {
    let wroteOutput = false;
    let lastOutput = "";
    let term;
    logEvent("agy.conpty.spawn.start", {
      agyExe,
      timeoutMs,
      args: summarizeAgyArgs(agyArgs),
    });
    try {
      term = pty.spawn(agyExe, agyArgs, {
        name: "xterm-color",
        cols: 220,
        rows: 30,
        cwd: process.cwd(),
        env: process.env,
      });
    } catch (err) {
      logEvent("agy.conpty.spawn.error", {
        message: err instanceof Error ? err.message : String(err),
      });
      reject(err);
      return;
    }

    // Heartbeat: the timer resets on every output chunk. It only fires if AGY goes
    // completely silent for timeoutMs — i.e. stalls, not just runs slowly.
    // `settled` guards against a chunk arriving after timeout/exit already
    // resolved the promise: without it, a late `onData` call after rejection
    // rearms a fresh timeoutMs timer that keeps the event loop alive with no
    // way to ever fire usefully again.
    let settled = false;
    const timeoutFn = () => {
      if (settled) return;
      settled = true;
      killProcessTree(term.pid, () => term.kill());
      logEvent("agy.conpty.timeout", { timeoutMs });
      const timeoutErr = new Error(
        `agy did not respond within ${timeoutMs / 1000}s.\n` +
        "Check authentication (run `agy` once interactively) and network connectivity.",
      );
      timeoutErr.code = "ETIMEDOUT";
      reject(timeoutErr);
    };
    let timer = setTimeout(timeoutFn, timeoutMs);

    term.onData((data) => {
      if (settled) return;
      const clean = stripAnsi(data);
      if (clean) {
        clearTimeout(timer);
        timer = setTimeout(timeoutFn, timeoutMs);
        wroteOutput = true;
        lastOutput = clean;
        if (outputAccumulator !== null) outputAccumulator.push(clean);
        if (shouldLogAgyOutput()) {
          logEvent("agy.output.chunk", { text: clean });
        }
        _stdout.write(clean);
      }
    });
    term.onExit(({ exitCode }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (wroteOutput && !lastOutput.endsWith("\n")) {
        _stdout.write("\n");
      }
      logEvent("agy.conpty.spawn.exit", { exitCode: exitCode ?? 1 });
      resolve(exitCode ?? 1);
    });
  });
}

function renderStreamProgress(event) {
  const payload = event.step_update ?? event;
  if (event.event === "init") {
    const conversationId = event.conversation_id ?? event.init?.conversation_id;
    return conversationId ? `[agy] conversation ${conversationId} started` : "[agy] run started";
  }

  const toolInfo = payload.tool_info;
  if (toolInfo) {
    const name = toolInfo.name ?? payload.tool_name ?? "tool";
    const parameters = toolInfo.parameters && Object.keys(toolInfo.parameters).length > 0
      ? ` ${JSON.stringify(toolInfo.parameters)}`
      : "";
    return `[agy] tool ${name}${parameters}`;
  }

  const subagentInfo = payload.subagent_info;
  if (subagentInfo) {
    const conversationId = subagentInfo.conversation_id ?? "unknown";
    const logUri = subagentInfo.log_uri ? ` ${subagentInfo.log_uri}` : "";
    return `[agy] subagent ${conversationId}${logUri}`;
  }

  return null;
}

export function createAgyStreamParser({ onProgress = () => {}, onEvent = () => {} } = {}) {
  let buffer = "";
  let finalResult;

  const consumeLine = (rawLine) => {
    const line = rawLine.trim();
    if (!line) return;
    let event;
    try {
      event = JSON.parse(line);
    } catch (error) {
      throw new Error(
        `AGY returned invalid stream-json event: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    onEvent(event);
    if (event.event === "result" && event.result) {
      finalResult = parseAgyJsonResult(event.result);
      return;
    }
    const progress = renderStreamProgress(event);
    if (progress) onProgress(progress, event);
  };

  return {
    push(chunk) {
      buffer += String(chunk);
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) consumeLine(line);
    },
    end() {
      if (buffer.trim()) consumeLine(buffer);
      buffer = "";
      return finalResult;
    },
  };
}

export async function spawnHeadless(
  agyExe,
  agyArgs,
  {
    format = "json",
    timeoutMs = CONPTY_TIMEOUT_MS,
    _spawn = spawn,
    _stdout = process.stdout,
    _stderr = process.stderr,
    suppressOutput = false,
    onStart = undefined,
    prompt = undefined,
    useStdin = false,
  } = {},
) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      const stdio = (useStdin && prompt !== undefined)
        ? ["pipe", "pipe", "pipe"]
        : ["ignore", "pipe", "pipe"];
      child = _spawn(agyExe, agyArgs, {
        cwd: process.cwd(),
        env: process.env,
        shell: false,
        stdio,
      });
      onStart?.({ pid: child.pid ?? null });
      if (useStdin && prompt !== undefined && child.stdin) {
        // agy may exit before draining a large prompt (auth/quota failures). An
        // unhandled EPIPE would crash the bridge before exit classification runs.
        child.stdin.on?.("error", (error) => logEvent("bridge.stdin.error", { message: error.message }));
        child.stdin.write(prompt);
        child.stdin.end();
      }
    } catch (error) {
      reject(error);
      return;
    }

    const stdoutChunks = [];
    const stderrChunks = [];
    const streamParser = format === "stream-json"
      ? createAgyStreamParser({
          onProgress: (line) => _stderr.write(line + "\n"),
        })
      : null;
    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timeoutError = () => {
      killProcessTree(child.pid, () => child.kill());
      const error = new Error(
        `agy did not respond within ${timeoutMs / 1000}s.\n` +
        "Check authentication (run `agy` once interactively) and network connectivity.",
      );
      error.code = "ETIMEDOUT";
      finish(() => reject(error));
    };
    let timer = setTimeout(timeoutError, timeoutMs);
    const heartbeat = () => {
      clearTimeout(timer);
      timer = setTimeout(timeoutError, timeoutMs);
    };

    child.stdout?.on("data", (chunk) => {
      heartbeat();
      const text = chunk.toString("utf8");
      stdoutChunks.push(text);
      if (shouldLogAgyOutput()) logEvent("agy.output.chunk", { text });
      if (streamParser) {
        try {
          streamParser.push(text);
        } catch (error) {
          killProcessTree(child.pid, () => child.kill());
          finish(() => reject(error));
        }
      } else if (format === "text" && !suppressOutput) {
        _stdout.write(text);
      }
    });
    child.stderr?.on("data", (chunk) => {
      heartbeat();
      const text = chunk.toString("utf8");
      stderrChunks.push(text);
      _stderr.write(text);
    });
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (exitCode) => {
      finish(() => {
        let result;
        try {
          result = streamParser?.end();
        } catch (error) {
          reject(error);
          return;
        }
        resolve({
          exitCode: exitCode ?? EXIT_ERROR,
          stdout: stdoutChunks.join(""),
          stderr: stderrChunks.join(""),
          result,
        });
      });
    });
  });
}

/**
 * Image mode has a different completion condition from ordinary headless
 * prompts: a validated image in this run's conversation directory is final.
 * AGY 1.2.3 can remain RUNNING after generate_image, so this supervisor uses a
 * total deadline, observes stream-json for the conversation id, and terminates
 * the complete child tree as soon as the file is stable.
 */
export async function spawnImageHeadless(
  agyExe,
  agyArgs,
  {
    timeoutMs = CONPTY_TIMEOUT_MS,
    sinceMs = Date.now(),
    brainBase = path.join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".gemini", "antigravity-cli", "brain"),
    requestedConversationId = undefined,
    baseline = new Set(),
    _spawn = spawn,
    _stdout = process.stdout,
    _stderr = process.stderr,
    onStart = undefined,
    prompt = undefined,
    useStdin = false,
    _waitForGeneratedImage = waitForGeneratedImage,
    _killProcessTree = killProcessTree,
    pollIntervalMs = 250,
    stableChecks = 2,
    stableForMs = 750,
    postExitGraceMs = 1_500,
    invalidGraceMs = 1_500,
    terminationWaitMs = 3_000,
  } = {},
) {
  const state = { closed: false, closedAt: null, exitCode: null };
  let conversationId = requestedConversationId;
  let finalResult;
  let parseError = null;
  let child;
  let closeResolve;
  let fatalReject;
  const closePromise = new Promise((resolve) => { closeResolve = resolve; });
  const fatalPromise = new Promise((_, reject) => { fatalReject = reject; });
  const stdoutChunks = [];
  const stderrChunks = [];
  const parser = createAgyStreamParser({
    // Routine stream-json progress is operational telemetry, not stderr. On
    // Windows PowerShell 5, native stderr becomes a terminating
    // NativeCommandError under ErrorActionPreference=Stop even with 2>&1.
    onProgress: (line) => logEvent("bridge.image.progress", { line }),
    onEvent: (event) => {
      const observed = event.conversation_id ??
        event.init?.conversation_id ??
        event.step_update?.conversation_id ??
        event.result?.conversation_id;
      if (observed && !conversationId) {
        conversationId = observed;
        logEvent("bridge.image.session.bound", { conversationId });
      } else if (observed && conversationId !== observed) {
        const error = new Error(
          `AGY stream changed conversation id from ${conversationId} to ${observed}; refusing ambiguous image ownership`,
        );
        error.code = "EAGYIMAGESESSION";
        fatalReject(error);
      }
    },
  });

  try {
    const stdio = (useStdin && prompt !== undefined)
      ? ["pipe", "pipe", "pipe"]
      : ["ignore", "pipe", "pipe"];
    child = _spawn(agyExe, agyArgs, {
      cwd: process.cwd(),
      env: process.env,
      shell: false,
      stdio,
    });
    onStart?.({ pid: child.pid ?? null });
    if (useStdin && prompt !== undefined && child.stdin) {
      child.stdin.on?.("error", (error) => logEvent("bridge.stdin.error", { message: error.message }));
      child.stdin.write(prompt);
      child.stdin.end();
    }
  } catch (error) {
    throw error;
  }

  child.stdout?.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    stdoutChunks.push(text);
    if (shouldLogAgyOutput()) logEvent("agy.output.chunk", { text });
    try {
      parser.push(text);
    } catch (error) {
      // Preserve raw output so authentication/quota text can still be
      // classified after an invalid/missing stream-json envelope.
      parseError = error;
    }
  });
  child.stderr?.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    stderrChunks.push(text);
    _stderr.write(text);
  });
  child.on("error", (error) => {
    state.closed = true;
    state.closedAt = Date.now();
    fatalReject(error);
    closeResolve();
  });
  child.on("close", (exitCode) => {
    state.closed = true;
    state.closedAt = Date.now();
    state.exitCode = exitCode ?? EXIT_ERROR;
    if (!parseError) {
      try {
        finalResult = parser.end();
      } catch (error) {
        parseError = error;
      }
    }
    closeResolve();
  });

  let image;
  try {
    image = await Promise.race([
      _waitForGeneratedImage({
        brainBase,
        sinceMs,
        timeoutMs,
        getConversationId: () => conversationId,
        getProcessState: () => state,
        baseline,
        pollIntervalMs,
        stableChecks,
        stableForMs,
        postExitGraceMs,
        invalidGraceMs,
      }),
      fatalPromise,
    ]);
  } catch (error) {
    if (error?.code === "EAGYIMAGEMISSING" && state.closed) {
      return {
        exitCode: state.exitCode ?? EXIT_ERROR,
        stdout: stdoutChunks.join(""),
        stderr: stderrChunks.join(""),
        result: finalResult,
        parseError,
        conversationId,
        sourcePath: null,
        imageError: error,
        termination: { ok: true, method: "already-exited", pid: child.pid ?? null },
      };
    }
    if (!state.closed) {
      const termination = await Promise.resolve(_killProcessTree(child.pid, () => child.kill()));
      logEvent("bridge.image.process_tree.terminated", {
        reason: error?.code ?? "error",
        conversationId: conversationId ?? null,
        ...termination,
      });
    }
    throw error;
  }

  let termination = { ok: true, method: "already-exited", pid: child.pid ?? null };
  if (!state.closed) {
    termination = await Promise.resolve(_killProcessTree(child.pid, () => child.kill()));
    await Promise.race([closePromise, delay(terminationWaitMs)]);
  }
  logEvent("bridge.image.process_tree.terminated", {
    reason: "image-materialized",
    conversationId: image.conversationId,
    closeObserved: state.closed,
    ...termination,
  });
  return {
    exitCode: EXIT_SUCCESS,
    stdout: stdoutChunks.join(""),
    stderr: stderrChunks.join(""),
    result: finalResult,
    conversationId: image.conversationId,
    sourcePath: image.sourcePath,
    termination,
  };
}

function renderAgyCommand(args) {
  const rendered = ["agy", ...args.map((arg) => JSON.stringify(arg))].join(" ");
  return rendered;
}

function printResolvedCommands(agyArgs, _stdout = process.stdout) {
  _stdout.write(renderAgyCommand(agyArgs) + "\n");
}

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

async function findSessionImages(dir, sinceMs, baseline = new Set()) {
  const results = [];
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    // generate_image writes the requested asset at the conversation root. Do
    // not recurse into .system_generated: it contains logs and may contain
    // unrelated preview/screenshot files.
    if (entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      try {
        const stat = await fsp.stat(fullPath);
        const identity = `${fullPath}\0${stat.size}\0${stat.mtimeMs}`;
        if (stat.mtimeMs >= sinceMs - 1_000 && !baseline.has(identity)) {
          results.push({ path: fullPath, size: stat.size, mtimeMs: stat.mtimeMs });
        }
      } catch { /* skip */ }
    }
  }
  return results;
}

export async function snapshotSessionImages(sessionDir) {
  const entries = await findSessionImages(sessionDir, 0);
  return new Set(entries.map((entry) => `${entry.path}\0${entry.size}\0${entry.mtimeMs}`));
}

function invalidImage(message) {
  const error = new Error(message);
  error.code = "EAGYIMAGEINVALID";
  return error;
}

/** Read dimensions from encoded bytes so an extension alone cannot make
 * arbitrary output pass as a generated image. */
export function inspectGeneratedImage(bytes, extension = "") {
  let mime;
  let width;
  let height;
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    mime = "image/png";
    width = bytes.readUInt32BE(16);
    height = bytes.readUInt32BE(20);
  } else if (bytes.length >= 10 && ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))) {
    mime = "image/gif";
    width = bytes.readUInt16LE(6);
    height = bytes.readUInt16LE(8);
  } else if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
    mime = "image/webp";
    const chunk = bytes.toString("ascii", 12, 16);
    if (chunk === "VP8X" && bytes.length >= 30) {
      width = 1 + bytes.readUIntLE(24, 3);
      height = 1 + bytes.readUIntLE(27, 3);
    } else if (chunk === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
      width = 1 + bytes[21] + ((bytes[22] & 0x3f) << 8);
      height = 1 + (bytes[22] >> 6) + (bytes[23] << 2) + ((bytes[24] & 0x0f) << 10);
    } else if (chunk === "VP8 " && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
      width = bytes.readUInt16LE(26) & 0x3fff;
      height = bytes.readUInt16LE(28) & 0x3fff;
    }
  } else if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    mime = "image/jpeg";
    let offset = 2;
    const sofMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
    while (offset + 8 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset += 1; continue; }
      while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
      const marker = bytes[offset++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (offset + 2 > bytes.length) break;
      const segmentLength = bytes.readUInt16BE(offset);
      if (segmentLength < 2 || offset + segmentLength > bytes.length) break;
      if (sofMarkers.has(marker) && segmentLength >= 7) {
        height = bytes.readUInt16BE(offset + 3);
        width = bytes.readUInt16BE(offset + 5);
        break;
      }
      offset += segmentLength;
    }
  }

  if (!mime || !Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw invalidImage("AGY output is not a valid supported image or has no readable dimensions");
  }
  const complete =
    (mime === "image/png" && bytes.length >= 36 && bytes.toString("ascii", bytes.length - 8, bytes.length - 4) === "IEND") ||
    (mime === "image/jpeg" && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9) ||
    (mime === "image/gif" && bytes.at(-1) === 0x3b) ||
    (mime === "image/webp" && bytes.length >= 12 && bytes.readUInt32LE(4) + 8 === bytes.length);
  if (!complete) {
    throw invalidImage(`AGY output has an incomplete ${mime} file signature`);
  }
  const normalizedExtension = extension.toLowerCase();
  const expectedExtensions = mime === "image/jpeg" ? new Set([".jpg", ".jpeg"]) : new Set([`.${mime.split("/")[1]}`]);
  if (normalizedExtension && !expectedExtensions.has(normalizedExtension)) {
    throw invalidImage(`AGY image content (${mime}) does not match its extension (${normalizedExtension})`);
  }
  return { mime, width, height, aspectRatio: Number((width / height).toFixed(6)) };
}

export function parseExpectedAspectRatio(task) {
  const match = String(task ?? "").match(/(?:aspect(?:\s+ratio)?|propor(?:cao|ção))?\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)/i);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0 ? width / height : null;
}

function imageCountError(count) {
  const error = new Error(`AGY image result is ambiguous: expected exactly 1 new image, found ${count}`);
  error.code = "EAGYIMAGEAMBIGUOUS";
  return error;
}

function imageMissingError(conversationId) {
  const suffix = conversationId ? ` in conversation ${conversationId}` : "";
  const error = new Error(`AGY ended without materializing a generated image${suffix}`);
  error.code = "EAGYIMAGEMISSING";
  return error;
}

function imageTimeoutError(timeoutMs) {
  const error = new Error(`agy did not generate an image within ${timeoutMs / 1000}s.`);
  error.code = "ETIMEDOUT";
  return error;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll only the brain directory named by the stream-json conversation id.
 * Requiring two identical observations prevents a partially-written file from
 * being copied, and the post-exit grace covers the small close/fs visibility
 * race without ever searching another conversation.
 */
export async function waitForGeneratedImage({
  brainBase,
  sinceMs,
  timeoutMs,
  getConversationId,
  getProcessState = () => ({ closed: false, closedAt: null }),
  baseline = new Set(),
  pollIntervalMs = 250,
  stableChecks = 2,
  stableForMs = 750,
  postExitGraceMs = 1_500,
  invalidGraceMs = 1_500,
}) {
  const deadline = sinceMs + timeoutMs;
  let previousSignature = null;
  let stableCount = 0;
  let stableSince = null;
  let invalidSince = null;
  let lastInvalidError = null;

  while (true) {
    const now = Date.now();
    const conversationId = getConversationId();
    const state = getProcessState();
    if (conversationId) {
      const sessionDir = path.join(brainBase, conversationId);
      const candidates = await findSessionImages(sessionDir, sinceMs, baseline);
      if (candidates.length > 1) throw imageCountError(candidates.length);
      if (candidates.length === 1) {
        const candidate = candidates[0];
        const signature = `${candidate.path}\0${candidate.size}\0${candidate.mtimeMs}`;
        if (signature === previousSignature) {
          stableCount += 1;
        } else {
          stableCount = 1;
          stableSince = now;
          invalidSince = null;
          lastInvalidError = null;
        }
        previousSignature = signature;
        if (stableCount >= stableChecks && now - (stableSince ?? now) >= stableForMs) {
          try {
            const bytes = await fsp.readFile(candidate.path);
            const metadata = inspectGeneratedImage(bytes, path.extname(candidate.path));
            return { sourcePath: candidate.path, conversationId, metadata };
          } catch (error) {
            lastInvalidError = error;
            invalidSince ??= now;
            if (state.closed || now - invalidSince >= invalidGraceMs) throw error;
          }
        }
      } else {
        previousSignature = null;
        stableCount = 0;
        stableSince = null;
      }
    }

    if (state.closed && now - (state.closedAt ?? now) >= postExitGraceMs) {
      if (lastInvalidError) throw lastInvalidError;
      throw imageMissingError(conversationId);
    }
    if (now >= deadline) throw imageTimeoutError(timeoutMs);
    await delay(Math.min(pollIntervalMs, Math.max(1, deadline - now)));
  }
}

/**
 * Resolve exactly one image created by this one-image AGY invocation and copy
 * it without overwriting an existing asset.  The structured receipt is both
 * testable and suitable for downstream provenance/manifests.
 */
export async function copyGeneratedImages(sinceMs, destDir, _stdout = process.stdout, {
  brainBase = path.join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".gemini", "antigravity-cli", "brain"),
  sourcePath = undefined,
  expectedAspectRatio = null,
  aspectTolerance = 0.03,
  runId = randomUUID(),
} = {}) {
  const images = sourcePath
    ? [{ path: sourcePath }]
    : await findSessionImages(brainBase, sinceMs);
  if (images.length === 0) {
    throw imageMissingError();
  }
  if (images.length !== 1) throw imageCountError(images.length);
  const src = images[0].path;
  await fsp.mkdir(destDir, { recursive: true });
  const sourceBefore = await fsp.stat(src);
  const sourceBytes = await fsp.readFile(src);
  const sourceAfter = await fsp.stat(src);
  if (sourceBefore.size !== sourceAfter.size || sourceBefore.mtimeMs !== sourceAfter.mtimeMs) {
    const error = new Error(`AGY image changed while it was being copied: ${src}`);
    error.code = "EAGYIMAGEUNSTABLE";
    throw error;
  }
  const sourceMetadata = inspectGeneratedImage(sourceBytes, path.extname(src));
  if (expectedAspectRatio && Math.abs(sourceMetadata.aspectRatio - expectedAspectRatio) / expectedAspectRatio > aspectTolerance) {
    const error = new Error(`AGY image aspect ratio ${sourceMetadata.aspectRatio} does not match expected ${expectedAspectRatio}`);
    error.code = "EAGYIMAGEASPECT";
    throw error;
  }
  const destinationExtension = sourceMetadata.mime === "image/jpeg" ? ".jpg" : `.${sourceMetadata.mime.split("/")[1]}`;
  const safeRunId = String(runId).replace(/[^a-zA-Z0-9_-]/g, "-");
  const dest = path.join(destDir, `imagem-gerada.${safeRunId}${destinationExtension}`);
  const staged = path.join(destDir, `.imagem-gerada.${safeRunId}${destinationExtension}.part`);
  try {
    await fsp.copyFile(src, staged, fs.constants.COPYFILE_EXCL);
    const stagedBytes = await fsp.readFile(staged);
    inspectGeneratedImage(stagedBytes, destinationExtension);
    await fsp.rename(staged, dest);
  } finally {
    try {
      await fsp.rm(staged, { force: true });
    } catch {
      // A failed cleanup must not hide the original copy error.
    }
  }
  // The receipt is deliberately derived from the final destination, not from
  // the source or the staging file.
  const copiedBytes = await fsp.readFile(dest);
  const metadata = inspectGeneratedImage(copiedBytes, path.extname(dest));
  const sha256 = createHash("sha256").update(copiedBytes).digest("hex");
  const receipt = {
    schemaVersion: 1,
    count: 1,
    images: [{ destination: dest, bytes: copiedBytes.length, sha256, ...metadata }],
  };
  _stdout.write(`AGY_IMAGE_RESULT: ${JSON.stringify(receipt)}\n`);
  logEvent("bridge.image.result", receipt);
  return receipt;
}

// `mainImpl` is the real implementation; `main` (below) wraps it so every
// return path — success, classification, EMPTY_RESPONSE, or the catch-all
// error handler — logs a single terminal `bridge.exit` event with duration.
// Achado 7/8: the JSONL log had no exit/duration record at all; a normal
// headless run ended at `bridge.agy.args.built` (plus `bridge.output.file` if
// `--output-file`), with no way to tell "finished with code 0" from "process
// was killed". `_diag` is mutated in place at the few points where
// model/conversationId/outputBytes/classified become known, regardless of
// which return statement fires afterward.
async function mainImpl(argv = process.argv.slice(2), {
  _spawn = spawn,
  _spawnSync = spawnSync,
  _loadNodePty = loadNodePty,
  _resolveModelCatalog = resolveModelCatalog,
  _copyGeneratedImages = copyGeneratedImages,
  _spawnImageHeadless = spawnImageHeadless,
  _snapshotSessionImages = snapshotSessionImages,
  _brainBase = path.join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".gemini", "antigravity-cli", "brain"),
  _conPtyTimeoutMs = CONPTY_TIMEOUT_MS,
  _stdout = process.stdout,
  _stderr = process.stderr,
  _isTTY = Boolean(process.stdout.isTTY),
  _diag = {},
} = {}) {
  try {
    const runId = _diag.runId ?? randomUUID();
    _diag.runId = runId;
    appendRunJournal({ runId, status: "STARTING", pid: process.pid, cwd: process.cwd() });
    logEvent("bridge.start", {
      flags: argv.filter((a) => a.startsWith("--")),
      taskLength: argv.join(" ").length,
    });
    const parsed = parseCliArgs(argv);
    logEvent("bridge.args.parsed", summarizeParsedArgs(parsed));

    if (parsed.help) {
      _stdout.write(USAGE);
      logEvent("bridge.help", {});
      return EXIT_SUCCESS;
    }

    const configuredModel = process.env.CLAUDE_PLUGIN_OPTION_DEFAULT_MODEL?.trim() || undefined;
    const modelInput = parsed.model ?? configuredModel;
    const needsCatalog = Boolean(modelInput || parsed.subagentModel);
    const modelCatalog = needsCatalog
      ? await _resolveModelCatalog({ _spawnSync })
      : FALLBACK_MODEL_CATALOG;
    let model = modelInput ? resolveModelAlias(modelInput, modelCatalog) : undefined;
    const modelSource = parsed.model ? "flag" : configuredModel ? "config" : "agy-default";
    if (modelInput && model !== modelInput) {
      logEvent("bridge.model.alias", { requested: modelInput, resolved: model });
    }
    if (model && model !== "auto" && !isKnownModel(model, modelCatalog)) {
      const validModels = modelCatalog.map(({ slug }) => slug).join(", ");
      _stderr.write(
        `Warning: unrecognized model "${modelInput}". AGY will use its configured default. ` +
          `Valid models: ${validModels}\n`,
      );
      logEvent("bridge.model.unknown", { requested: modelInput, resolved: model });
      model = undefined;
    }

    let subagentModel = parsed.subagentModel
      ? resolveModelAlias(parsed.subagentModel, modelCatalog)
      : undefined;
    if (subagentModel && !isKnownModel(subagentModel, modelCatalog)) {
      _stderr.write(
        `Warning: unrecognized subagent model "${parsed.subagentModel}"; omitting the model hint. ` +
          `Valid models: ${modelCatalog.map(({ slug }) => slug).join(", ")}\n`,
      );
      subagentModel = undefined;
    }

    // In agentic mode, automatically add cwd to the AGY workspace when the caller
    // did not specify any --add-dir. This gives AGY access to the project by default.
    const effectiveAddDirs = (!parsed.readOnly && !parsed.generateImagem && parsed.addDirs.length === 0)
      ? [process.cwd()]
      : parsed.addDirs;

    // --design-system packages are inlined first and in full, outside the
    // --max-files/--max-file-bytes budget that governs --dirs/--files.
    const designContext = await collectDesignSystemContext({
      cwd: process.cwd(),
      designSystems: parsed.designSystems,
    });
    const generalContext = await collectContextFiles({
      cwd: process.cwd(),
      dirs: parsed.dirs,
      patterns: parsed.files,
      maxFiles: parsed.maxFiles,
      maxFileBytes: parsed.maxFileBytes,
      priorityPaths: parsed.priorityFiles,
    });
    const context = mergeDesignSystemContext(designContext, generalContext);
    logEvent("bridge.context.collected", summarizeContext(context));

    // Resolve --model auto after context is collected so we know the actual size.
    if (model === "auto") {
      const contextBytes = context.included.reduce((s, f) => s + f.bytes, 0);
      model = resolveAutoModel(context, modelCatalog);
      logEvent("bridge.model.resolved", { model, source: "auto", contextBytes });
    } else {
      logEvent("bridge.model.resolved", { model, source: modelSource });
    }
    _diag.model = model ?? null;
    const imageOutputDir = parsed.outputDir ? path.resolve(parsed.outputDir) : process.cwd();
    // --parallel and image generation are mutually exclusive; ignore parallel for images.
    if (parsed.parallel && parsed.generateImagem) {
      logEvent("bridge.parallel.ignored", { reason: "generate-imagem" });
    }
    const buildPromptFor = (promptContext) => parsed.generateImagem
      ? buildImagePrompt({ task: parsed.task, context: promptContext })
      : buildAntigravityPrompt({
          task: parsed.task,
          context: promptContext,
          parallel: parsed.parallel,
          subagentModel,
          readOnly: parsed.readOnly,
        });
    let prompt = buildPromptFor(context);

    // Transport. Headless runs stream any prompt above the platform's safe argv size
    // over stdin, so inline context is never dropped for size — including under
    // --print-command/--dump-prompt, which must reflect the real run. Only
    // --interactive (`--prompt-interactive` under a PTY) still needs the prompt in argv;
    // there the Windows CreateProcess limit (~32,767 chars, ~29k after Node's quoting)
    // is met by dropping the lowest-priority inline files one at a time.
    let promptDegraded = false;
    let promptDroppedFiles = 0;
    let effectiveContext = context;
    const imageHeadless = parsed.generateImagem;
    if (parsed.generateImagem && parsed.interactive) {
      logEvent("bridge.image.interactive.normalized", { mode: "headless-stream-json" });
    }
    const transport = resolvePromptTransport({
      promptLength: prompt.length,
      interactive: parsed.interactive && !imageHeadless,
      forceStdin: parsed.useStdin,
    });
    const shouldStreamStdin = transport === "stdin";
    if (!shouldStreamStdin && process.platform === "win32" && prompt.length > ARGV_PROMPT_LIMIT && !parsed.generateImagem) {
      const originalLength = prompt.length;
      const fitted = fitContextToPromptBudget({
        context,
        buildPrompt: buildPromptFor,
        limit: ARGV_PROMPT_LIMIT,
      });
      promptDroppedFiles = fitted.droppedFiles;
      promptDegraded = fitted.droppedFiles > 0;
      effectiveContext = fitted.context;
      prompt = fitted.prompt;
      logEvent("bridge.prompt.overflow", {
        promptLength: originalLength,
        limit: ARGV_PROMPT_LIMIT,
        droppedFiles: fitted.droppedFiles,
        transport,
      });
      if (promptDegraded) {
        _stderr.write(
          `Warning: prompt (${originalLength} chars) exceeds Windows CLI limit. ` +
            `Dropped ${fitted.droppedFiles} inline file(s); AGY will read them via --add-dir. ` +
            "Lowest-priority files went first; --interactive cannot stream over stdin, so run " +
            "headless to send the full context.\n",
        );
      }

      // Dropping inline files only helps when the files themselves pushed the prompt
      // over the limit. When the task text alone is still over budget, spawning would
      // fail with an opaque ENAMETOOLONG from the OS. Fail fast here instead, with an
      // actionable message.
      if (prompt.length > ARGV_PROMPT_LIMIT) {
        const error = new Error(
          `Task text alone produces a ${prompt.length}-char prompt, which exceeds the ` +
            "28,000-char Windows command-line budget even with no inline files attached " +
            "(--interactive cannot stream over stdin; run headless instead). " +
            "Split the task into independent-deliverable subtasks and delegate them as " +
            "separate calls instead of one oversized prompt.",
        );
        error.code = "EAGYPROMPTOVERFLOW";
        throw error;
      }
    }

    if (parsed.dumpPromptPath) {
      const resolvedDumpPath = path.resolve(parsed.dumpPromptPath);
      const auditPath = `${resolvedDumpPath}.audit.json`;
      fs.writeFileSync(resolvedDumpPath, prompt, "utf8");
      const auditPayload = {
        promptChars: prompt.length,
        limit: ARGV_PROMPT_LIMIT,
        transport,
        degraded: promptDegraded,
        droppedFiles: promptDroppedFiles,
        included: effectiveContext.included.map((f) => ({ path: f.path, bytes: f.bytes, truncated: f.truncated })),
        skipped: effectiveContext.skipped,
        designSystems: context.designSystems ?? [],
      };
      fs.writeFileSync(auditPath, JSON.stringify(auditPayload, null, 2), "utf8");
      _stderr.write(`BRIDGE_CONTEXT_REPORT: ${auditPath}\n`);
      logEvent("bridge.prompt.dumped", {
        path: resolvedDumpPath,
        promptChars: prompt.length,
        degraded: promptDegraded,
      });
    }

    const timeout = parsed.timeout ?? process.env.CLAUDE_PLUGIN_OPTION_TIMEOUT;
    let configuredEffort = process.env.CLAUDE_PLUGIN_OPTION_DEFAULT_EFFORT?.trim() || undefined;
    if (configuredEffort && !SUPPORTED_EFFORTS.has(configuredEffort)) {
      _stderr.write(
        `Warning: unsupported configured effort "${configuredEffort}"; expected low, medium, or high. ` +
          "AGY will use its own effort default.\n",
      );
      configuredEffort = undefined;
    }
    const agyFormat = parsed.generateImagem ? "stream-json" : parsed.format;
    const agyArgs = buildAntigravityArgs({
      prompt,
      model,
      format: agyFormat,
      effort: parsed.effort ?? configuredEffort,
      mode: parsed.mode,
      agent: parsed.agent,
      jsonSchema: parsed.jsonSchema,
      disableSlashCommands: parsed.disableSlashCommands,
      timeout,
      interactive: parsed.interactive && !imageHeadless,
      continueConversation: parsed.continueConversation,
      conversationId: parsed.conversationId,
      addDirs: effectiveAddDirs,
      sandbox: parsed.sandbox,
      skipPermissions: parsed.skipPermissions,
      useStdin: shouldStreamStdin,
    });
    logEvent("bridge.agy.args.built", {
      args: summarizeAgyArgs(agyArgs),
      timeout,
      readOnly: parsed.readOnly,
      transport,
      promptChars: prompt.length,
    });

    if (parsed.printCommand) {
      printResolvedCommands(agyArgs, _stdout);
      logEvent("bridge.print-command", { args: summarizeAgyArgs(agyArgs) });
      return EXIT_SUCCESS;
    }

    const agyExe = resolveAgyExe(_spawnSync);
    checkAgyConnectivity(agyExe, _spawnSync);

    const spawnStartMs = Date.now();

    if (parsed.interactive && !imageHeadless) {
      const ptyModule = _loadNodePty();
      if (!ptyModule) {
        throw new Error(
          "--interactive requires PTY support (node-pty), which is not available in this environment.\n" +
            "Use the default headless mode or run AGY directly in an interactive terminal.",
        );
      }
      if (!_isTTY) {
        logEvent("bridge.interactive.no-tty");
        _stderr.write(
          "Warning: --interactive is running without a terminal (no TTY detected). " +
            "AGY may hang waiting for user input.\n",
        );
      }
      const outputChunks = [];
      const ptyOutputStream = parsed.outputFile ? { write: () => {} } : _stdout;
      let exitCode;
      try {
        exitCode = await spawnViaConPty(
          agyExe,
          agyArgs,
          ptyModule,
          timeout ? parseTimeoutMs(timeout) : _conPtyTimeoutMs,
          ptyOutputStream,
          outputChunks,
        );
      } catch (error) {
        if (error?.code === "ENOENT" || String(error).includes("not found")) {
          throw buildAgyMissingError();
        }
        throw error;
      }
      const output = outputChunks.join("");
      if (parsed.outputFile) {
        const resolvedOutputFile = path.resolve(parsed.outputFile);
        await fsp.mkdir(path.dirname(resolvedOutputFile), { recursive: true });
        await fsp.writeFile(resolvedOutputFile, output, "utf8");
        _diag.outputBytes = output.length;
        _stdout.write(resolvedOutputFile + "\n");
      }
      const classification = classifyAgyOutput(output, { format: "text", exitCode });
      if (classification) {
        _diag.classified = classification.type;
        emitStructuredSignal(classification.type, classification.reason, model, undefined, _stdout);
        return classification.exitCode;
      }
      return exitCode;
    }

    if (parsed.generateImagem) {
      const requestedSessionDir = parsed.conversationId
        ? path.join(_brainBase, parsed.conversationId)
        : null;
      const baseline = requestedSessionDir
        ? await _snapshotSessionImages(requestedSessionDir)
        : new Set();
      let imageRun;
      try {
        imageRun = await _spawnImageHeadless(agyExe, agyArgs, {
          timeoutMs: timeout ? parseTimeoutMs(timeout) : _conPtyTimeoutMs,
          sinceMs: spawnStartMs,
          brainBase: _brainBase,
          requestedConversationId: parsed.conversationId,
          baseline,
          _spawn,
          _stdout,
          _stderr,
          prompt,
          useStdin: shouldStreamStdin,
          onStart: ({ pid }) => appendRunJournal({
            runId: _diag.runId,
            status: "RUNNING",
            pid,
            executor: "agy",
            requestedConversationId: parsed.conversationId ?? null,
          }),
        });
      } catch (error) {
        if (error?.code === "ENOENT" || String(error).includes("not found")) {
          throw buildAgyMissingError();
        }
        throw error;
      }

      const classification = classifyAgyOutput(
        imageRun.result ?? `${imageRun.stdout}\n${imageRun.stderr}`,
        { format: imageRun.result ? "stream-json" : "text", exitCode: imageRun.exitCode },
      );
      if (classification) {
        _diag.classified = classification.type;
        _diag.conversationId = imageRun.conversationId ?? imageRun.result?.conversationId ?? null;
        emitStructuredSignal(classification.type, classification.reason, model, imageRun.result, _stdout);
        logEvent("bridge.classified", {
          type: classification.type,
          reason: classification.reason,
          model,
          conversationId: _diag.conversationId,
          exitCode: classification.exitCode,
        });
        return classification.exitCode;
      }
      if (!imageRun.sourcePath) throw imageRun.imageError ?? imageMissingError(imageRun.conversationId);
      _diag.conversationId = imageRun.conversationId ?? null;
      _diag.imageTermination = imageRun.termination;
      _diag.imageReceipt = await _copyGeneratedImages(spawnStartMs, imageOutputDir, _stdout, {
        sourcePath: imageRun.sourcePath,
        expectedAspectRatio: parseExpectedAspectRatio(parsed.task),
        runId: _diag.runId,
      });
      return EXIT_SUCCESS;
    }

    let headless;
    try {
      headless = await spawnHeadless(agyExe, agyArgs, {
        format: parsed.format,
        timeoutMs: timeout ? parseTimeoutMs(timeout) : _conPtyTimeoutMs,
        _spawn,
        _stdout,
        _stderr,
        suppressOutput: Boolean(parsed.outputFile),
        prompt,
        useStdin: shouldStreamStdin,
        onStart: ({ pid }) => appendRunJournal({
          runId: _diag.runId,
          status: "RUNNING",
          pid,
          executor: "agy",
          requestedConversationId: parsed.conversationId ?? null,
        }),
      });
    } catch (error) {
      if (error?.code === "ENOENT" || String(error).includes("not found")) {
        throw buildAgyMissingError();
      }
      throw error;
    }

    let result = headless.result;
    let response = parsed.format === "text" ? headless.stdout : "";
    // A failed JSON parse most commonly means AGY never produced an envelope at
    // all — an auth/quota failure surfaced as plain text before it could. Defer
    // the throw until after classification has a chance to diagnose the real
    // cause from the raw text; only re-throw the parse error itself when
    // classification finds nothing (a genuinely malformed/unexpected envelope).
    let parseError = null;
    if (parsed.format === "json" && headless.stdout.trim()) {
      try {
        result = parseAgyJsonResult(headless.stdout);
        response = result.response;
      } catch (error) {
        parseError = error instanceof Error ? error : new Error(String(error));
      }
    } else if (parsed.format === "stream-json") {
      response = result?.response ?? "";
    }

    const classification = classifyAgyOutput(
      result ?? `${headless.stdout}\n${headless.stderr}`,
      { format: parsed.format, exitCode: headless.exitCode },
    );
    if (!classification && parseError) {
      throw parseError;
    }
    if (classification) {
      _diag.classified = classification.type;
      _diag.conversationId = result?.conversationId ?? null;
      emitStructuredSignal(classification.type, classification.reason, model, result, _stdout);
      logEvent("bridge.classified", {
        type: classification.type,
        reason: classification.reason,
        model,
        conversationId: result?.conversationId,
        exitCode: classification.exitCode,
      });
      return classification.exitCode;
    }

    // Achado 7/8: uma resposta vazia com `--output-file` e exit de sucesso
    // nao e sucesso — e um caminho que hoje grava um arquivo de 0 byte e sai
    // com o mesmo codigo de um resultado real, sem `bridge.classified` nem
    // `bridge.error`. Numa run real, 7 dispatches sem `--timeout` morreram
    // assim aos ~5m05s (a correcao do Achado 7 acima reduz a incidencia, mas
    // nao elimina: um `--print-timeout` explicito ainda pode expirar em
    // silencio, e uma chamada `--read-only` pode devolver vazio rapido demais
    // para ser timeout). `elapsedMs` perto do timeout efetivo classifica como
    // TIMEOUT; muito mais rapido do que isso classifica como ERROR generico —
    // as duas com o mesmo sinal estruturado, nunca silencio.
    //
    // Achado 9: a checagem original so rodava com `--output-file`. Um caller
    // que so redireciona stdout via shell (`> arquivo`, o padrao documentado
    // em subagent-prompts.md e o que a run real do OficinaAI usou) caia direto
    // no `return headless.exitCode` no fim da funcao com exit 0 e zero bytes —
    // silent success. Isso aconteceu de verdade: `--read-only` com AGY
    // recusando `run_command` no headless ("no output produced ... auto-denied")
    // devolveu stdout vazio e exit 0 sem nenhum diagnostico. A checagem agora
    // vale para qualquer destino de saida.
    if (response.trim() === "" && String(headless.exitCode) === "0") {
      const effectiveTimeoutMs = timeout ? parseTimeoutMs(timeout) : _conPtyTimeoutMs;
      const elapsedMs = Date.now() - spawnStartMs;
      const nearTimeout = elapsedMs >= effectiveTimeoutMs * 0.8;
      const emptyExitCode = nearTimeout ? EXIT_TIMEOUT : EXIT_ERROR;
      const reason = `agy produced an empty response after ${elapsedMs}ms (timeout ${effectiveTimeoutMs}ms)`;
      _diag.classified = "EMPTY_RESPONSE";
      _diag.conversationId = result?.conversationId ?? null;
      emitStructuredSignal("EMPTY_RESPONSE", reason, model, result, _stdout);
      logEvent("bridge.classified", {
        type: "EMPTY_RESPONSE",
        reason,
        model,
        conversationId: result?.conversationId,
        exitCode: emptyExitCode,
      });
      return emptyExitCode;
    }

    if (parsed.outputFile) {
      const resolvedOutputFile = path.resolve(parsed.outputFile);
      await fsp.mkdir(path.dirname(resolvedOutputFile), { recursive: true });
      await fsp.writeFile(resolvedOutputFile, response, "utf8");
      _diag.outputBytes = response.length;
      logEvent("bridge.output.file", { path: resolvedOutputFile, bytes: response.length });
      _stdout.write(resolvedOutputFile + "\n");
    } else if (parsed.format !== "text" && response) {
      _stdout.write(response);
      if (!response.endsWith("\n")) _stdout.write("\n");
    }

    if (result?.error && String(result.status).toUpperCase() !== "SUCCESS") {
      _stderr.write(result.error + (result.error.endsWith("\n") ? "" : "\n"));
    }
    _diag.conversationId = result?.conversationId ?? null;
    if (result && String(result.status).toUpperCase() !== "SUCCESS") return EXIT_ERROR;
    if (headless.exitCode !== EXIT_SUCCESS) return headless.exitCode;
    return headless.exitCode;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logEvent("bridge.error", { message });
    const logPath = process.env.CC_ANTIGRAVITY_LOG_PATH || resolveDefaultLogPath();
    _stderr.write(`${message}\nPlugin log: ${logPath}\n`);
    if (error?.code === "ETIMEDOUT") return EXIT_TIMEOUT;
    if (error?.code === "EAGYMISSING") return EXIT_AGY_MISSING;
    if (error?.code === "EAGYAUTHREQUIRED") return EXIT_AUTH_REQUIRED;
    return EXIT_ERROR;
  }
}

/**
 * Achado 7/8: o log JSONL de uma run headless normal terminava em
 * `bridge.agy.args.built` (mais `bridge.output.file` se `--output-file`),
 * sem nenhum evento de saida — nao havia como distinguir "terminou com codigo
 * 0" de "processo foi morto". `mainImpl` nunca lanca (todo erro interno vira
 * um exit code dentro do proprio try/catch), entao envolve-lo aqui e
 * suficiente para garantir exatamente um `bridge.exit` por invocacao,
 * independente de qual `return` disparou.
 */
export async function main(argv = process.argv.slice(2), options = {}) {
  const diag = { runId: options.runId ?? randomUUID() };
  const startedAt = Date.now();
  const exitCode = await mainImpl(argv, { ...options, _diag: diag });
  logEvent("bridge.exit", {
    exitCode,
    durationMs: Date.now() - startedAt,
    model: diag.model ?? null,
    conversationId: diag.conversationId ?? null,
    outputBytes: diag.outputBytes ?? null,
    classified: diag.classified ?? null,
    imageCount: diag.imageReceipt?.count ?? null,
    imageDestination: diag.imageReceipt?.images?.[0]?.destination ?? null,
    imageTermination: diag.imageTermination ?? null,
  });
  appendRunJournal({
    runId: diag.runId,
    status: exitCode === EXIT_SUCCESS ? "DONE" : exitCode === EXIT_TIMEOUT ? "STALLED" : "FAILED",
    pid: process.pid,
    exitCode,
    durationMs: Date.now() - startedAt,
    model: diag.model ?? null,
    conversationId: diag.conversationId ?? null,
    classified: diag.classified ?? null,
    imageCount: diag.imageReceipt?.count ?? null,
    imageDestination: diag.imageReceipt?.images?.[0]?.destination ?? null,
  });
  return exitCode;
}

const isMain =
  process.argv[1] != null &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  const exitCode = await main();
  process.exit(exitCode);
}
