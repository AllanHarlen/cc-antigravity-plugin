import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  agyModelLabel,
  buildAntigravityArgs,
  buildAntigravityPrompt,
  buildImagePrompt,
  checkAgyConnectivity,
  classifyAgyOutput,
  collectContextFiles,
  isKnownModel,
  parseCliArgs,
  patchAgySettings,
  resolveAgyExe,
  resolveAgySettingsPath,
  resolveAutoModel,
  resolveModelAlias,
  spawnViaConPty,
  stripAnsi,
  EXIT_QUOTA_EXAUSTED,
  EXIT_AUTH_REQUIRED,
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
    model: undefined,
    timeout: undefined,
    interactive: false,
    readOnly: false,
    continueConversation: false,
    conversationId: undefined,
    sandbox: false,
    skipPermissions: true,   // agentic default
    maxFiles: 40,
    maxFileBytes: 32768,
    printCommand: false,
    generateImagem: false,
    outputFile: undefined,
    outputDir: undefined,
    parallel: false,
    subagentModel: undefined,
    help: false,
    task: "analyze the workspace",
  });
});

test("parseCliArgs handles --parallel and --subagent-model", () => {
  const justParallel = parseCliArgs(["--parallel", "fan", "out"]);
  assert.equal(justParallel.parallel, true);
  assert.equal(justParallel.subagentModel, undefined);

  // --subagent-model implies --parallel even when --parallel is absent
  const withModel = parseCliArgs(["--subagent-model", "gemini-3.5-flash-medium", "fan", "out"]);
  assert.equal(withModel.parallel, true);
  assert.equal(withModel.subagentModel, "gemini-3.5-flash-medium");
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
  // With early dir pruning in walkDirSync, node_modules is never traversed
  // so nothing from it appears in skipped — it is silently discarded at walk time.
  assert.equal(context.skipped.length, 0);
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

test("buildAntigravityPrompt omits the parallelism block by default", () => {
  const prompt = buildAntigravityPrompt({
    task: "Do one thing",
    context: { included: [], skipped: [] },
  });
  assert.doesNotMatch(prompt, /<parallelism>/);
});

test("buildAntigravityPrompt adds the parallelism block when parallel is set", () => {
  const prompt = buildAntigravityPrompt({
    task: "Build two independent reports",
    context: { included: [], skipped: [] },
    parallel: true,
  });
  assert.match(prompt, /<parallelism>/);
  assert.match(prompt, /DefineSubagent/);
  assert.match(prompt, /ManageSubagents/);
  // No subagent model specified → permissive MAY verb
  assert.match(prompt, /You MAY decompose/);
  assert.doesNotMatch(prompt, /Configure each subagent to use the model/);
});

test("buildAntigravityPrompt uses MUST when subagent-model is specified", () => {
  const prompt = buildAntigravityPrompt({
    task: "Build two independent reports",
    context: { included: [], skipped: [] },
    parallel: true,
    subagentModel: "gemini-3.5-flash-medium",
  });
  assert.match(prompt, /You MUST decompose/);
  assert.doesNotMatch(prompt, /You MAY decompose/);
  assert.match(prompt, /Each independent part of the task MUST be handled by a dedicated subagent/);
  assert.match(prompt, /Configure each subagent to use the model "Gemini 3\.5 Flash \(Medium\)"/);
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

test("buildAntigravityArgs does not include model or format in CLI args (model is applied via settings.json)", () => {
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

test("parseCliArgs --model sets model and does not contaminate task", () => {
  const parsed = parseCliArgs(["--model", "gemini-3.1-pro-low", "analyze this codebase"]);
  assert.equal(parsed.model, "gemini-3.1-pro-low");
  assert.equal(parsed.task, "analyze this codebase");
});

test("parseCliArgs --model defaults to undefined when omitted", () => {
  const parsed = parseCliArgs(["analyze this"]);
  assert.equal(parsed.model, undefined);
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

// ─── resolveAutoModel ────────────────────────────────────────────────────────

test("resolveAutoModel returns flash-low for small context", () => {
  const ctx = { included: [{ bytes: 10_000 }], skipped: [] };
  assert.equal(resolveAutoModel(ctx), "gemini-3.5-flash-low");
});

test("resolveAutoModel returns flash-medium for typical context", () => {
  const ctx = { included: [{ bytes: 100_000 }], skipped: [] };
  assert.equal(resolveAutoModel(ctx), "gemini-3.5-flash-medium");
});

test("resolveAutoModel returns flash-high for large context", () => {
  const ctx = { included: [{ bytes: 300_000 }], skipped: [] };
  assert.equal(resolveAutoModel(ctx), "gemini-3.5-flash-high");
});

test("resolveAutoModel sums bytes across multiple included files", () => {
  const ctx = { included: [{ bytes: 100_000 }, { bytes: 200_000 }], skipped: [] };
  assert.equal(resolveAutoModel(ctx), "gemini-3.5-flash-high");
});

test("resolveAutoModel returns flash-low for empty context", () => {
  const ctx = { included: [], skipped: [] };
  assert.equal(resolveAutoModel(ctx), "gemini-3.5-flash-low");
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

// ─── parseCliArgs — agentic defaults ─────────────────────────────────────────

test("parseCliArgs skipPermissions is true by default", () => {
  const parsed = parseCliArgs(["analyze this"]);
  assert.equal(parsed.skipPermissions, true);
  assert.equal(parsed.readOnly, false);
});

test("parseCliArgs --read-only sets readOnly and disables skipPermissions", () => {
  const parsed = parseCliArgs(["--read-only", "analyze this"]);
  assert.equal(parsed.readOnly, true);
  assert.equal(parsed.skipPermissions, false);
});

test("parseCliArgs --skip-permissions is a no-op when already true by default", () => {
  const parsed = parseCliArgs(["--skip-permissions", "analyze this"]);
  assert.equal(parsed.skipPermissions, true);
});

// ─── classifyAgyOutput ────────────────────────────────────────────────────────

test("classifyAgyOutput returns QUOTA_EXAUSTED for rate-limit text", () => {
  const result = classifyAgyOutput("Error: rate limit exceeded, please retry later.");
  assert.ok(result !== null);
  assert.equal(result.type, "QUOTA_EXAUSTED");
  assert.equal(result.exitCode, EXIT_QUOTA_EXAUSTED);
});

test("classifyAgyOutput returns QUOTA_EXAUSTED for 429 status", () => {
  const result = classifyAgyOutput("HTTP 429 Too Many Requests");
  assert.ok(result !== null);
  assert.equal(result.type, "QUOTA_EXAUSTED");
});

test("classifyAgyOutput extracts reason from self-reported QUOTA_EXAUSTED line", () => {
  const result = classifyAgyOutput('QUOTA_EXAUSTED reason="Gemini daily quota exceeded" model="gemini-3.5-flash-medium"');
  assert.ok(result !== null);
  assert.equal(result.type, "QUOTA_EXAUSTED");
  assert.equal(result.reason, "Gemini daily quota exceeded");
});

test("classifyAgyOutput returns AUTH_REQUIRED for not-authenticated message", () => {
  const result = classifyAgyOutput("Error: not authenticated. Please sign in first.");
  assert.ok(result !== null);
  assert.equal(result.type, "AUTH_REQUIRED");
  assert.equal(result.exitCode, EXIT_AUTH_REQUIRED);
});

test("classifyAgyOutput returns null for normal output", () => {
  const result = classifyAgyOutput("Here is the refactor plan for your codebase:\n1. Extract auth module...");
  assert.equal(result, null);
});

test("classifyAgyOutput returns null for empty output", () => {
  assert.equal(classifyAgyOutput(""), null);
});

// ─── spawnViaConPty — outputAccumulator ───────────────────────────────────────

test("collectContextFiles skips file with invalid UTF-8 encoding", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-encoding-"));
  // Bytes 0xe9 0xe0 0xe8 are valid Latin-1 (é à è) but invalid UTF-8 sequences
  await fs.writeFile(path.join(tempDir, "latin1.txt"), Buffer.from([0xe9, 0xe0, 0xe8]));

  const context = await collectContextFiles({
    cwd: tempDir,
    patterns: ["*.txt"],
    maxFiles: 10,
    maxFileBytes: 1024,
  });

  assert.equal(context.included.length, 0);
  assert.equal(context.skipped.length, 1);
  assert.equal(context.skipped[0].reason, "encoding-error");
});

// ─── agyModelLabel ────────────────────────────────────────────────────────────

test("agyModelLabel maps known bridge identifiers to AGY display labels", () => {
  assert.equal(agyModelLabel("gemini-3.5-flash-low"),    "Gemini 3.5 Flash (Low)");
  assert.equal(agyModelLabel("gemini-3.5-flash-medium"), "Gemini 3.5 Flash (Medium)");
  assert.equal(agyModelLabel("gemini-3.5-flash-high"),   "Gemini 3.5 Flash (High)");
  assert.equal(agyModelLabel("gemini-3.1-pro-low"),      "Gemini 3.1 Pro (Low)");
  assert.equal(agyModelLabel("gemini-3.1-pro-high"),     "Gemini 3.1 Pro (High)");
});

test("agyModelLabel maps Claude and GPT-OSS identifiers to AGY display labels", () => {
  assert.equal(agyModelLabel("claude-4.6-sonnet-thinking"), "Claude 4.6 Sonnet (Thinking)");
  assert.equal(agyModelLabel("claude-4.6-opus-thinking"),   "Claude 4.6 Opus (Thinking)");
  assert.equal(agyModelLabel("gpt-oss-120b-medium"),        "GPT-OSS 120B (Medium)");
});

test("agyModelLabel passes through unknown identifiers unchanged", () => {
  assert.equal(agyModelLabel("some-future-model"), "some-future-model");
});

// ─── resolveModelAlias / isKnownModel ─────────────────────────────────────────

test("resolveModelAlias passes canonical identifiers through unchanged", () => {
  for (const id of [
    "gemini-3.5-flash-low",
    "gemini-3.5-flash-medium",
    "gemini-3.5-flash-high",
    "gemini-3.1-pro-low",
    "gemini-3.1-pro-high",
    "claude-4.6-sonnet-thinking",
    "claude-4.6-opus-thinking",
    "gpt-oss-120b-medium",
    "nano-banana",
    "auto",
  ]) {
    assert.equal(resolveModelAlias(id), id);
  }
});

test("resolveModelAlias normalizes natural-language model names", () => {
  assert.equal(resolveModelAlias("gemini 3.1 pro"), "gemini-3.1-pro-high");
  assert.equal(resolveModelAlias("Gemini 3.1 Pro (Low)"), "gemini-3.1-pro-low");
  assert.equal(resolveModelAlias("gemini 3.5 flash"), "gemini-3.5-flash-medium");
  assert.equal(resolveModelAlias("flash"), "gemini-3.5-flash-medium");
  assert.equal(resolveModelAlias("claude opus"), "claude-4.6-opus-thinking");
  assert.equal(resolveModelAlias("opus"), "claude-4.6-opus-thinking");
  assert.equal(resolveModelAlias("claude sonnet"), "claude-4.6-sonnet-thinking");
  assert.equal(resolveModelAlias("sonnet"), "claude-4.6-sonnet-thinking");
  assert.equal(resolveModelAlias("gpt oss"), "gpt-oss-120b-medium");
  assert.equal(resolveModelAlias("nano banana"), "nano-banana");
});

test("resolveModelAlias normalizes underscores and mixed separators", () => {
  assert.equal(resolveModelAlias("gemini_3.1_pro_high"), "gemini-3.1-pro-high");
  assert.equal(resolveModelAlias("  Claude   Opus  "), "claude-4.6-opus-thinking");
});

test("resolveModelAlias returns unknown names unchanged", () => {
  assert.equal(resolveModelAlias("totally-made-up"), "totally-made-up");
  assert.equal(resolveModelAlias(""), "");
  assert.equal(resolveModelAlias(undefined), undefined);
});

test("isKnownModel recognizes canonical identifiers and auto, rejects others", () => {
  assert.equal(isKnownModel("gemini-3.1-pro-high"), true);
  assert.equal(isKnownModel("claude-4.6-opus-thinking"), true);
  assert.equal(isKnownModel("auto"), true);
  assert.equal(isKnownModel("gemini 3.1 pro"), false);
  assert.equal(isKnownModel("made-up"), false);
});

// ─── resolveAgySettingsPath ───────────────────────────────────────────────────

test("resolveAgySettingsPath returns ~/.gemini/antigravity-cli/settings.json", () => {
  const p = resolveAgySettingsPath();
  assert.ok(typeof p === "string" && p.endsWith("settings.json"), `unexpected path: ${p}`);
  assert.ok(p.includes(path.join(".gemini", "antigravity-cli")), `expected .gemini/antigravity-cli in path: ${p}`);
});

// ─── patchAgySettings ────────────────────────────────────────────────────────

test("patchAgySettings writes display label and restores original content", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-patch-"));
  const settingsPath = path.join(tempDir, "settings.json");

  await fs.writeFile(settingsPath, JSON.stringify({ other: true }), "utf8");
  const restore = await patchAgySettings(settingsPath, "gemini-3.1-pro-low");
  const patched = JSON.parse(await fs.readFile(settingsPath, "utf8"));
  assert.equal(patched.model, agyModelLabel("gemini-3.1-pro-low"), "must write display label, not bridge identifier");
  assert.equal(patched.other, true, "existing fields must be preserved");

  await restore();
  const restored = JSON.parse(await fs.readFile(settingsPath, "utf8"));
  assert.equal(restored.model, undefined, "model field must be removed on restore");
  assert.equal(restored.other, true);
});

test("patchAgySettings creates settings.json when absent and removes it on restore", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-patch-new-"));
  const settingsPath = path.join(tempDir, "settings.json");

  const restore = await patchAgySettings(settingsPath, "gemini-3.5-flash-high");
  const created = JSON.parse(await fs.readFile(settingsPath, "utf8"));
  assert.equal(created.model, agyModelLabel("gemini-3.5-flash-high"));

  await restore();
  await assert.rejects(() => fs.readFile(settingsPath, "utf8"), "settings.json should be deleted on restore");
});

test("spawnViaConPty heartbeat: timeout resets on each output chunk", async () => {
  // 5 chunks at 20ms intervals = 100ms total run; silence between chunks = 20ms.
  // Timeout = 50ms. Without heartbeat the timer fires at ~50ms (chunk 2).
  // With heartbeat, each chunk resets the 50ms window — all 5 chunks should arrive.
  let chunkCount = 0;
  const pty = {
    spawn: () => {
      const dataHandlers = [];
      const exitHandlers = [];
      const term = {
        onData: (fn) => dataHandlers.push(fn),
        onExit: (fn) => exitHandlers.push(fn),
        kill: () => {},
      };
      const emit = () => {
        chunkCount += 1;
        dataHandlers.forEach((fn) => fn(`chunk${chunkCount}`));
        if (chunkCount < 5) {
          setTimeout(emit, 20);
        } else {
          setTimeout(() => exitHandlers.forEach((fn) => fn({ exitCode: 0 })), 20);
        }
      };
      setTimeout(emit, 20);
      return term;
    },
  };
  const chunks = [];
  const exitCode = await spawnViaConPty("agy", ["--print", "x"], pty, 50, {
    write: (chunk) => { chunks.push(String(chunk)); return true; },
  });
  assert.equal(exitCode, 0);
  assert.ok(chunks.some((c) => c.includes("chunk5")), "all 5 chunks must arrive before timeout");
});

test("spawnViaConPty populates outputAccumulator when provided", async () => {
  const chunks = [];
  const pty = {
    spawn: () => {
      const dataHandlers = [];
      const exitHandlers = [];
      setTimeout(() => {
        dataHandlers.forEach((fn) => fn("hello "));
        dataHandlers.forEach((fn) => fn("world"));
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
    write: () => true,
  }, chunks);
  assert.equal(exitCode, 0);
  assert.deepEqual(chunks, ["hello ", "world"]);
});

// ─── generate_imagem / nano-banana ───────────────────────────────────────────

test("parseCliArgs --generate-imagem sets generateImagem true", () => {
  const parsed = parseCliArgs(["--generate-imagem", "a sunset over the ocean"]);
  assert.equal(parsed.generateImagem, true);
  assert.equal(parsed.task, "a sunset over the ocean");
});

test("parseCliArgs generateImagem is false by default", () => {
  const parsed = parseCliArgs(["analyze this"]);
  assert.equal(parsed.generateImagem, false);
});

test("parseCliArgs --generate-imagem does not contaminate model", () => {
  const parsed = parseCliArgs(["--generate-imagem", "a cat"]);
  assert.equal(parsed.model, undefined);
});

test("agyModelLabel maps nano-banana to Nano Banana", () => {
  assert.equal(agyModelLabel("nano-banana"), "Nano Banana");
});

test("buildImagePrompt contains generate_imagem constraint", () => {
  const prompt = buildImagePrompt({
    task: "a futuristic city at night",
    context: { included: [], skipped: [] },
  });
  assert.match(prompt, /generate_imagem/);
  assert.match(prompt, /a futuristic city at night/);
});

test("buildImagePrompt renders task block and image-specific constraints", () => {
  const prompt = buildImagePrompt({
    task: "a red balloon",
    context: { included: [], skipped: [] },
  });
  assert.match(prompt, /<task>\s*a red balloon\s*<\/task>/);
  assert.match(prompt, /image generation assistant/);
  assert.match(prompt, /write_to_file/);
});

test("buildImagePrompt includes context inventory when files are provided", () => {
  const prompt = buildImagePrompt({
    task: "a logo",
    context: {
      included: [
        {
          path: "style.json",
          mediaType: "application/json",
          bytes: 20,
          truncated: false,
          content: '{"color":"blue"}',
        },
      ],
      skipped: [],
    },
  });
  assert.match(prompt, /style\.json/);
  assert.match(prompt, /application\/json/);
});

