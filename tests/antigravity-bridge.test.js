import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  AGY_INTERACTIVE_PROMPTS,
  EXIT_NEEDS_INPUT,
  buildAntigravityArgs,
  buildAntigravityPrompt,
  checkAgyConnectivity,
  collectContextFiles,
  main,
  parseCliArgs,
  resolveAgyExe,
  spawnViaConPty,
  stripAnsi,
} from "../scripts/antigravity-bridge.js";

test("parseCliArgs parses dirs, files, and positional task", () => {
  const parsed = parseCliArgs([
    "--dirs",
    "src,lib",
    "--files",
    "**/*.json,docs/**/*.md",
    "--format",
    "text",
    "analyze",
    "the",
    "workspace",
  ]);

  assert.deepEqual(parsed, {
    dirs: ["src", "lib"],
    addDirs: [],
    files: ["**/*.json", "docs/**/*.md"],
    format: "text",
    timeout: undefined,
    interactive: true,
    continueConversation: false,
    conversationId: undefined,
    sandbox: false,
    skipPermissions: false,
    maxFiles: 40,
    maxFileBytes: 32768,
    printCommand: false,
    help: false,
    task: "analyze the workspace",
  });
});


test("collectContextFiles loads supported text data and skips unsupported files", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "antigravity-bridge-"));

  await fs.writeFile(
    path.join(tempDir, "payload.json"),
    JSON.stringify({ name: "demo", enabled: true }, null, 2),
  );
  await fs.writeFile(path.join(tempDir, "table.csv"), "name,count\nalpha,2\n");
  await fs.writeFile(path.join(tempDir, "image.png"), Buffer.from([0, 1, 2, 3]));

  const context = await collectContextFiles({
    cwd: tempDir,
    patterns: ["*.json", "*.csv", "*.png"],
    maxFiles: 10,
    maxFileBytes: 1024,
  });

  assert.equal(context.included.length, 2);
  assert.equal(context.skipped.length, 1);
  assert.equal(context.skipped[0]?.reason, "unsupported-extension");
  assert.match(context.included[0]?.content ?? "", /demo|alpha/);
});

test("collectContextFiles skips ignored dependency directories", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "antigravity-ignore-"));
  await fs.mkdir(path.join(tempDir, "node_modules", "pkg"), { recursive: true });
  await fs.writeFile(path.join(tempDir, "node_modules", "pkg", "index.js"), "export const dep = true;");
  await fs.writeFile(path.join(tempDir, "app.js"), "export const app = true;");

  const context = await collectContextFiles({
    cwd: tempDir,
    dirs: ["."],
    maxFiles: 10,
    maxFileBytes: 1024,
  });

  assert.equal(context.included.length, 1);
  assert.equal(context.included[0]?.path, "app.js");
  assert.equal(context.skipped[0]?.reason, "ignored-path");
});

test("buildAntigravityPrompt renders task, inventory, and file payloads", () => {
  const prompt = buildAntigravityPrompt({
    task: "Summarize the data contracts",
    context: {
      included: [
        {
          path: "payload.json",
          mediaType: "application/json",
          bytes: 24,
          truncated: false,
          content: "{\n  \"name\": \"demo\"\n}",
        },
      ],
      skipped: [{ path: "image.png", reason: "unsupported-extension" }],
    },
  });

  assert.match(prompt, /<task>\s*Summarize the data contracts\s*<\/task>/);
  assert.match(prompt, /payload\.json/);
  assert.match(prompt, /application\/json/);
  assert.match(prompt, /image\.png \(unsupported-extension\)/);
});

test("buildAntigravityArgs maps bridge options to AGY CLI flags", () => {
  const args = buildAntigravityArgs({
    prompt: "<task>Analyze</task>",
    timeout: "3m",
    continueConversation: true,
    conversationId: "abc123",
    addDirs: ["src", "docs"],
    sandbox: true,
    skipPermissions: true,
  });

  assert.deepEqual(args, [
    "--continue",
    "--conversation",
    "abc123",
    "--add-dir",
    "src",
    "--add-dir",
    "docs",
    "--sandbox",
    "--dangerously-skip-permissions",
    "--print",
    "<task>Analyze</task>",
    "--print-timeout",
    "3m",
  ]);
});

