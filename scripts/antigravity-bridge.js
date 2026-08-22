#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";
import { resolveDefaultLogPath, logEvent } from "./utils.js";

const DEFAULT_MAX_FILES = 40;
const DEFAULT_MAX_FILE_BYTES = 32_768;
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
  --dirs <path,...>          Directories to ingest recursively.
  --add-dir <path>           Add a directory to AGY's native workspace. Repeatable.
                             Default: current working directory (added automatically).
  --files <glob,...>         File globs to ingest.
  --format <format>          Headless output: text, json, or stream-json. Default: json.
  --model <name>             Model slug or natural-language alias. Resolved dynamically from \`agy models\`.
                             Omitted when not requested so AGY honors the user's own /model setting.
                             Use \`auto\` to select a tier from the newest available Flash family.
  --effort <level>           Reasoning effort: low, medium, or high.
  --mode <mode>              Permission mode: plan or accept-edits.
  --json-schema <value>      JSON Schema string or path. Implies --format json.
  --disable-slash-commands   Treat task text as data (default headless, except --read-only;
                             AGY 1.1.16 otherwise ignores --mode plan).
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
  --agent <name>             Select an AGY custom agent. Use --interactive for a PTY session.
  --read-only                Imply --mode plan, disable --dangerously-skip-permissions, and
                             disable workspace auto-add.
  --continue, -c             Continue the most recent AGY conversation.
  --conversation <id>        Resume a specific AGY conversation.
  --sandbox                  Enable AGY sandbox mode.
  --skip-permissions         Explicitly forward --dangerously-skip-permissions (on by default).
  --max-files <n>            Maximum files to inline. Default: 40.
  --max-file-bytes <n>       Maximum bytes per file. Default: 32768.
  --output-file <path>       Write the full AGY output to a file instead of streaming to
                             stdout. Only the resolved file path is printed to stdout.
                             Designed for callers that use the Read tool: pass this flag,
                             get the path back from the Bash tool, then Read the file.
                             Immune to sandbox pipe limits and stdout buffering.
  --print-command            Print the resolved agy command and exit.
  -h, --help                 Show this help message.

Defaults:
  Agentic mode is ON by default: --dangerously-skip-permissions is forwarded and the current
  working directory is added to AGY's workspace via --add-dir. Pass --read-only to disable.

Exit codes:
   0  Success
   1  Generic error
  10  QUOTA_EXAUSTED  — quota or rate limit hit; workflow should retry or pause
  11  AUTH_REQUIRED   — AGY needs interactive sign-in (run \`agy\` once)
  12  TIMEOUT         — AGY did not respond within the configured timeout
  13  AGY_MISSING     — Antigravity CLI not found on PATH

Logging:
  Plugin events are always written to a JSONL log file.
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
    // disabled. Preserve the stronger no-write guarantee for read-only runs.
    parsed.disableSlashCommands = false;
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
  const sortedMatches = [...allMatches].sort((left, right) => left.localeCompare(right));

  for (const absolutePath of sortedMatches) {
    const relativePath = relativeToCwd(cwd, absolutePath);

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
- Do not call write_to_file, replace_file_content, multi_replace_file_content, or any mutating command.
- Use grep_search, view_file, list_dir, and read-only run_command operations to inspect the workspace.`
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
</context_files>

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

