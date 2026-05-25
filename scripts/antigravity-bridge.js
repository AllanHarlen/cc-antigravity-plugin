#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";

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

const USAGE = `Usage:
  node "\${CLAUDE_PLUGIN_ROOT}/scripts/antigravity-bridge.js" [options] <task>

Options:
  --task <text>              Explicit task text.
  --dirs <path,...>          Directories to ingest recursively.
  --add-dir <path>           Add a directory to AGY's native workspace. Repeatable.
  --files <glob,...>         File globs to ingest.
  --format <text>            Output format. Default: text. (json/stream-json not supported by agy headless mode)
  --timeout <duration>       Forwarded to agy as --print-timeout (for example: 3m, 300s).
  --interactive              Use agy --prompt-interactive instead of --print.
                             Requires PTY support and an interactive terminal (TTY).
  --agent                    Alias for --interactive; intended for AGY workspace-editing sessions.
  --continue, -c             Continue the most recent AGY conversation.
  --conversation <id>        Resume a specific AGY conversation.
  --sandbox                  Enable AGY sandbox mode.
  --skip-permissions         Forward --dangerously-skip-permissions to AGY.
  --max-files <n>            Maximum files to inline. Default: 40.
  --max-file-bytes <n>       Maximum bytes per file. Default: 32768.
  --print-command            Print the resolved agy command and exit.
  -h, --help                 Show this help message.

Logging:
  Plugin events are always written to a JSONL log file.
    Windows:     %LOCALAPPDATA%\\agy\\cc-plugin-logs\\plugin-YYYY-MM-DD.jsonl
    macOS/Linux: ~/.local/share/agy/cc-plugin-logs/plugin-YYYY-MM-DD.jsonl
  Override:      CC_ANTIGRAVITY_LOG_PATH=<path>
  Include output chunks in log: CC_ANTIGRAVITY_LOG_OUTPUT=1
`;

function resolveDefaultLogPath() {
  const isWin = process.platform === "win32";
  const date = new Date().toISOString().slice(0, 10);
  const baseDir = isWin
    ? path.join(
        process.env.LOCALAPPDATA ??
          path.join(process.env.USERPROFILE ?? "", "AppData", "Local"),
        "agy",
        "cc-plugin-logs",
      )
    : path.join(process.env.HOME ?? "", ".local", "share", "agy", "cc-plugin-logs");
  return path.join(baseDir, `plugin-${date}.jsonl`);
}

function logEvent(event, data = {}) {
  const logPath = process.env.CC_ANTIGRAVITY_LOG_PATH || resolveDefaultLogPath();
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(
      logPath,
      JSON.stringify({
        timestamp: new Date().toISOString(),
        pid: process.pid,
        event,
        ...data,
      }) + "\n",
      "utf8",
    );
  } catch {
    // Logging must never affect plugin execution.
  }
}

