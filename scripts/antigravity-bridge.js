#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { globSync } from "node:fs";
import fs from "node:fs/promises";
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
  node scripts/antigravity-bridge.js [options] <task>

Options:
  --task <text>              Explicit task text.
  --model <name>             Model override (accepted for API compatibility; not forwarded to agy).
  --dirs <path,...>          Directories to ingest recursively.
  --files <glob,...>         File globs to ingest.
  --format <text>            Output format. Default: text. (json/stream-json not supported by agy headless mode)
  --max-files <n>            Maximum files to inline. Default: 40.
  --max-file-bytes <n>       Maximum bytes per file. Default: 32768.
  --print-command            Print the resolved agy command and exit.
  -h, --help                 Show this help message.
`;

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
    model: undefined,
    dirs: [],
    files: [],
    format: "text",
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
      case "--model":
        parsed.model = takeOptionValue(argv, index, token);
        index += 1;
        break;
      case "--dirs":
        parsed.dirs.push(...splitList(takeOptionValue(argv, index, token)));
        index += 1;
        break;
      case "--files":
        parsed.files.push(...splitList(takeOptionValue(argv, index, token)));
        index += 1;
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

function collectDirectoryMatches(cwd, dirPath) {
  const normalizedDir = dirPath.replace(/[\\/]+$/, "");
  return globSync(`${normalizedDir}/**/*`, {
    cwd,
    absolute: true,
    nodir: true,
    withFileTypes: false,
  });
}

function collectPatternMatches(cwd, pattern) {
  return globSync(pattern, {
    cwd,
    absolute: true,
    nodir: true,
    withFileTypes: false,
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
      const stat = await fs.stat(absolutePath);
      if (!stat.isFile()) {
        skipped.push({ path: relativePath, reason: "not-a-file" });
        continue;
      }

      const fileBuffer = await fs.readFile(absolutePath);
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

export function buildAntigravityArgs({ prompt }) {
  return ["--print", prompt];
}

function resolveAgyExe() {
  const result = spawnSync("where", ["agy"], { encoding: "utf8", shell: false });
  if (result.status === 0 && result.stdout.trim()) {
    return result.stdout.trim().split(/\r?\n/)[0];
  }
  const fallback = path.join(
    process.env.LOCALAPPDATA ?? path.join(process.env.USERPROFILE ?? "", "AppData", "Local"),
    "agy",
    "bin",
    "agy.exe",
  );
  return fallback;
}

function loadNodePty() {
  const require = createRequire(import.meta.url);
  const candidates = [
    path.join(
      process.env.LOCALAPPDATA ?? path.join(process.env.USERPROFILE ?? "", "AppData", "Local"),
      "agy",
      "node_modules",
      "node-pty",
    ),
  ];
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

// PTY merges stdout and stderr into a single stream by design; agy error output
// (auth failures, rate limits) will appear in the same stream as the response body.
async function spawnViaConPty(agyExe, agyArgs, pty, timeoutMs = CONPTY_TIMEOUT_MS, _stdout = process.stdout) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let term;
    try {
      term = pty.spawn(agyExe, agyArgs, {
        name: "xterm-color",
        cols: 220,
        rows: 30,
        cwd: process.cwd(),
        env: process.env,
      });
    } catch (err) {
      reject(err);
      return;
    }

    const timer = setTimeout(() => {
      try { term.kill(); } catch { /* already dead */ }
      reject(new Error(
        `agy did not respond within ${timeoutMs / 1000}s.\n` +
        "Check authentication (run `agy` once interactively) and network connectivity.",
      ));
    }, timeoutMs);

    term.onData((data) => chunks.push(data));
    term.onExit(({ exitCode }) => {
      clearTimeout(timer);
      const clean = stripAnsi(chunks.join(""));
      _stdout.write(clean);
      if (!clean.endsWith("\n")) {
        _stdout.write("\n");
      }
      resolve(exitCode ?? 1);
    });
  });
}

function printResolvedCommand(args, _stdout = process.stdout) {
  const rendered = ["agy", ...args.map((arg) => JSON.stringify(arg))].join(" ");
  _stdout.write(rendered + "\n");
}

export async function main(argv = process.argv.slice(2), {
  _spawnSync = spawnSync,
  _loadNodePty = loadNodePty,
  _conPtyTimeoutMs = CONPTY_TIMEOUT_MS,
  _stdout = process.stdout,
  _stderr = process.stderr,
} = {}) {
  try {
    const parsed = parseCliArgs(argv);

    if (parsed.help) {
      _stdout.write(USAGE);
      return 0;
    }

    const context = await collectContextFiles({
      cwd: process.cwd(),
      dirs: parsed.dirs,
      patterns: parsed.files,
      maxFiles: parsed.maxFiles,
      maxFileBytes: parsed.maxFileBytes,
    });
    const prompt = buildAntigravityPrompt({ task: parsed.task, context });
    const agyArgs = buildAntigravityArgs({ prompt });

    if (parsed.printCommand) {
      printResolvedCommand(agyArgs, _stdout);
      return 0;
    }

    const ptyModule = _loadNodePty();
    if (ptyModule) {
      const agyExe = resolveAgyExe();
      try {
        return await spawnViaConPty(agyExe, agyArgs, ptyModule, _conPtyTimeoutMs, _stdout);
      } catch (err) {
        if (err?.code === "ENOENT" || String(err).includes("not found")) {
          throw new Error(
            "Antigravity CLI (agy) is not installed or not on PATH.\n" +
              "Install it with:\n" +
              "  macOS/Linux:  curl -fsSL https://antigravity.google/cli/install.sh | bash\n" +
              "  Windows:      irm https://antigravity.google/cli/install.ps1 | iex\n" +
              "Then authenticate by launching `agy` once.",
          );
        }
        throw err;
      }
    }

    // Fallback for non-Windows or when node-pty is unavailable
    const result = _spawnSync("agy", agyArgs, { stdio: "inherit" });
    if (result.error) {
      if (result.error.code === "ENOENT") {
        throw new Error(
          "Antigravity CLI (agy) is not installed or not on PATH.\n" +
            "Install it with:\n" +
            "  macOS/Linux:  curl -fsSL https://antigravity.google/cli/install.sh | bash\n" +
            "  Windows:      irm https://antigravity.google/cli/install.ps1 | iex\n" +
            "Then authenticate by launching `agy` once.",
        );
      }
      throw result.error;
    }
    return result.status ?? 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    _stderr.write(message + "\n");
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