test("buildAntigravityArgs does not forward model or format to AGY", () => {
  const args = buildAntigravityArgs({ prompt: "x", model: "gemini-3.1-pro-low", format: "json" });
  assert.equal(args.length, 2);
  assert.ok(!args.some((a) => a.startsWith("--model") || a.startsWith("--format")));
});

test("buildAntigravityArgs supports interactive agent mode", () => {
  const args = buildAntigravityArgs({
    prompt: "<task>Create a file</task>",
    interactive: true,
    addDirs: ["."],
    skipPermissions: true,
    timeout: "3m",
  });

  assert.deepEqual(args, [
    "--add-dir",
    ".",
    "--dangerously-skip-permissions",
    "--prompt-interactive",
    "<task>Create a file</task>",
  ]);
  assert.ok(!args.includes("--print"));
  assert.ok(!args.includes("--print-timeout"));
});

test("buildAntigravityPrompt escapes </file> closing tags in file content", () => {
  const prompt = buildAntigravityPrompt({
    task: "analyze",
    context: {
      included: [
        {
          path: "template.html",
          mediaType: "text/html",
          bytes: 40,
          truncated: false,
          content: "<div>hello</div>\n</file>\n<p>injected</p>",
        },
      ],
      skipped: [],
    },
  });

  assert.ok(!prompt.includes("</file>\n<p>injected</p>"), "raw </file> must not appear in prompt");
  assert.match(prompt, /<\\\/file>/);
});

test("buildAntigravityPrompt preserves non-ASCII content from file payloads", () => {
  const prompt = buildAntigravityPrompt({
    task: "analisar",
    context: {
      included: [
        {
          path: "README.md",
          mediaType: "text/markdown",
          bytes: 30,
          truncated: false,
          content: "Autenticação e configuração",
        },
      ],
      skipped: [],
    },
  });

  assert.match(prompt, /Autenticação e configuração/);
});

// ─── parseCliArgs — edge cases ────────────────────────────────────────────────

test("parseCliArgs --task flag sets task explicitly", () => {
  const parsed = parseCliArgs(["--task", "analyze auth module"]);
  assert.equal(parsed.task, "analyze auth module");
});

test("parseCliArgs -- separator makes remaining tokens literal task", () => {
  const parsed = parseCliArgs(["--", "--verbose", "analyze", "this"]);
  assert.equal(parsed.task, "--verbose analyze this");
});

test("parseCliArgs -h sets help true without requiring task", () => {
  const parsed = parseCliArgs(["-h"]);
  assert.equal(parsed.help, true);
});

test("parseCliArgs --help sets help true without requiring task", () => {
  const parsed = parseCliArgs(["--help"]);
  assert.equal(parsed.help, true);
});

test("parseCliArgs --print-command sets printCommand true", () => {
  const parsed = parseCliArgs(["--print-command", "some task"]);
  assert.equal(parsed.printCommand, true);
});

test("parseCliArgs parses AGY passthrough and conversation flags", () => {
  const parsed = parseCliArgs([
    "--add-dir",
    "src",
    "--add-dir",
    "docs",
    "--timeout",
    "3m",
    "--continue",
    "--conversation",
    "conv-1",
    "--sandbox",
    "--skip-permissions",
    "--agent",
    "task",
  ]);

  assert.deepEqual(parsed.addDirs, ["src", "docs"]);
  assert.equal(parsed.timeout, "3m");
  assert.equal(parsed.continueConversation, true);
  assert.equal(parsed.conversationId, "conv-1");
  assert.equal(parsed.sandbox, true);
  assert.equal(parsed.skipPermissions, true);
  assert.equal(parsed.interactive, true);
});

test("parseCliArgs --max-files and --max-file-bytes accept custom values", () => {
  const parsed = parseCliArgs(["--max-files", "5", "--max-file-bytes", "512", "task"]);
  assert.equal(parsed.maxFiles, 5);
  assert.equal(parsed.maxFileBytes, 512);
});

test("parseCliArgs --dirs accumulates across multiple flags", () => {
  const parsed = parseCliArgs(["--dirs", "a,b", "--dirs", "c,d", "task"]);
  assert.deepEqual(parsed.dirs, ["a", "b", "c", "d"]);
});