export function buildImagePrompt({ task, context, outputDir }) {
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
- You are an image generation assistant. Generate the image described in the task using the generate_imagem tool.
- Use generate_imagem with the exact description from the task above as the prompt.
- After generating, save the image file using write_to_file to the directory: ${outputDir ?? process.cwd()}
  Use the exact filename produced by generate_imagem (keep the original extension).
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
    args.push("--print", prompt);
    if (timeout) args.push("--print-timeout", timeout);
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

function parseTimeoutMs(timeout) {
  if (!timeout) return CONPTY_TIMEOUT_MS;
  const match = String(timeout).trim().match(/^(\d+)(ms|s|m|h)?(?:0s)?$/);
  if (!match) return CONPTY_TIMEOUT_MS;
  const value = Number.parseInt(match[1], 10);
  const unit = match[2] ?? "ms";
  if (unit === "h") return value * 60 * 60 * 1000;
  if (unit === "m") return value * 60 * 1000;
  if (unit === "s") return value * 1000;
  return value;
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

export const CANONICAL_MODELS = new Set([
  ...FALLBACK_MODEL_CATALOG.map(({ slug }) => slug),
  "auto",
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
    const timeoutFn = () => {
      try { term.kill(); } catch { /* already dead */ }
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

export function createAgyStreamParser({ onProgress = () => {} } = {}) {
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
  } = {},
) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = _spawn(agyExe, agyArgs, {
        cwd: process.cwd(),
        env: process.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
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
      try { child.kill(); } catch { /* already stopped */ }
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
          try { child.kill(); } catch { /* already stopped */ }
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

function renderAgyCommand(args) {
  const rendered = ["agy", ...args.map((arg) => JSON.stringify(arg))].join(" ");
  return rendered;
}

function printResolvedCommands(agyArgs, _stdout = process.stdout) {
  _stdout.write(renderAgyCommand(agyArgs) + "\n");
}

async function findFilesNewerThan(dir, sinceMs, extensions) {
  const results = [];
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await findFilesNewerThan(fullPath, sinceMs, extensions)));
    } else if (entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase())) {
      try {
        const stat = await fsp.stat(fullPath);
        if (stat.mtimeMs >= sinceMs) results.push(fullPath);
      } catch { /* skip */ }
    }
  }
  return results;
}

async function copyGeneratedImages(sinceMs, destDir, _stdout = process.stdout) {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  const brainBase = path.join(home, ".gemini", "antigravity-cli", "brain");
  const imageExtensions = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
  let images;
  try {
    images = await findFilesNewerThan(brainBase, sinceMs, imageExtensions);
  } catch {
    return;
  }
  if (images.length > 0) {
    await fsp.mkdir(destDir, { recursive: true });
  }
  for (const src of images) {
    const dest = path.join(destDir, path.basename(src));
    try {
      await fsp.copyFile(src, dest);
      _stdout.write(`\nImage saved: ${path.basename(dest)}\n`);
      logEvent("bridge.image.copied", { src, dest });
    } catch (err) {
      logEvent("bridge.image.copy.error", { src, dest, message: err instanceof Error ? err.message : String(err) });
    }
  }
}

export async function main(argv = process.argv.slice(2), {
  _spawn = spawn,
  _spawnSync = spawnSync,
  _loadNodePty = loadNodePty,
  _resolveModelCatalog = resolveModelCatalog,
  _conPtyTimeoutMs = CONPTY_TIMEOUT_MS,
  _stdout = process.stdout,
  _stderr = process.stderr,
  _isTTY = Boolean(process.stdout.isTTY),
} = {}) {
  try {
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
    const effectiveAddDirs = (!parsed.readOnly && parsed.addDirs.length === 0)
      ? [process.cwd()]
      : parsed.addDirs;

    const context = await collectContextFiles({
      cwd: process.cwd(),
      dirs: parsed.dirs,
      patterns: parsed.files,
      maxFiles: parsed.maxFiles,
      maxFileBytes: parsed.maxFileBytes,
    });
    logEvent("bridge.context.collected", summarizeContext(context));

    // Resolve --model auto after context is collected so we know the actual size.
    if (model === "auto") {
      const contextBytes = context.included.reduce((s, f) => s + f.bytes, 0);
      model = resolveAutoModel(context, modelCatalog);
      logEvent("bridge.model.resolved", { model, source: "auto", contextBytes });
    } else {
      logEvent("bridge.model.resolved", { model, source: modelSource });
    }
    const imageOutputDir = parsed.outputDir ? path.resolve(parsed.outputDir) : process.cwd();
    // --parallel and image generation are mutually exclusive; ignore parallel for images.
    if (parsed.parallel && parsed.generateImagem) {
      logEvent("bridge.parallel.ignored", { reason: "generate-imagem" });
    }
    let prompt = parsed.generateImagem
      ? buildImagePrompt({ task: parsed.task, context, outputDir: imageOutputDir })
      : buildAntigravityPrompt({
          task: parsed.task,
          context,
          parallel: parsed.parallel,
          subagentModel,
          readOnly: parsed.readOnly,
        });

    // Windows CreateProcess limit: ~32,767 chars total. Real prompts (with quotes,
    // backslashes, XML) break at ~29,140 raw chars after Node.js arg encoding.
    // When exceeded, drop inline file content and let AGY read via --add-dir tools.
    if (process.platform === "win32" && prompt.length > 28_000 && !parsed.generateImagem) {
      const fallbackContext = {
        included: [],
        skipped: context.included.map((f) => ({ path: f.path, reason: "prompt-overflow-windows" })),
      };
      logEvent("bridge.prompt.overflow", {
        promptLength: prompt.length,
        limit: 28_000,
        droppedFiles: context.included.length,
      });
      if (context.included.length > 0) {
        _stderr.write(
          `Warning: prompt (${prompt.length} chars) exceeds Windows CLI limit. ` +
            `Dropped ${context.included.length} inline file(s); AGY will read them via --add-dir.\n`,
        );
      }
      prompt = buildAntigravityPrompt({
        task: parsed.task,
        context: fallbackContext,
        parallel: parsed.parallel,
        subagentModel,
        readOnly: parsed.readOnly,
      });

      // Dropping inline files only helps when the files themselves pushed the prompt
      // over the limit. When the task text alone is still over budget, spawning would
      // fail with an opaque ENAMETOOLONG from the OS. Fail fast here instead, with an
      // actionable message, matching the 28,000-char delegation budget cc-executor-subagents
      // enforces on the caller side (skills/executor-subagents/scripts/check-agy-prompt.mjs).
      if (prompt.length > 28_000) {
        const error = new Error(
          `Task text alone produces a ${prompt.length}-char prompt, which exceeds the ` +
            "28,000-char Windows command-line budget even with no inline files attached. " +
            "Split the task into independent-deliverable subtasks and delegate them as " +
            "separate calls instead of one oversized prompt.",
        );
        error.code = "EAGYPROMPTOVERFLOW";
        throw error;
      }
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
    const agyArgs = buildAntigravityArgs({
      prompt,
      model,
      format: parsed.format,
      effort: parsed.effort ?? configuredEffort,
      mode: parsed.mode,
      agent: parsed.agent,
      jsonSchema: parsed.jsonSchema,
      disableSlashCommands: parsed.disableSlashCommands,
      timeout,
      interactive: parsed.interactive,
      continueConversation: parsed.continueConversation,
      conversationId: parsed.conversationId,
      addDirs: effectiveAddDirs,
      sandbox: parsed.sandbox,
      skipPermissions: parsed.skipPermissions,
    });
    logEvent("bridge.agy.args.built", { args: summarizeAgyArgs(agyArgs), timeout, readOnly: parsed.readOnly });

    if (parsed.printCommand) {
      printResolvedCommands(agyArgs, _stdout);
      logEvent("bridge.print-command", { args: summarizeAgyArgs(agyArgs) });
      return EXIT_SUCCESS;
    }

    const agyExe = resolveAgyExe(_spawnSync);
    checkAgyConnectivity(agyExe, _spawnSync);

    const spawnStartMs = Date.now();

    if (parsed.interactive) {
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
        _stdout.write(resolvedOutputFile + "\n");
      }
      const classification = classifyAgyOutput(output, { format: "text", exitCode });
      if (classification) {
        emitStructuredSignal(classification.type, classification.reason, model, undefined, _stdout);
        return classification.exitCode;
      }
      if (parsed.generateImagem) await copyGeneratedImages(spawnStartMs, imageOutputDir, _stdout);
      return exitCode;
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
      emitStructuredSignal(classification.type, classification.reason, model, result, _stdout);
      logEvent("bridge.classified", {
        type: classification.type,
        reason: classification.reason,
        model,
        conversationId: result?.conversationId,
        exitCode: classification.exitCode,
      });
      if (parsed.generateImagem) await copyGeneratedImages(spawnStartMs, imageOutputDir, _stdout);
      return classification.exitCode;
    }

    if (parsed.outputFile) {
      const resolvedOutputFile = path.resolve(parsed.outputFile);
      await fsp.mkdir(path.dirname(resolvedOutputFile), { recursive: true });
      await fsp.writeFile(resolvedOutputFile, response, "utf8");
      logEvent("bridge.output.file", { path: resolvedOutputFile, bytes: response.length });
      _stdout.write(resolvedOutputFile + "\n");
    } else if (parsed.format !== "text" && response) {
      _stdout.write(response);
      if (!response.endsWith("\n")) _stdout.write("\n");
    }

    if (result?.error && String(result.status).toUpperCase() !== "SUCCESS") {
      _stderr.write(result.error + (result.error.endsWith("\n") ? "" : "\n"));
    }
    if (parsed.generateImagem) await copyGeneratedImages(spawnStartMs, imageOutputDir, _stdout);
    if (result && String(result.status).toUpperCase() !== "SUCCESS") return EXIT_ERROR;
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

const isMain =
  process.argv[1] != null &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  const exitCode = await main();
  process.exit(exitCode);
}