function summarizeParsedArgs(parsed) {
  return {
    dirs: parsed.dirs,
    addDirs: parsed.addDirs,
    files: parsed.files,
    format: parsed.format,
    timeout: parsed.timeout,
    interactive: parsed.interactive,
    continueConversation: parsed.continueConversation,
    conversationId: parsed.conversationId,
    sandbox: parsed.sandbox,
    skipPermissions: parsed.skipPermissions,
    maxFiles: parsed.maxFiles,
    maxFileBytes: parsed.maxFileBytes,
    printCommand: parsed.printCommand,
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

export function parseCliArgs(argv) {
  const parsed = {
    dirs: [],
    addDirs: [],
    files: [],
    format: "text",
    timeout: undefined,
    interactive: false,
    continueConversation: false,
    conversationId: undefined,
    sandbox: false,
    skipPermissions: false,
    maxFiles: DEFAULT_MAX_FILES,
    maxFileBytes: DEFAULT_MAX_FILE_BYTES,
    printCommand: false,
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
      case "--timeout":
        parsed.timeout = takeOptionValue(argv, index, token);
        index += 1;
        break;
      case "--interactive":
      case "--agent":
        parsed.interactive = true;
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

function walkDirSync(dir) {
  const results = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkDirSync(fullPath));
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

function collectPatternMatches(cwd, pattern) {
  const workspaceRoot = path.resolve(cwd);
  const matcher = globToRegExp(pattern);
  return walkDirSync(workspaceRoot).filter((absolutePath) =>
    matcher.test(relativeToCwd(workspaceRoot, absolutePath)),
  );
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

  for (const pattern of patterns) {
    for (const match of collectPatternMatches(cwd, pattern)) {
      allMatches.add(path.resolve(workspaceRoot, match));
    }
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

      included.push({
        path: relativePath,
        mediaType: getMediaType(absolutePath),
        bytes: fileBuffer.length,
        truncated,
        content: trimmedBuffer.toString("utf8"),
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

export function buildAntigravityPrompt({ task, context }) {
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
- Use the provided workspace context when it is relevant.
- Cite file paths when referring to evidence from inline context.
- Call out when the context is partial, skipped, or truncated.
- Do not invent files or data that are not present in the provided payloads.
</constraints>`;
}

export function buildAntigravityArgs({
  prompt,
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

const CONPTY_TIMEOUT_MS = 120_000;

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
  return new Error(
    "Antigravity CLI (agy) is not installed or not on PATH.\n" +
      "Install it with:\n" +
      "  macOS/Linux:  curl -fsSL https://antigravity.google/cli/install.sh | bash\n" +
      "  Windows:      irm https://antigravity.google/cli/install.ps1 | iex\n" +
      "Then authenticate by launching `agy` once.",
  );
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
export async function spawnViaConPty(agyExe, agyArgs, pty, timeoutMs = CONPTY_TIMEOUT_MS, _stdout = process.stdout) {
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

    const timer = setTimeout(() => {
      try { term.kill(); } catch { /* already dead */ }
      logEvent("agy.conpty.timeout", { timeoutMs });
      reject(new Error(
        `agy did not respond within ${timeoutMs / 1000}s.\n` +
        "Check authentication (run `agy` once interactively) and network connectivity.",
      ));
    }, timeoutMs);

    term.onData((data) => {
      const clean = stripAnsi(data);
      if (clean) {
        wroteOutput = true;
        lastOutput = clean;
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

export async function main(argv = process.argv.slice(2), {
  _spawnSync = spawnSync,
  _loadNodePty = loadNodePty,
  _conPtyTimeoutMs = CONPTY_TIMEOUT_MS,
  _stdout = process.stdout,
  _stderr = process.stderr,
  _isTTY = Boolean(process.stdout.isTTY),
} = {}) {
  try {
    logEvent("bridge.start", { argv });
    const parsed = parseCliArgs(argv);
    logEvent("bridge.args.parsed", summarizeParsedArgs(parsed));

    if (parsed.help) {
      _stdout.write(USAGE);
      logEvent("bridge.help", {});
      return 0;
    }

    const context = await collectContextFiles({
      cwd: process.cwd(),
      dirs: parsed.dirs,
      patterns: parsed.files,
      maxFiles: parsed.maxFiles,
      maxFileBytes: parsed.maxFileBytes,
    });
    logEvent("bridge.context.collected", summarizeContext(context));
    const prompt = buildAntigravityPrompt({ task: parsed.task, context });
    const timeout = parsed.timeout ?? process.env.CLAUDE_PLUGIN_OPTION_TIMEOUT;
    const agyArgs = buildAntigravityArgs({
      prompt,
      timeout,
      interactive: parsed.interactive,
      continueConversation: parsed.continueConversation,
      conversationId: parsed.conversationId,
      addDirs: parsed.addDirs,
      sandbox: parsed.sandbox,
      skipPermissions: parsed.skipPermissions,
    });
    logEvent("bridge.agy.args.built", { args: summarizeAgyArgs(agyArgs), timeout });

    if (parsed.printCommand) {
      printResolvedCommands(agyArgs, _stdout);
      logEvent("bridge.print-command", { args: summarizeAgyArgs(agyArgs) });
      return 0;
    }

    const agyExe = resolveAgyExe(_spawnSync);
    checkAgyConnectivity(agyExe, _spawnSync);

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
      try {
        return await spawnViaConPty(
          agyExe,
          agyArgs,
          ptyModule,
          timeout ? parseTimeoutMs(timeout) : _conPtyTimeoutMs,
          _stdout,
        );
      } catch (err) {
        if (err?.code === "ENOENT" || String(err).includes("not found")) {
          throw buildAgyMissingError();
        }
        throw err;
      }
    }

    // Fallback for platforms or installs where node-pty is unavailable.
    logEvent("agy.spawnsync.start", { agyExe, args: summarizeAgyArgs(agyArgs) });
    const result = _spawnSync(agyExe, agyArgs, { stdio: "inherit" });
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
    logEvent("agy.spawnsync.exit", { status: result.status ?? 1 });
    return result.status ?? 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logEvent("bridge.error", { message });
    const logPath = process.env.CC_ANTIGRAVITY_LOG_PATH || resolveDefaultLogPath();
    _stderr.write(`${message}\nPlugin log: ${logPath}\n`);
    return 1;
  }
}

const isMain =
  process.argv[1] != null &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  const exitCode = await main();
  process.exit(exitCode);
}