test("parseCliArgs throws when no task and no --help", () => {
  assert.throws(() => parseCliArgs([]), /task is required/i);
});

test("parseCliArgs throws on unsupported --format value", () => {
  assert.throws(() => parseCliArgs(["--format", "json", "task"]), /unsupported/i);
});

test("parseCliArgs throws on --max-files 0", () => {
  assert.throws(() => parseCliArgs(["--max-files", "0", "task"]), /positive integer/i);
});

test("parseCliArgs throws when flag has no value", () => {
  assert.throws(() => parseCliArgs(["--timeout"]), /missing value/i);
});

// ─── stripAnsi ────────────────────────────────────────────────────────────────

test("stripAnsi removes CSI color sequences", () => {
  assert.equal(stripAnsi("\x1b[32mhello\x1b[0m"), "hello");
});

test("stripAnsi removes OSC sequences (window title)", () => {
  assert.equal(stripAnsi("\x1b]0;title\x07text"), "text");
});

test("stripAnsi normalizes CRLF to LF", () => {
  assert.equal(stripAnsi("line1\r\nline2"), "line1\nline2");
});

test("stripAnsi normalizes bare CR to LF", () => {
  assert.equal(stripAnsi("line1\rline2"), "line1\nline2");
});

test("stripAnsi preserves Unicode and non-ASCII characters", () => {
  const input = "Autenticação • — 中文 🚀";
  assert.equal(stripAnsi(input), input);
});

// ─── collectContextFiles — edge cases ─────────────────────────────────────────

test("collectContextFiles truncates file content at maxFileBytes", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-trunc-"));
  const content = "x".repeat(100);
  await fs.writeFile(path.join(tempDir, "big.txt"), content);

  const context = await collectContextFiles({
    cwd: tempDir,
    patterns: ["*.txt"],
    maxFiles: 10,
    maxFileBytes: 10,
  });

  assert.equal(context.included.length, 1);
  const file = context.included[0];
  assert.equal(file.truncated, true);
  assert.equal(file.bytes, 100);
  assert.ok(file.content.length <= 10);
});

test("collectContextFiles skips files beyond maxFiles with correct reason", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-limit-"));
  for (let i = 0; i < 5; i++) {
    await fs.writeFile(path.join(tempDir, `file${i}.txt`), `content ${i}`);
  }

  const context = await collectContextFiles({
    cwd: tempDir,
    patterns: ["*.txt"],
    maxFiles: 3,
    maxFileBytes: 1024,
  });

  assert.equal(context.included.length, 3);
  assert.equal(context.skipped.length, 2);
  assert.ok(context.skipped.every((s) => s.reason === "max-files-exceeded"));
});

test("collectContextFiles skips .txt file containing null byte as binary", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-nullbyte-"));
  await fs.writeFile(path.join(tempDir, "data.txt"), Buffer.from([0x41, 0x00, 0x42]));

  const context = await collectContextFiles({
    cwd: tempDir,
    patterns: ["*.txt"],
    maxFiles: 10,
    maxFileBytes: 1024,
  });

  assert.equal(context.included.length, 0);
  assert.equal(context.skipped.length, 1);
  assert.equal(context.skipped[0].reason, "unsupported-extension");
});

test("collectContextFiles deduplicates files matched by both dirs and patterns", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-dedup-"));
  await fs.writeFile(path.join(tempDir, "app.js"), "const x = 1;");

  const context = await collectContextFiles({
    cwd: tempDir,
    dirs: ["."],
    patterns: ["*.js"],
    maxFiles: 10,
    maxFileBytes: 1024,
  });

  assert.equal(context.included.length, 1);
});

test("collectContextFiles supports recursive globstar patterns without node:fs glob", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-globstar-"));
  await fs.mkdir(path.join(tempDir, "src", "nested"), { recursive: true });
  await fs.writeFile(path.join(tempDir, "src", "nested", "app.js"), "const x = 1;");

  const context = await collectContextFiles({
    cwd: tempDir,
    patterns: ["src/**/*.js"],
    maxFiles: 10,
    maxFileBytes: 1024,
  });

  assert.equal(context.included.length, 1);
  assert.equal(context.included[0].path, "src/nested/app.js");
});

