#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";
import { resolveDefaultLogPath, logEvent } from "./utils.js";

const DEFAULT_MAX_FILES = 40;
const DEFAULT_MAX_FILE_BYTES = 32_768;
const SUPPORTED_FORMATS = new Set(["text"]);
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
  --format <text>            Output format. Default: text. (json/stream-json not supported by agy headless mode)
  --model <name>             Model to use. Written to AGY's ~/.gemini/antigravity-cli/settings.json before
                             spawn and restored after. AGY has no --model CLI flag; settings.json is the
                             only headless mechanism.
                             Available: gemini-3.5-flash-low, gemini-3.5-flash-medium (default),
                                        gemini-3.5-flash-high, gemini-3.1-pro-low, gemini-3.1-pro-high,
                                        claude-4.6-sonnet-thinking, claude-4.6-opus-thinking,
                                        gpt-oss-120b-medium, nano-banana (image generation),
                                        auto (selects flash tier by context size)
  --generate-imagem          Generate an image from the task description using AGY's Nano Banana model.
                             Defaults --model to nano-banana. Compatible with --model to override.
  --parallel                 Allow AGY to fan the task out across multiple native Gemini subagents
                             (DefineSubagent / invoke_subagent / ManageSubagents). AGY decides how
                             many subagents to spawn based on the task's independent subparts.
  --subagent-model <name>    Model the spawned subagents should use. Conveyed via the prompt (AGY has
                             no per-subagent CLI flag). Implies --parallel. Defaults to the main model.
  --timeout <duration>       Forwarded to agy as --print-timeout (for example: 3m, 300s).
  --interactive              Use agy --prompt-interactive instead of --print.
                             Requires PTY support and an interactive terminal (TTY).
  --agent                    Alias for --interactive; intended for human-at-terminal sessions.
  --read-only                Disable --dangerously-skip-permissions and workspace auto-add.
                             Use for analysis-only tasks that must not modify files.
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

// Scans AGY output for quota/auth signals and returns a classification or null.
export function classifyAgyOutput(output) {
  if (QUOTA_PATTERNS.some((p) => p.test(output))) {
    const reasonMatch = output.match(/QUOTA_EXAUSTED\s+reason="([^"]+)"/);
    const reason = reasonMatch ? reasonMatch[1] : "quota or rate limit reached";
    return { type: "QUOTA_EXAUSTED", reason, exitCode: EXIT_QUOTA_EXAUSTED };
  }
  if (AUTH_PATTERNS.some((p) => p.test(output))) {
    return {
      type: "AUTH_REQUIRED",
      reason: "authentication required — run `agy` once interactively to sign in",
      exitCode: EXIT_AUTH_REQUIRED,
    };
  }
  return null;
}

// Emits a single machine-readable JSON line that orchestrators / Claude Code can parse.
// QUOTA_EXAUSTED includes retry:"--continue" so callers know how to resume the session.
function emitStructuredSignal(type, reason, model, _stdout) {
  const signal = { status: type, reason, model };
  if (type === "QUOTA_EXAUSTED") signal.retry = "--continue";
  _stdout.write(JSON.stringify(signal) + "\n");
}