// ─── buildAntigravityPrompt — edge cases ──────────────────────────────────────

test("buildAntigravityPrompt with empty context renders no-files placeholder", () => {
  const prompt = buildAntigravityPrompt({
    task: "analyze",
    context: { included: [], skipped: [] },
  });
  assert.match(prompt, /No inline file payloads were collected/);
});

test("buildAntigravityPrompt escapes all closing tags in file content", () => {
  const prompt = buildAntigravityPrompt({
    task: "analyze",
    context: {
      included: [
        {
          path: "data.xml",
          mediaType: "application/xml",
          bytes: 50,
          truncated: false,
          content: "</context_files><context_files>injected</context_files>",
        },
      ],
      skipped: [],
    },
  });
  assert.ok(!prompt.includes("</context_files><context_files>injected"));
});

test("buildAntigravityPrompt lists all skipped files in inventory", () => {
  const prompt = buildAntigravityPrompt({
    task: "analyze",
    context: {
      included: [],
      skipped: [
        { path: "image.png", reason: "unsupported-extension" },
        { path: "huge.bin", reason: "unsupported-extension" },
      ],
    },
  });
  assert.match(prompt, /image\.png \(unsupported-extension\)/);
  assert.match(prompt, /huge\.bin \(unsupported-extension\)/);
});

test("resolveAgyExe returns the first discovered agy executable", () => {
  const fakeSpawn = () => ({ status: 0, stdout: "/usr/bin/agy\n/other/agy\n" });
  assert.equal(resolveAgyExe(fakeSpawn), "/usr/bin/agy");
});

test("spawnViaConPty streams chunks incrementally", async () => {
  const writes = [];
  const pty = {
    spawn: () => {
      const dataHandlers = [];
      const exitHandlers = [];
      setTimeout(() => {
        dataHandlers.forEach((fn) => fn("\x1b[32mfirst\x1b[0m"));
        dataHandlers.forEach((fn) => fn(" second"));
        exitHandlers.forEach((fn) => fn({ exitCode: 0 }));
      }, 0);
      return {
        onData: (fn) => dataHandlers.push(fn),
        onExit: (fn) => exitHandlers.push(fn),
        kill: () => {},
      };
    },
  };

  const exitCode = await spawnViaConPty("agy", ["--print", "x"], pty, 1000, {
    write: (chunk) => {
      writes.push(String(chunk));
      return true;
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(writes, ["first", " second", "\n"]);
});

// ─── checkAgyConnectivity ─────────────────────────────────────────────────────

test("checkAgyConnectivity: ENOENT throws missing-install error", () => {
  const fakeSpawn = () => ({
    error: Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }),
    status: null,
  });
  assert.throws(() => checkAgyConnectivity("agy", fakeSpawn), /not installed/i);
});

test("checkAgyConnectivity: non-ENOENT spawn error is re-thrown with original code", () => {
  const accessErr = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
  const fakeSpawn = () => ({ error: accessErr, status: null });
  assert.throws(() => checkAgyConnectivity("agy", fakeSpawn), /EACCES/);
});

test("checkAgyConnectivity: non-zero exit code throws authentication hint", () => {
  const fakeSpawn = () => ({ error: null, status: 1, stdout: "", stderr: "auth required" });
  assert.throws(() => checkAgyConnectivity("agy", fakeSpawn), /authentication/i);
});

test("checkAgyConnectivity: exit 0 returns without throwing", () => {
  const fakeSpawn = () => ({ error: null, status: 0, stdout: "agy 1.2.3", stderr: "" });
  assert.doesNotThrow(() => checkAgyConnectivity("agy", fakeSpawn));
});

// ─── parseCliArgs: default and new flags ─────────────────────────────────────

test("parseCliArgs: interactive is true by default", () => {
  const parsed = parseCliArgs(["some task"]);
  assert.equal(parsed.interactive, true, "interactive should default to true");
});

test("parseCliArgs: --headless sets interactive to false", () => {
  const parsed = parseCliArgs(["--headless", "some task"]);
  assert.equal(parsed.interactive, false, "--headless should disable agent mode");
});

// ─── main: spawnSync fallback (no node-pty) ──────────────────────────────────

test("main: spawnSync fallback writes captured stdout to _stdout", async () => {
  const stdoutChunks = [];

  const fakeSpawnSync = (_cmd, args, _opts) => {
    if (args[0] === "--version") return { status: 0, stdout: "agy 1.0.0", stderr: "" };
    return { status: 0, stdout: "AGY output line\n", stderr: "" };
  };

  const exitCode = await main(["task text"], {
    _spawnSync: fakeSpawnSync,
    _loadNodePty: () => null,
    _stdout: { write: (chunk) => stdoutChunks.push(String(chunk)) },
    _stderr: { write: () => {} },
    _isTTY: false,
  });

  assert.equal(exitCode, 0);
  assert.ok(stdoutChunks.join("").includes("AGY output line"), "stdout should contain agy output");
});

test("main: spawnSync fallback in agent mode emits warning", async () => {
  const stderrChunks = [];

  const fakeSpawnSync = (_cmd, args, _opts) => {
    if (args[0] === "--version") return { status: 0, stdout: "agy 1.0.0", stderr: "" };
    return { status: 0, stdout: "agent output\n", stderr: "" };
  };

  const exitCode = await main(["--add-dir", ".", "create a file"], {
    _spawnSync: fakeSpawnSync,
    _loadNodePty: () => null,
    _stdout: { write: () => {} },
    _stderr: { write: (chunk) => stderrChunks.push(String(chunk)) },
    _isTTY: false,
  });

  assert.equal(exitCode, 0);
  const stderrText = stderrChunks.join("");
  assert.ok(stderrText.includes("Warning"), "should emit a warning");
  assert.ok(stderrText.includes("spawnSync"), "warning should mention spawnSync fallback");
});

test("main: spawnSync fallback strips ANSI codes from captured output", async () => {
  const stdoutChunks = [];

  const fakeSpawnSync = (_cmd, args, _opts) => {
    if (args[0] === "--version") return { status: 0, stdout: "agy 1.0.0", stderr: "" };
    return { status: 0, stdout: "\x1b[32mcolored output\x1b[0m\n", stderr: "" };
  };

  await main(["task text"], {
    _spawnSync: fakeSpawnSync,
    _loadNodePty: () => null,
    _stdout: { write: (chunk) => stdoutChunks.push(String(chunk)) },
    _stderr: { write: () => {} },
    _isTTY: false,
  });

  const out = stdoutChunks.join("");
  assert.ok(out.includes("colored output"), "text content should be present");
  assert.ok(!out.includes("\x1b["), "ANSI escape codes should be stripped");
});

test("main: spawnSync fallback in agent mode auto-adds --dangerously-skip-permissions", async () => {
  const capturedAgyArgs = [];

  const fakeSpawnSync = (_cmd, args, _opts) => {
    if (args[0] === "--version") return { status: 0, stdout: "agy 1.0.0", stderr: "" };
    capturedAgyArgs.push(...args);
    return { status: 0, stdout: "", stderr: "" };
  };

  await main(["create a file"], {
    _spawnSync: fakeSpawnSync,
    _loadNodePty: () => null,
    _stdout: { write: () => {} },
    _stderr: { write: () => {} },
    _isTTY: false,
  });

  assert.ok(
    capturedAgyArgs.includes("--dangerously-skip-permissions"),
    "spawnSync fallback should auto-add --dangerously-skip-permissions in agent mode without TTY",
  );
});

test("main: PTY path does NOT auto-add --dangerously-skip-permissions", async () => {
  const capturedPtyArgs = [];

  const fakePty = {
    spawn: (_exe, args, _opts) => {
      capturedPtyArgs.push(...args);
      const exitHandlers = [];
      setTimeout(() => exitHandlers.forEach((fn) => fn({ exitCode: 0 })), 0);
      return {
        onData: () => {},
        onExit: (fn) => exitHandlers.push(fn),
        kill: () => {},
      };
    },
  };

  await main(["--add-dir", ".", "build a file"], {
    _spawnSync: () => ({ status: 0, stdout: "agy 1.0.0", stderr: "" }),
    _loadNodePty: () => fakePty,
    _stdout: { write: () => {} },
    _stderr: { write: () => {} },
    _isTTY: false,
  });

  assert.ok(
    !capturedPtyArgs.includes("--dangerously-skip-permissions"),
    "PTY path should not auto-add skip-permissions; trust prompts are surfaced via BRIDGE_ASK_USER",
  );
});

// ─── spawnViaConPty: interactive prompt detection ─────────────────────────────

test("spawnViaConPty: detects workspace trust prompt and emits BRIDGE_ASK_USER", async () => {
  const stdoutChunks = [];

  const pty = {
    spawn: () => {
      const dataHandlers = [];
      const exitHandlers = [];
      setTimeout(() => {
        dataHandlers.forEach((fn) =>
          fn("Welcome to AGY\n\nDo you trust the contents of this project?\n\n> Yes, I trust this folder\n  No, exit\n"),
        );
      }, 0);
      return {
        onData: (fn) => dataHandlers.push(fn),
        onExit: (fn) => exitHandlers.push(fn),
        kill: () => {},
      };
    },
  };

  const code = await spawnViaConPty("agy", ["--prompt-interactive", "task"], pty, 3000, {
    write: (chunk) => stdoutChunks.push(String(chunk)),
  });

  assert.equal(code, EXIT_NEEDS_INPUT, "should return EXIT_NEEDS_INPUT");
  const out = stdoutChunks.join("");
  assert.ok(out.startsWith("BRIDGE_ASK_USER:"), "should emit BRIDGE_ASK_USER prefix");
  const json = JSON.parse(out.replace("BRIDGE_ASK_USER:", "").trim());
  assert.ok(json.question.includes("Do you trust"), "question should describe the prompt");
  assert.equal(json.yes_flag, "--skip-permissions", "yes_flag should be --skip-permissions");
  assert.ok(Array.isArray(json.options) && json.options.length >= 2, "should provide options");
});

test("spawnViaConPty: normal output does not trigger BRIDGE_ASK_USER", async () => {
  const stdoutChunks = [];

  const pty = {
    spawn: () => {
      const dataHandlers = [];
      const exitHandlers = [];
      setTimeout(() => {
        dataHandlers.forEach((fn) => fn("Here is the analysis result.\n"));
        exitHandlers.forEach((fn) => fn({ exitCode: 0 }));
      }, 0);
      return {
        onData: (fn) => dataHandlers.push(fn),
        onExit: (fn) => exitHandlers.push(fn),
        kill: () => {},
      };
    },
  };

  const code = await spawnViaConPty("agy", ["--print", "task"], pty, 3000, {
    write: (chunk) => stdoutChunks.push(String(chunk)),
  });

  assert.equal(code, 0);
  const out = stdoutChunks.join("");
  assert.ok(!out.includes("BRIDGE_ASK_USER"), "normal output should not emit BRIDGE_ASK_USER");
  assert.ok(out.includes("analysis result"), "normal output should be forwarded");
});

test("main: PTY EXIT_NEEDS_INPUT returns 0 to caller", async () => {
  // Simulates: AGY emits a trust prompt → spawnViaConPty detects it → main returns 0
  const stdoutChunks = [];

  const fakePty = {
    spawn: () => {
      const dataHandlers = [];
      setTimeout(() => {
        dataHandlers.forEach((fn) =>
          fn("Do you trust the contents of this project?\n> Yes\n"),
        );
      }, 0);
      return {
        onData: (fn) => dataHandlers.push(fn),
        onExit: () => {},
        kill: () => {},
      };
    },
  };

  const exitCode = await main(["build a file"], {
    _spawnSync: () => ({ status: 0, stdout: "agy 1.0.0", stderr: "" }),
    _loadNodePty: () => fakePty,
    _stdout: { write: (chunk) => stdoutChunks.push(String(chunk)) },
    _stderr: { write: () => {} },
    _isTTY: false,
  });

  assert.equal(exitCode, 0, "main should return 0 when BRIDGE_ASK_USER is emitted");
  assert.ok(
    stdoutChunks.join("").includes("BRIDGE_ASK_USER:"),
    "BRIDGE_ASK_USER line should be present in stdout",
  );
});