export function parseCliArgs(argv) {
  const parsed = {
    dirs: [],
    addDirs: [],
    files: [],
    format: "text",
    model: undefined,
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
      case "--agent":
        parsed.interactive = true;
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
    ? `- Configure each subagent to use the model "${agyModelLabel(subagentModel)}".\n`
    : "";
  return `

<parallelism>
- You MAY decompose this task into independent subtasks and run them concurrently using your
  native subagent tools (DefineSubagent, invoke_subagent / Agent, ManageSubagents).
- Spawn subagents only for genuinely independent work; keep shared or sequential steps in the main agent.
- Decide the number of subagents yourself based on how many independent subparts the task has.
${modelLine}- Wait for every subagent to finish (poll with ManageSubagents) before concluding.
- Aggregate the subagents' outputs into one final report, and list each subagent's purpose and conversation ID.
</parallelism>`;
}

export function buildAntigravityPrompt({ task, context, parallel = false, subagentModel }) {
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
- You are an agentic coding assistant. Complete the task fully using your available tools.
- Use write_to_file, replace_file_content, and multi_replace_file_content to create and edit files.
- Use grep_search, view_file, and list_dir to explore and search the workspace.
- Use run_command to execute shell commands when needed.
- Use the provided inline context when relevant; cite file paths when referencing it.
- If inline context is partial or truncated, read the full files with view_file before acting.
- Complete the entire task without stopping mid-way. Report all changes made at the end.
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
  model: _model,   // model is applied via settings.json before spawn, not via CLI flag
  format: _format, // accepted but not forwarded; AGY headless returns text only
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
  if (interactive) {
    args.push("--prompt-interactive", prompt);
  } else {
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

// Selects a model based on total inline context size when --model auto is requested.
// Larger context → higher Flash tier (more capable, not just faster).
export function resolveAutoModel(context) {
  const totalBytes = context.included.reduce((sum, f) => sum + f.bytes, 0);
  if (totalBytes < 32_768) return "gemini-3.5-flash-low";
  if (totalBytes < 262_144) return "gemini-3.5-flash-medium";
  return "gemini-3.5-flash-high";
}

// Maps bridge model identifiers to AGY settings.json display labels (confirmed from AGY transcripts).
// AGY reads the "model" field in settings.json as a human-readable label, not an API identifier.
const AGY_MODEL_LABELS = {
  "gemini-3.5-flash-low":    "Gemini 3.5 Flash (Low)",
  "gemini-3.5-flash-medium": "Gemini 3.5 Flash (Medium)",
  "gemini-3.5-flash-high":   "Gemini 3.5 Flash (High)",
  "gemini-3.1-pro-low":      "Gemini 3.1 Pro (Low)",
  "gemini-3.1-pro-high":     "Gemini 3.1 Pro (High)",
  "nano-banana":             "Nano Banana",
};

// Converts a bridge model identifier to the display label AGY stores in settings.json.
// Unknown models are passed through as-is (AGY falls back to its default).
export function agyModelLabel(model) {
  return AGY_MODEL_LABELS[model] ?? model;
}

// Returns the path where AGY CLI reads its settings.json.
// AGY stores its settings at ~/.gemini/antigravity-cli/settings.json on all platforms.
// AGY has no --model flag; writing the model label here is the only headless override.
export function resolveAgySettingsPath() {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  return path.join(home, ".gemini", "antigravity-cli", "settings.json");
}

// Writes the requested model into AGY's settings.json and returns an async restore
// function that puts the file back to its original state (or removes it if it did
// not exist). Callers MUST call the returned function in a finally block.
export async function patchAgySettings(settingsPath, model) {
  let originalContent = null;
  try {
    originalContent = await fsp.readFile(settingsPath, "utf8");
  } catch {
    // settings.json does not exist yet; we will create it and remove it on restore
  }
  const existing = originalContent ? JSON.parse(originalContent) : {};
  const label = agyModelLabel(model);
  await fsp.mkdir(path.dirname(settingsPath), { recursive: true });
  await fsp.writeFile(settingsPath, JSON.stringify({ ...existing, model: label }, null, 2), "utf8");
  logEvent("agy.model.patch", { settingsPath, model, label });

  return async () => {
    try {
      if (originalContent === null) {
        await fsp.unlink(settingsPath);
      } else {
        await fsp.writeFile(settingsPath, originalContent, "utf8");
      }
    } catch {
      // best-effort; leaving a stale settings.json is preferable to crashing
    }
    logEvent("agy.model.unpatch", { settingsPath });
  };
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
    throw new Error(
      `Antigravity CLI responded with exit code ${result.status} to --version. ` +
        "It may require authentication — run `agy` once interactively to complete setup.\n" +
        `Binary: ${agyExe}`,
    );
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
  _spawnSync = spawnSync,
  _loadNodePty = loadNodePty,
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

    const defaultModel = process.env.CLAUDE_PLUGIN_OPTION_DEFAULT_MODEL ?? "gemini-3.5-flash-medium";
    let model = parsed.model ?? (parsed.generateImagem ? "nano-banana" : defaultModel);
    const modelSource = parsed.model ? "flag" : (parsed.generateImagem ? "generate-imagem-default" : (process.env.CLAUDE_PLUGIN_OPTION_DEFAULT_MODEL ? "env" : "default"));

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
      model = resolveAutoModel(context);
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
          subagentModel: parsed.subagentModel,
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
      _stderr.write(
        `Warning: prompt (${prompt.length} chars) exceeds Windows CLI limit. ` +
          `Dropped ${context.included.length} inline file(s); AGY will read them via --add-dir.\n`,
      );
      prompt = buildAntigravityPrompt({
        task: parsed.task,
        context: fallbackContext,
        parallel: parsed.parallel,
        subagentModel: parsed.subagentModel,
      });
    }

    const timeout = parsed.timeout ?? process.env.CLAUDE_PLUGIN_OPTION_TIMEOUT;
    const agyArgs = buildAntigravityArgs({
      prompt,
      model,
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

    // Patch AGY settings.json with the resolved model before spawning.
    // AGY has no --model CLI flag; settings.json is the only headless model override.
    const shouldPatch = Boolean(parsed.model || parsed.generateImagem || process.env.CLAUDE_PLUGIN_OPTION_DEFAULT_MODEL);
    const restoreAgySettings = shouldPatch
      ? await patchAgySettings(resolveAgySettingsPath(), model)
      : null;

    const spawnStartMs = Date.now();
    try {
      const ptyModule = _loadNodePty();

      if (parsed.interactive) {
        if (!ptyModule) {
          throw new Error(
            "--agent/--interactive requires PTY support (node-pty) which is not available in this environment.\n" +
              "Use the default headless mode (omit --agent/--interactive) or run AGY directly in an interactive terminal.",
          );
        }
        if (!_isTTY) {
          logEvent("bridge.interactive.no-tty");
          _stderr.write(
            "Warning: --agent/--interactive is running without a terminal (no TTY detected). " +
              "AGY may hang waiting for user input. " +
              "Use the default headless mode unless you have an interactive terminal attached.\n",
          );
        }
      }

      if (ptyModule) {
        const outputChunks = [];
        // When --output-file is set, suppress streaming to stdout; a single write at
        // the end is immune to sandbox pipe limits and stdout buffering.
        const ptyOutputStream = parsed.outputFile ? { write: () => {} } : _stdout;
        let ptyExitCode;
        try {
          ptyExitCode = await spawnViaConPty(
            agyExe,
            agyArgs,
            ptyModule,
            timeout ? parseTimeoutMs(timeout) : _conPtyTimeoutMs,
            ptyOutputStream,
            outputChunks,
          );
        } catch (err) {
          if (err?.code === "ENOENT" || String(err).includes("not found")) {
            throw buildAgyMissingError();
          }
          throw err;
        }
        const fullOutput = outputChunks.join("");
        if (parsed.outputFile) {
          const resolvedOutputFile = path.resolve(parsed.outputFile);
          await fsp.mkdir(path.dirname(resolvedOutputFile), { recursive: true });
          await fsp.writeFile(resolvedOutputFile, fullOutput, "utf8");
          logEvent("bridge.output.file", { path: resolvedOutputFile, bytes: fullOutput.length });
          _stdout.write(resolvedOutputFile + "\n");
        }
        const sig = classifyAgyOutput(fullOutput);
        if (sig) {
          emitStructuredSignal(sig.type, sig.reason, model, _stdout);
          logEvent("bridge.classified", { type: sig.type, reason: sig.reason, model, exitCode: sig.exitCode });
          if (parsed.generateImagem) await copyGeneratedImages(spawnStartMs, imageOutputDir, _stdout);
          return sig.exitCode;
        }
        if (parsed.generateImagem) await copyGeneratedImages(spawnStartMs, imageOutputDir, _stdout);
        return ptyExitCode;
      }

      // Fallback for platforms or installs where node-pty is unavailable.
      logEvent("agy.spawnsync.start", { agyExe, args: summarizeAgyArgs(agyArgs) });
      const spawnStdio = parsed.outputFile ? "pipe" : "inherit";
      const result = _spawnSync(agyExe, agyArgs, { stdio: spawnStdio, encoding: "utf8" });
      if (result.error) {
        logEvent("agy.spawnsync.error", {
          code: result.error.code,
          message: result.error.message,
        });
        if (result.error.code === "ENOENT") {
          throw buildAgyMissingError();
        }
        throw result.error;
      }
      if (parsed.outputFile) {
        const resolvedOutputFile = path.resolve(parsed.outputFile);
        const capturedOutput = stripAnsi((result.stdout ?? "") + (result.stderr ?? ""));
        await fsp.mkdir(path.dirname(resolvedOutputFile), { recursive: true });
        await fsp.writeFile(resolvedOutputFile, capturedOutput, "utf8");
        logEvent("bridge.output.file", { path: resolvedOutputFile, bytes: capturedOutput.length });
        _stdout.write(resolvedOutputFile + "\n");
      }
      logEvent("agy.spawnsync.exit", { status: result.status ?? 1 });
      if (parsed.generateImagem) await copyGeneratedImages(spawnStartMs, imageOutputDir, _stdout);
      return result.status ?? EXIT_ERROR;
    } finally {
      await restoreAgySettings?.();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logEvent("bridge.error", { message });
    const logPath = process.env.CC_ANTIGRAVITY_LOG_PATH || resolveDefaultLogPath();
    _stderr.write(`${message}\nPlugin log: ${logPath}\n`);
    if (error?.code === "ETIMEDOUT") return EXIT_TIMEOUT;
    if (error?.code === "EAGYMISSING") return EXIT_AGY_MISSING;
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
