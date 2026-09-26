import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import {
  buildAntigravityArgs,
  appendRunJournal,
  buildAntigravityPrompt,
  buildDesignSystemBlock,
  buildImagePrompt,
  DESIGN_SYSTEM_CORE_FILES,
  checkAgyConnectivity,
  classifyAgyOutput,
  collectContextFiles,
  collectDesignSystemContext,
  copyGeneratedImages,
  createAgyStreamParser,
  fitContextToPromptBudget,
  inspectGeneratedImage,
  killProcessTree,
  mergeDesignSystemContext,
  resolvePromptTransport,
  FALLBACK_MODEL_CATALOG,
  isKnownModel,
  parseAgyJsonResult,
  parseAgyModelsOutput,
  parseCliArgs,
  parseExpectedAspectRatio,
  parseTimeoutMs,
  resolveAgyExe,
  resolveAutoModel,
  resolveModelCatalog,
  resolveModelAlias,
  spawnImageHeadless,
  spawnViaConPty,
  stripAnsi,
  waitForGeneratedImage,
  EXIT_QUOTA_EXAUSTED,
  EXIT_AUTH_REQUIRED,
} from "../scripts/antigravity-bridge.js";

function pngBytes(width = 1600, height = 900) {
  const png = Buffer.alloc(36);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  png.write("IEND", 28, "ascii");
  return png;
}

test("copyGeneratedImages emits the exact receipt from the copied destination", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agy-image-result-"));
  const brain = path.join(root, "brain");
  const dest = path.join(root, "dest");
  await fs.mkdir(brain, { recursive: true });
  const source = path.join(brain, "hero.png");
  await fs.writeFile(source, pngBytes());
  const output = [];
  const receipt = await copyGeneratedImages(0, dest, { write: (value) => output.push(String(value)) }, {
    sourcePath: source,
    runId: "receipt-test",
  });
  assert.deepEqual(Object.keys(receipt), ["schemaVersion", "count", "images"]);
  assert.deepEqual(Object.keys(receipt.images[0]), [
    "destination", "bytes", "sha256", "mime", "width", "height", "aspectRatio",
  ]);
  assert.deepEqual(
    { ...receipt.images[0], destination: path.basename(receipt.images[0].destination), sha256: "<hash>" },
    {
      destination: "imagem-gerada.receipt-test.png",
      bytes: 36,
      sha256: "<hash>",
      mime: "image/png",
      width: 1600,
      height: 900,
      aspectRatio: 1.777778,
    },
  );
  assert.match(receipt.images[0].sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(await fs.readFile(receipt.images[0].destination), pngBytes());
  assert.equal((output.join("").match(/AGY_IMAGE_RESULT:/g) ?? []).length, 1);
  await fs.rm(root, { recursive: true, force: true });
});

test("copyGeneratedImages rejects invalid bytes and an unexpected aspect ratio", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agy-image-validation-"));
  const brain = path.join(root, "brain");
  await fs.mkdir(brain, { recursive: true });
  await fs.writeFile(path.join(brain, "fake.png"), "not-an-image");
  await assert.rejects(
    copyGeneratedImages(0, path.join(root, "dest"), { write: () => true }, { brainBase: brain }),
    (error) => error.code === "EAGYIMAGEINVALID",
  );

  await fs.writeFile(path.join(brain, "fake.png"), pngBytes(1000, 1000));
  await assert.rejects(
    copyGeneratedImages(0, path.join(root, "dest"), { write: () => true }, { brainBase: brain, expectedAspectRatio: 16 / 9 }),
    (error) => error.code === "EAGYIMAGEASPECT",
  );
  await fs.rm(root, { recursive: true, force: true });
});

test("inspectGeneratedImage rejects an extension/content mismatch", () => {
  assert.throws(() => inspectGeneratedImage(pngBytes(10, 5), ".jpg"), (error) => error.code === "EAGYIMAGEINVALID");
});

test("parseExpectedAspectRatio recognizes explicit task ratios", () => {
  assert.equal(parseExpectedAspectRatio("hero image, aspect ratio 16:9"), 16 / 9);
  assert.equal(parseExpectedAspectRatio("imagem quadrada sem proporcao explicita"), null);
});

test("copyGeneratedImages fails closed when output is missing or ambiguous", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agy-image-count-"));
  const brain = path.join(root, "brain");
  await fs.mkdir(brain, { recursive: true });
  await assert.rejects(
    copyGeneratedImages(0, path.join(root, "dest"), { write: () => true }, { brainBase: brain }),
    (error) => error.code === "EAGYIMAGEMISSING",
  );
  await fs.writeFile(path.join(brain, "one.png"), "one");
  await fs.writeFile(path.join(brain, "two.png"), "two");
  await assert.rejects(
    copyGeneratedImages(0, path.join(root, "dest"), { write: () => true }, { brainBase: brain }),
    (error) => error.code === "EAGYIMAGEAMBIGUOUS",
  );
  await fs.rm(root, { recursive: true, force: true });
});

test("copyGeneratedImages reports a copy failure and emits no receipt", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agy-image-copy-fail-"));
  const source = path.join(root, "source.png");
  const destinationFile = path.join(root, "not-a-directory");
  await fs.writeFile(source, pngBytes());
  await fs.writeFile(destinationFile, "occupied");
  const output = [];
  await assert.rejects(
    copyGeneratedImages(0, destinationFile, { write: (value) => output.push(String(value)) }, { sourcePath: source }),
  );
  assert.equal(output.length, 0);
  await fs.rm(root, { recursive: true, force: true });
});

test("concurrent copies into the same output directory use distinct immutable destinations", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agy-image-copy-concurrent-"));
  const dest = path.join(root, "dest");
  const first = path.join(root, "first.png");
  const second = path.join(root, "second.png");
  await fs.writeFile(first, pngBytes(800, 600));
  await fs.writeFile(second, pngBytes(1600, 900));
  const [a, b] = await Promise.all([
    copyGeneratedImages(0, dest, { write: () => true }, { sourcePath: first, runId: "run-a" }),
    copyGeneratedImages(0, dest, { write: () => true }, { sourcePath: second, runId: "run-b" }),
  ]);
  assert.notEqual(a.images[0].destination, b.images[0].destination);
  assert.equal(a.images[0].width, 800);
  assert.equal(b.images[0].width, 1600);
  assert.deepEqual((await fs.readdir(dest)).sort(), [
    "imagem-gerada.run-a.png",
    "imagem-gerada.run-b.png",
  ]);
  await fs.rm(root, { recursive: true, force: true });
});

function makeImageSpawn({ conversationId, sessionDir, imageDelayMs, closeDelayMs, neverClose = false }) {
  const state = { child: null, killed: false };
  const spawn = () => {
    const child = new EventEmitter();
    child.pid = 4242;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    let closed = false;
    const close = (code) => {
      if (closed) return;
      closed = true;
      child.stdout.end();
      child.stderr.end();
      child.emit("close", code);
    };
    child.kill = () => { state.killed = true; close(1); };
    state.child = child;
    queueMicrotask(() => child.stdout.write(`${JSON.stringify({ event: "init", conversation_id: conversationId })}\n`));
    if (imageDelayMs != null) {
      setTimeout(() => { void fs.writeFile(path.join(sessionDir, "generated.png"), pngBytes()); }, imageDelayMs);
    }
    if (!neverClose) setTimeout(() => close(0), closeDelayMs ?? 40);
    return child;
  };
  return { spawn, state };
}

test("spawnImageHeadless accepts an image when AGY exits normally after generating it", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agy-image-normal-"));
  const conversationId = "conv-normal";
  const sessionDir = path.join(root, conversationId);
  await fs.mkdir(sessionDir, { recursive: true });
  const fake = makeImageSpawn({ conversationId, sessionDir, imageDelayMs: 5, closeDelayMs: 8 });
  const result = await spawnImageHeadless("agy", ["--output-format", "stream-json"], {
    brainBase: root,
    sinceMs: Date.now(),
    timeoutMs: 200,
    _spawn: fake.spawn,
    _stderr: { write: () => true },
    pollIntervalMs: 5,
    stableChecks: 2,
    stableForMs: 10,
    postExitGraceMs: 30,
    terminationWaitMs: 20,
    _killProcessTree: (_pid, fallback) => { fallback(); return { ok: true, method: "test-tree" }; },
  });
  assert.equal(result.conversationId, conversationId);
  assert.equal(path.basename(result.sourcePath), "generated.png");
  assert.equal(result.termination.method, "already-exited");
  await fs.rm(root, { recursive: true, force: true });
});

test("spawnImageHeadless finishes when the image appears before AGY exits and kills the process tree", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agy-image-hung-"));
  const conversationId = "conv-hung";
  const sessionDir = path.join(root, conversationId);
  await fs.mkdir(sessionDir, { recursive: true });
  const fake = makeImageSpawn({ conversationId, sessionDir, imageDelayMs: 5, neverClose: true });
  const killed = [];
  const result = await spawnImageHeadless("agy", ["--output-format", "stream-json"], {
    brainBase: root,
    sinceMs: Date.now(),
    timeoutMs: 200,
    _spawn: fake.spawn,
    _stderr: { write: () => true },
    pollIntervalMs: 5,
    stableChecks: 2,
    stableForMs: 10,
    terminationWaitMs: 20,
    _killProcessTree: (pid, fallback) => {
      killed.push(pid);
      fallback();
      return { ok: true, method: "taskkill", pid };
    },
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(killed, [4242]);
  assert.equal(fake.state.killed, true);
  await fs.rm(root, { recursive: true, force: true });
});

test("spawnImageHeadless times out without an image and still kills child and subprocess tree", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agy-image-timeout-"));
  const conversationId = "conv-timeout";
  const sessionDir = path.join(root, conversationId);
  await fs.mkdir(sessionDir, { recursive: true });
  const fake = makeImageSpawn({ conversationId, sessionDir, neverClose: true });
  const killed = [];
  await assert.rejects(
    spawnImageHeadless("agy", ["--output-format", "stream-json"], {
      brainBase: root,
      sinceMs: Date.now(),
      timeoutMs: 35,
      _spawn: fake.spawn,
      _stderr: { write: () => true },
      pollIntervalMs: 5,
      _killProcessTree: (pid, fallback) => {
        killed.push(pid);
        fallback();
        return { ok: true, method: "taskkill", pid };
      },
    }),
    (error) => error.code === "ETIMEDOUT",
  );
  assert.deepEqual(killed, [4242]);
  assert.equal(fake.state.killed, true);
  await fs.rm(root, { recursive: true, force: true });
});

test("killProcessTree uses Windows taskkill tree and force switches", () => {
  const calls = [];
  const result = killProcessTree(9876, () => assert.fail("direct fallback should not run"), {
    platform: "win32",
    _spawnSync: (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0 };
    },
  });
  assert.deepEqual(calls[0].args, ["/pid", "9876", "/T", "/F"]);
  assert.equal(result.ok, true);
  assert.equal(result.method, "taskkill");
});

test("concurrent image observers bind only to their own conversation directory", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agy-image-concurrent-"));
  const sinceMs = Date.now();
  const ids = ["conv-a", "conv-b"];
  await Promise.all(ids.map((id) => fs.mkdir(path.join(root, id), { recursive: true })));
  const waits = ids.map((id) => waitForGeneratedImage({
    brainBase: root,
    sinceMs,
    timeoutMs: 200,
    getConversationId: () => id,
    pollIntervalMs: 5,
    stableChecks: 2,
    stableForMs: 10,
  }));
  await fs.writeFile(path.join(root, "conv-a", "a.png"), pngBytes(800, 600));
  await fs.writeFile(path.join(root, "conv-b", "b.png"), pngBytes(1600, 900));
  const [a, b] = await Promise.all(waits);
  assert.equal(path.basename(a.sourcePath), "a.png");
  assert.equal(path.basename(b.sourcePath), "b.png");
  await fs.rm(root, { recursive: true, force: true });
});

test("image observer ignores an old image already present in the selected brain session", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agy-image-old-"));
  const conversationId = "conv-old";
  const sessionDir = path.join(root, conversationId);
  await fs.mkdir(sessionDir, { recursive: true });
  const oldPath = path.join(sessionDir, "old.png");
  await fs.writeFile(oldPath, pngBytes());
  const oldDate = new Date(Date.now() - 10_000);
  await fs.utimes(oldPath, oldDate, oldDate);
  const closedAt = Date.now() - 50;
  await assert.rejects(
    waitForGeneratedImage({
      brainBase: root,
      sinceMs: Date.now(),
      timeoutMs: 100,
      getConversationId: () => conversationId,
      getProcessState: () => ({ closed: true, closedAt }),
      pollIntervalMs: 5,
      postExitGraceMs: 20,
    }),
    (error) => error.code === "EAGYIMAGEMISSING",
  );
  await fs.rm(root, { recursive: true, force: true });
});

test("image observer waits for a partially-written file to become valid", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agy-image-partial-"));
  const conversationId = "conv-partial";
  const sessionDir = path.join(root, conversationId);
  await fs.mkdir(sessionDir, { recursive: true });
  const imagePath = path.join(sessionDir, "partial.png");
  const wait = waitForGeneratedImage({
    brainBase: root,
    sinceMs: Date.now(),
    timeoutMs: 250,
    getConversationId: () => conversationId,
    pollIntervalMs: 5,
    stableChecks: 2,
    stableForMs: 10,
    invalidGraceMs: 80,
  });
  await fs.writeFile(imagePath, pngBytes().subarray(0, 8));
  setTimeout(() => { void fs.writeFile(imagePath, pngBytes()); }, 30);
  const result = await wait;
  assert.equal(result.metadata.width, 1600);
  await fs.rm(root, { recursive: true, force: true });
});

test("image observer rejects multiple candidates and invalid signatures", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agy-image-invalid-"));
  const multiDir = path.join(root, "conv-multi");
  await fs.mkdir(multiDir, { recursive: true });
  const sinceMs = Date.now();
  await fs.writeFile(path.join(multiDir, "one.png"), pngBytes());
  await fs.writeFile(path.join(multiDir, "two.png"), pngBytes());
  await assert.rejects(
    waitForGeneratedImage({
      brainBase: root,
      sinceMs,
      timeoutMs: 100,
      getConversationId: () => "conv-multi",
      pollIntervalMs: 5,
    }),
    (error) => error.code === "EAGYIMAGEAMBIGUOUS",
  );

  const invalidDir = path.join(root, "conv-invalid");
  await fs.mkdir(invalidDir, { recursive: true });
  await fs.writeFile(path.join(invalidDir, "fake.png"), "not an image");
  const closedAt = Date.now();
  await assert.rejects(
    waitForGeneratedImage({
      brainBase: root,
      sinceMs,
      timeoutMs: 100,
      getConversationId: () => "conv-invalid",
      getProcessState: () => ({ closed: true, closedAt }),
      pollIntervalMs: 5,
      stableChecks: 2,
      stableForMs: 10,
      postExitGraceMs: 30,
    }),
    (error) => error.code === "EAGYIMAGEINVALID",
  );
  await fs.rm(root, { recursive: true, force: true });
});

test("appendRunJournal keeps an append-only recoverable execution record", async () => {
  const journalPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "agy-runs-")), "runs.jsonl");
  appendRunJournal({ runId: "run-recovery", status: "RUNNING", pid: 123 }, journalPath);
  appendRunJournal({ runId: "run-recovery", status: "DONE", exitCode: 0 }, journalPath);
  const records = (await fs.readFile(journalPath, "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(records.map(({ runId, status }) => ({ runId, status })), [
    { runId: "run-recovery", status: "RUNNING" },
    { runId: "run-recovery", status: "DONE" },
  ]);
});

test("parseTimeoutMs accepts a bare millisecond count", () => {
  assert.equal(parseTimeoutMs("5000"), 5000);
});

test("parseTimeoutMs accepts single-unit durations", () => {
  assert.equal(parseTimeoutMs("500ms"), 500);
  assert.equal(parseTimeoutMs("30s"), 30_000);
  assert.equal(parseTimeoutMs("5m"), 300_000);
  assert.equal(parseTimeoutMs("1h"), 3_600_000);
});

test("parseTimeoutMs accepts compound Go-style durations", () => {
  assert.equal(parseTimeoutMs("5m0s"), 300_000);
  assert.equal(parseTimeoutMs("5m30s"), 330_000);
  assert.equal(parseTimeoutMs("1h30m"), 5_400_000);
  assert.equal(parseTimeoutMs("1h2m3s"), 3_723_000);
});

test("parseTimeoutMs falls back to the default on unparseable input", () => {
  assert.equal(parseTimeoutMs("5m30x"), 600_000);
  assert.equal(parseTimeoutMs("garbage"), 600_000);
  assert.equal(parseTimeoutMs(""), 600_000);
  assert.equal(parseTimeoutMs(undefined), 600_000);
});

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
    priorityFiles: [],
    designSystems: [],
    taskFile: undefined,
    promptFile: undefined,
    useStdin: false,
    dumpPromptPath: undefined,
    format: "text",
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
  assert.match(prompt, /Configure each subagent to use the model "gemini-3\.5-flash-medium"/);
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
    "--output-format",
    "json",
    "--disable-slash-commands",
    "--print",
    "<task>Analyze</task>",
    "--print-timeout",
    "3m",
  ]);
});

test("buildAntigravityArgs forwards model, format, effort, mode, agent, and schema", () => {
  const args = buildAntigravityArgs({
    prompt: "x",
    model: "gemini-3.7-flash-high",
    format: "json",
    effort: "high",
    mode: "plan",
    agent: "code-reviewer",
    jsonSchema: "schema.json",
  });
  assert.deepEqual(args, [
    "--model", "gemini-3.7-flash-high",
    "--effort", "high",
    "--mode", "plan",
    "--agent", "code-reviewer",
    "--output-format", "json",
    "--json-schema", "schema.json",
    "--disable-slash-commands",
    "--print", "x",
    "--print-timeout", "600000ms",
  ]);
});

test("buildAntigravityArgs always sends --print-timeout in headless mode, defaulting to CONPTY_TIMEOUT_MS when --timeout is absent", () => {
  // Achado 7: sem isso, agy usa seu proprio default de 5 min quando --timeout
  // nao e informado — 7 de 9 dispatches sem --timeout na run analisada
  // morreram aos ~5m05s com bytes:0 e exit de sucesso.
  const withoutTimeout = buildAntigravityArgs({ prompt: "x" });
  assert.deepEqual(withoutTimeout.slice(-2), ["--print-timeout", "600000ms"]);

  const withTimeout = buildAntigravityArgs({ prompt: "x", timeout: "10m" });
  assert.deepEqual(withTimeout.slice(-2), ["--print-timeout", "10m"]);
});

test("buildAntigravityPrompt uses non-mutating constraints in read-only mode", () => {
  const prompt = buildAntigravityPrompt({
    task: "Analyze",
    context: { included: [], skipped: [] },
    readOnly: true,
  });
  assert.match(prompt, /read-only analysis assistant/);
  assert.match(prompt, /Do not call write_to_file/);
  assert.doesNotMatch(prompt, /create and edit files/);
  // Headless read-only nao aprova a permissao "command": o prompt nao pode
  // oferecer run_command, senao o AGY aborta a analise sem saida.
  assert.match(prompt, /or run_command\./);
  assert.doesNotMatch(prompt, /read-only run_command/);
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
    "code-reviewer",
    "task",
  ]);

  assert.deepEqual(parsed.addDirs, ["src", "docs"]);
  assert.equal(parsed.timeout, "3m");
  assert.equal(parsed.continueConversation, true);
  assert.equal(parsed.conversationId, "conv-1");
  assert.equal(parsed.sandbox, true);
  assert.equal(parsed.skipPermissions, true);
  assert.equal(parsed.agent, "code-reviewer");
  assert.equal(parsed.interactive, false);
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

test("parseCliArgs --priority-files accumulates and splits on commas", () => {
  const parsed = parseCliArgs([
    "--priority-files", "src/services/a.ts,src/services/b.ts",
    "--priority-files", "src/api/c.ts",
    "task",
  ]);
  assert.deepEqual(parsed.priorityFiles, ["src/services/a.ts", "src/services/b.ts", "src/api/c.ts"]);
});

test("parseCliArgs --dump-prompt captures the sidecar path", () => {
  const parsed = parseCliArgs(["--dump-prompt", "out/prompt.txt", "task"]);
  assert.equal(parsed.dumpPromptPath, "out/prompt.txt");
});

test("parseCliArgs --task-file reads task text from disk instead of argv", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-taskfile-"));
  const taskFile = path.join(tempDir, "task.md");
  await fs.writeFile(taskFile, "Implement the thing.\nWith two lines.\n");

  const parsed = parseCliArgs(["--task-file", taskFile]);
  assert.equal(parsed.task, "Implement the thing.\nWith two lines.\n");
});

test("parseCliArgs throws when --task-file is combined with an explicit task", () => {
  assert.throws(
    () => parseCliArgs(["--task-file", "task.md", "also this text"]),
    /either --task-file or an explicit task/i,
  );
});

test("parseCliArgs throws a clear error when --task-file points at a missing file", () => {
  assert.throws(
    () => parseCliArgs(["--task-file", "does/not/exist.md"]),
    /Failed to read --task-file/,
  );
});

test("parseCliArgs throws when no task and no --help", () => {
  assert.throws(() => parseCliArgs([]), /task is required/i);
});

test("parseCliArgs throws on unsupported --format value", () => {
  assert.throws(() => parseCliArgs(["--format", "yaml", "task"]), /unsupported/i);
});

test("parseCliArgs supports modern headless flags and read-only enforces plan mode", () => {
  const parsed = parseCliArgs([
    "--format", "stream-json",
    "--effort", "medium",
    "--mode", "accept-edits",
    "--json-schema", "schema.json",
    "--allow-slash-commands",
    "--read-only",
    "task",
  ]);
  assert.equal(parsed.format, "json", "json-schema must force JSON output");
  assert.equal(parsed.effort, "medium");
  assert.equal(parsed.mode, "plan", "read-only must override accept-edits regardless of flag order");
  assert.equal(parsed.jsonSchema, "schema.json");
  assert.equal(parsed.disableSlashCommands, false);
  assert.equal(parsed.skipPermissions, false);
});

test("parseCliArgs --agent requires a name and points interactive users to --interactive", () => {
  assert.throws(() => parseCliArgs(["--agent"]), /Use --interactive/);
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

test("collectContextFiles keeps priorityPaths ahead of the max-files cutoff", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-priority-"));
  // Alphabetically these sort a, b, c, d, e — plain sort would keep a/b/c and
  // drop d/e. Prioritizing "e.txt" must save it from the cutoff.
  for (const name of ["a", "b", "c", "d", "e"]) {
    await fs.writeFile(path.join(tempDir, `${name}.txt`), `content ${name}`);
  }

  const context = await collectContextFiles({
    cwd: tempDir,
    patterns: ["*.txt"],
    maxFiles: 3,
    maxFileBytes: 1024,
    priorityPaths: ["e.txt"],
  });

  const includedPaths = context.included.map((f) => f.path).sort();
  assert.equal(context.included.length, 3);
  assert.ok(includedPaths.includes("e.txt"), "prioritized file must survive the cutoff");
  const skippedPaths = context.skipped.map((f) => f.path);
  assert.ok(!skippedPaths.includes("e.txt"));
});

test("collectContextFiles with no priorityPaths preserves plain alphabetical order (unchanged default)", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-noprio-"));
  for (const name of ["a", "b", "c", "d", "e"]) {
    await fs.writeFile(path.join(tempDir, `${name}.txt`), `content ${name}`);
  }

  const context = await collectContextFiles({
    cwd: tempDir,
    patterns: ["*.txt"],
    maxFiles: 3,
    maxFileBytes: 1024,
  });

  assert.deepEqual(
    context.included.map((f) => f.path).sort(),
    ["a.txt", "b.txt", "c.txt"],
  );
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
//
// These tests pass an explicit fixture catalog rather than relying on
// FALLBACK_MODEL_CATALOG's default (live) contents, so a future catalog
// update (a new Gemini Flash generation, say) never requires rewriting these
// assertions — only the tests that specifically assert on the live default
// need updating then.
const AUTO_MODEL_FIXTURE_CATALOG = Object.freeze([
  { slug: "gemini-9.9-flash-low", label: "Gemini 9.9 Flash (Low)" },
  { slug: "gemini-9.9-flash-medium", label: "Gemini 9.9 Flash (Medium)" },
  { slug: "gemini-9.9-flash-high", label: "Gemini 9.9 Flash (High)" },
  { slug: "gemini-9.8-flash-low", label: "Gemini 9.8 Flash (Low)" },
]);

test("resolveAutoModel returns flash-low for small context", () => {
  const ctx = { included: [{ bytes: 10_000 }], skipped: [] };
  assert.equal(resolveAutoModel(ctx, AUTO_MODEL_FIXTURE_CATALOG), "gemini-9.9-flash-low");
});

test("resolveAutoModel returns flash-medium for typical context", () => {
  const ctx = { included: [{ bytes: 100_000 }], skipped: [] };
  assert.equal(resolveAutoModel(ctx, AUTO_MODEL_FIXTURE_CATALOG), "gemini-9.9-flash-medium");
});

test("resolveAutoModel returns flash-high for large context", () => {
  const ctx = { included: [{ bytes: 300_000 }], skipped: [] };
  assert.equal(resolveAutoModel(ctx, AUTO_MODEL_FIXTURE_CATALOG), "gemini-9.9-flash-high");
});

test("resolveAutoModel sums bytes across multiple included files", () => {
  const ctx = { included: [{ bytes: 100_000 }, { bytes: 200_000 }], skipped: [] };
  assert.equal(resolveAutoModel(ctx, AUTO_MODEL_FIXTURE_CATALOG), "gemini-9.9-flash-high");
});

test("resolveAutoModel returns flash-low for empty context", () => {
  const ctx = { included: [], skipped: [] };
  assert.equal(resolveAutoModel(ctx, AUTO_MODEL_FIXTURE_CATALOG), "gemini-9.9-flash-low");
});

test("resolveAutoModel selects the newest flash family from the live default catalog", () => {
  // Pins only that resolveAutoModel tracks FALLBACK_MODEL_CATALOG's current
  // newest family — updated whenever the catalog gains a newer generation.
  const ctx = { included: [{ bytes: 10_000 }], skipped: [] };
  assert.equal(resolveAutoModel(ctx), "gemini-3.8-flash-low");
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
  assert.equal(parsed.mode, "plan");
  assert.equal(parsed.disableSlashCommands, false);
});

test("parseCliArgs --skip-permissions is a no-op when already true by default", () => {
  const parsed = parseCliArgs(["--skip-permissions", "analyze this"]);
  assert.equal(parsed.skipPermissions, true);
});

// Real run (OficinaAI, 2026-09-22): --read-only --disable-slash-commands
// together used to have the read-only block silently force
// disableSlashCommands back to false, discarding the explicit flag. AGY then
// expanded --mode plan as if the user had typed the bare "/plan" slash
// command, and the read-only review task never actually ran.
test("parseCliArgs --read-only honors an explicit --disable-slash-commands instead of discarding it", () => {
  const parsed = parseCliArgs(["--read-only", "--disable-slash-commands", "analyze this"]);
  assert.equal(parsed.readOnly, true);
  assert.equal(parsed.mode, "plan");
  assert.equal(parsed.disableSlashCommands, true, "explicit flag must survive the read-only block");
});

test("parseCliArgs --disable-slash-commands then --read-only (flag order reversed) still honors it", () => {
  const parsed = parseCliArgs(["--disable-slash-commands", "--read-only", "analyze this"]);
  assert.equal(parsed.disableSlashCommands, true);
});

test("parseCliArgs --read-only with --allow-slash-commands still leaves expansion enabled (unchanged default)", () => {
  const parsed = parseCliArgs(["--read-only", "--allow-slash-commands", "analyze this"]);
  assert.equal(parsed.disableSlashCommands, false);
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

// ─── dynamic model catalog ────────────────────────────────────────────────────

test("parseAgyModelsOutput parses slug and display label columns", () => {
  assert.deepEqual(
    parseAgyModelsOutput(
      "gemini-3.7-flash-high\tGemini 3.7 Flash (High)\nclaude-opus-4-6-thinking   Claude Opus 4.6 (Thinking)\n",
    ),
    [
      { slug: "gemini-3.7-flash-high", label: "Gemini 3.7 Flash (High)" },
      { slug: "claude-opus-4-6-thinking", label: "Claude Opus 4.6 (Thinking)" },
    ],
  );
});

test("resolveModelAlias resolves labels and families against the newest runtime catalog member", () => {
  assert.equal(resolveModelAlias("Gemini 3.7 Flash (Medium)"), "gemini-3.7-flash-medium");
  // Explicit version is preserved regardless of the catalog's newest family.
  assert.equal(resolveModelAlias("gemini 3.7 flash"), "gemini-3.7-flash-high");
  // Family-only alias tracks the newest family in the live default catalog —
  // update this alongside FALLBACK_MODEL_CATALOG whenever a newer generation ships.
  assert.equal(resolveModelAlias("flash"), "gemini-3.8-flash-high");
  assert.equal(resolveModelAlias("opus"), "claude-opus-4-6-thinking");
  assert.equal(resolveModelAlias("sonnet"), "claude-sonnet-4-6");
  assert.equal(resolveModelAlias("gpt oss"), "gpt-oss-120b-medium");
});

test("resolveModelAlias returns unknown names unchanged", () => {
  assert.equal(resolveModelAlias("totally-made-up"), "totally-made-up");
  assert.equal(resolveModelAlias(""), "");
  assert.equal(resolveModelAlias(undefined), undefined);
});

test("isKnownModel recognizes runtime slugs and auto, rejects obsolete and unknown slugs", () => {
  assert.equal(isKnownModel("gemini-3.7-flash-high"), true);
  assert.equal(isKnownModel("claude-opus-4-6-thinking"), true);
  assert.equal(isKnownModel("auto"), true);
  assert.equal(isKnownModel("claude-4.6-opus-thinking"), false);
  assert.equal(isKnownModel("made-up"), false);
});

test("resolveModelCatalog queries agy models, writes cache, then serves a fresh cache", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-model-cache-"));
  const cachePath = path.join(tempDir, "models.json");
  let calls = 0;
  const first = await resolveModelCatalog({
    agyExe: "agy",
    cachePath,
    now: 1_000,
    _spawnSync: () => {
      calls += 1;
      return { status: 0, stdout: "future-model-1 Future Model 1\n" };
    },
  });
  const second = await resolveModelCatalog({
    agyExe: "agy",
    cachePath,
    now: 2_000,
    _spawnSync: () => { throw new Error("cache should avoid CLI call"); },
  });
  assert.equal(calls, 1);
  assert.deepEqual(first, [{ slug: "future-model-1", label: "Future Model 1" }]);
  assert.deepEqual(second, first);
});

test("resolveModelCatalog falls back when agy models is unavailable", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-model-fallback-"));
  const models = await resolveModelCatalog({
    agyExe: "agy",
    cachePath: path.join(tempDir, "missing.json"),
    _spawnSync: () => ({ status: 1, stdout: "", stderr: "not authenticated" }),
  });
  assert.deepEqual(models, FALLBACK_MODEL_CATALOG);
});

// Gated behind AGY_LIVE=1: this test shells out to the real `agy` CLI (a real
// network call, ~5s), so a routine `npm test` must stay hermetic and fast. Run
// it explicitly (`AGY_LIVE=1 npm test`) or via the live-drift-check CI job on
// a self-hosted runner with an authenticated `agy` installed.
test("installed agy model catalog is covered by the emergency fallback", (t) => {
  if (process.env.AGY_LIVE !== "1") {
    t.skip("set AGY_LIVE=1 to run this test against the real agy CLI");
    return;
  }
  const result = spawnSync("agy", ["models"], { encoding: "utf8", shell: false, timeout: 30_000 });
  const installed = result.status === 0 ? parseAgyModelsOutput(result.stdout) : [];
  if (installed.length === 0) {
    t.skip("agy is absent, unauthenticated, or did not return a model catalog");
    return;
  }
  const fallbackSlugs = new Set(FALLBACK_MODEL_CATALOG.map(({ slug }) => slug));
  assert.deepEqual(
    installed.filter(({ slug }) => !fallbackSlugs.has(slug)),
    [],
    "add every installed AGY model to FALLBACK_MODEL_CATALOG",
  );
});

test("parseAgyJsonResult normalizes the real JSON envelope and quota classification", () => {
  const result = parseAgyJsonResult(JSON.stringify({
    conversation_id: "6d4c3cf0-test",
    status: "ERROR",
    response: "",
    error: "Individual quota reached. Please upgrade your subscription to increase your limits.",
    duration_seconds: 0,
    num_turns: 1,
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  }));
  assert.equal(result.conversationId, "6d4c3cf0-test");
  assert.equal(result.numTurns, 1);
  assert.equal(classifyAgyOutput(result, { format: "json" })?.type, "QUOTA_EXAUSTED");
});

test("createAgyStreamParser handles chunked NDJSON, progress, tools, subagents, and result", () => {
  const progress = [];
  const parser = createAgyStreamParser({ onProgress: (line) => progress.push(line) });
  parser.push('{"event":"init","conversation_id":"conv-1","init":{}}\n');
  parser.push('{"event":"step_update","step_update":{"tool_info":{"name":"run_command","parameters":{"CommandLine":"echo ok"}}}}\n');
  parser.push('{"event":"step_update","step_update":{"subagent_info":{"conversation_id":"sub-1","log_uri":"file:///log"}}}\n');
  parser.push('{"event":"result","result":{"conversation_id":"conv-1","status":"SUCCESS","response":"O');
  parser.push('K","duration_seconds":1,"num_turns":1}}\n');
  const result = parser.end();
  assert.equal(result.response, "OK");
  assert.match(progress.join("\n"), /conversation conv-1/);
  assert.match(progress.join("\n"), /tool run_command/);
  assert.match(progress.join("\n"), /subagent sub-1/);
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

test("fallback catalog treats image generation as a tool rather than a nano-banana model", () => {
  assert.equal(FALLBACK_MODEL_CATALOG.some(({ slug }) => slug === "nano-banana"), false);
});

test("buildImagePrompt calls generate_image once and forbids repository investigation", () => {
  const prompt = buildImagePrompt({
    task: "a futuristic city at night",
    context: { included: [], skipped: [] },
  });
  assert.match(prompt, /generate_image tool exactly once/);
  assert.match(prompt, /a futuristic city at night/);
  assert.match(prompt, /Do not call grep_search/);
  assert.doesNotMatch(prompt, /write_to_file to the directory/);
});

test("buildImagePrompt renders task block and image-specific constraints", () => {
  const prompt = buildImagePrompt({
    task: "a red balloon",
    context: { included: [], skipped: [] },
  });
  assert.match(prompt, /<task>\s*a red balloon\s*<\/task>/);
  assert.match(prompt, /image generation assistant/);
  assert.match(prompt, /IMAGE_GENERATION_COMPLETE/);
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

test("parseCliArgs parses --prompt-file and sets taskFile", () => {
  const parsed = parseCliArgs(["--prompt-file", "package.json"]);
  assert.equal(parsed.promptFile, "package.json");
  assert.equal(parsed.taskFile, "package.json");
  assert.ok(parsed.task.includes("cc-antigravity-plugin"));
});

test("parseCliArgs parses --use-stdin flag", () => {
  const parsed = parseCliArgs(["--use-stdin", "task text"]);
  assert.equal(parsed.useStdin, true);
  assert.equal(parsed.task, "task text");
});

test("buildAntigravityArgs with useStdin omits --print prompt argument", () => {
  const args = buildAntigravityArgs({
    prompt: "long prompt to stream via stdin",
    useStdin: true,
  });
  assert.ok(!args.includes("--print"));
  assert.ok(!args.includes("long prompt to stream via stdin"));
  assert.ok(args.includes("--output-format"));
});

// ─── --design-system / prompt transport ──────────────────────────────────────

async function makeDesignPackage(root, { tokensBytes = 40_000 } = {}) {
  await fs.mkdir(path.join(root, "preview"), { recursive: true });
  await fs.mkdir(path.join(root, "system"), { recursive: true });
  await fs.writeFile(
    path.join(root, "tokens.css"),
    `:root{--accent:#1c69d4;}\n/*${"x".repeat(tokensBytes)}*/\n/* END-OF-TOKENS */\n`,
  );
  await fs.writeFile(path.join(root, "DESIGN.md"), "# Design\n");
  await fs.writeFile(path.join(root, "components.html"), "<button class=\"btn\">ok</button>\n");
  await fs.writeFile(path.join(root, "preview", "colors.html"), "<p>colors</p>\n");
  await fs.writeFile(path.join(root, "system", "kit.html"), "<p>kit</p>\n");
}

test("parseCliArgs collects --design-system entries", () => {
  const parsed = parseCliArgs([
    "--design-system", "packages/ui/design-systems/bmw,ds/acme",
    "--design-system", "ds/other",
    "task",
  ]);
  assert.deepEqual(parsed.designSystems, ["packages/ui/design-systems/bmw", "ds/acme", "ds/other"]);
});

test("collectDesignSystemContext inlines core files in full and lists the rest on demand", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "agy-ds-"));
  await makeDesignPackage(path.join(cwd, "packages", "ui", "design-systems", "acme"));

  const context = await collectDesignSystemContext({
    cwd,
    designSystems: ["packages/ui/design-systems/acme"],
  });

  const root = "packages/ui/design-systems/acme";
  assert.deepEqual(context.included.map((f) => f.path), [
    `${root}/DESIGN.md`,
    `${root}/tokens.css`,
    `${root}/components.html`,
  ]);
  const tokens = context.included.find((f) => f.path.endsWith("tokens.css"));
  assert.equal(tokens.truncated, false, "core files must bypass --max-file-bytes");
  assert.match(tokens.content, /END-OF-TOKENS/);
  assert.deepEqual(context.skipped, [
    { path: `${root}/preview/colors.html`, reason: "design-system-on-demand" },
    { path: `${root}/system/kit.html`, reason: "design-system-on-demand" },
  ]);
  assert.deepEqual(context.packages, [{
    id: "acme",
    root,
    coreFiles: context.included.map((f) => f.path),
    onDemandCount: 2,
  }]);
});

test("collectDesignSystemContext prefers the resolved/ package and names it after its parent", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "agy-ds-resolved-"));
  await makeDesignPackage(path.join(cwd, "bmw"), { tokensBytes: 10 });
  await fs.mkdir(path.join(cwd, "bmw", "resolved"), { recursive: true });
  await fs.writeFile(path.join(cwd, "bmw", "resolved", "design-contract.json"), "{}\n");

  const context = await collectDesignSystemContext({ cwd, designSystems: ["bmw"] });

  assert.equal(context.packages[0].id, "bmw");
  assert.equal(context.packages[0].root, "bmw/resolved");
  assert.deepEqual(context.included.map((f) => f.path), ["bmw/resolved/design-contract.json"]);
});

// The bridge is transport: it inlines the package files it is given and states their authority.
// Workflow policy of a specific producer (which stylesheet to import, which scaffolding classes to
// avoid, which run motivated a rule) belongs in the caller's task prompt, never in this block.
test("the design_system block carries no producer-specific workflow rule", () => {
  const block = buildDesignSystemBlock([{ id: "acme", root: "ds/acme", coreFiles: ["ds/acme/tokens.css"], onDemandCount: 1 }]);
  assert.doesNotMatch(block, /components\.css|\.grid|scaffolding|import .* stylesheet/i);
  assert.doesNotMatch(block, /OficinaAI|Pensador|Orquestrador|Orchestrador/i);
  assert.deepEqual([...DESIGN_SYSTEM_CORE_FILES], [
    "design-contract.json", "DESIGN.md", "tokens.css", "components.html", "USAGE.md", "components.manifest.json", "assets/manifest.json",
  ]);
});

test("the read-only prompt names no consumer project", () => {
  const prompt = buildAntigravityPrompt({ task: "Analyze", context: { included: [], skipped: [] }, readOnly: true });
  assert.doesNotMatch(prompt, /OficinaAI|Pensador|Orquestrador|Orchestrador/i);
});

test("collectDesignSystemContext rejects a directory that is not an Open Design package", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "agy-ds-invalid-"));
  await fs.mkdir(path.join(cwd, "src"));
  await assert.rejects(
    () => collectDesignSystemContext({ cwd, designSystems: ["src"] }),
    /not an Open Design package/,
  );
});

test("mergeDesignSystemContext puts design files first and removes duplicates from --dirs", () => {
  const design = {
    packages: [{ id: "acme", root: "ds", coreFiles: ["ds/tokens.css"], onDemandCount: 1 }],
    included: [{ path: "ds/tokens.css", mediaType: "text/plain", bytes: 1, truncated: false, content: "a" }],
    skipped: [{ path: "ds/preview/colors.html", reason: "design-system-on-demand" }],
  };
  const general = {
    included: [
      { path: "ds/tokens.css", mediaType: "text/plain", bytes: 1, truncated: true, content: "a" },
      { path: "src/app.tsx", mediaType: "text/plain", bytes: 1, truncated: false, content: "b" },
    ],
    skipped: [{ path: "ds/preview/colors.html", reason: "max-files-exceeded" }],
  };

  const merged = mergeDesignSystemContext(design, general);

  assert.deepEqual(merged.included.map((f) => f.path), ["ds/tokens.css", "src/app.tsx"]);
  assert.equal(merged.included[0].truncated, false);
  assert.deepEqual(merged.skipped, [{ path: "ds/preview/colors.html", reason: "design-system-on-demand" }]);
  assert.equal(merged.designSystems, design.packages);
});

test("resolvePromptTransport streams large headless prompts over stdin on every platform", () => {
  assert.equal(resolvePromptTransport({ promptLength: 8_000, platform: "win32" }), "argv");
  assert.equal(resolvePromptTransport({ promptLength: 8_192, platform: "win32" }), "stdin");
  assert.equal(resolvePromptTransport({ promptLength: 90_000, platform: "linux" }), "argv");
  assert.equal(resolvePromptTransport({ promptLength: 100_001, platform: "linux" }), "stdin");
  assert.equal(resolvePromptTransport({ promptLength: 10, platform: "linux", forceStdin: true }), "stdin");
  assert.equal(
    resolvePromptTransport({ promptLength: 500_000, platform: "win32", interactive: true, forceStdin: true }),
    "argv",
    "--interactive has no stdin channel for the prompt",
  );
});

test("fitContextToPromptBudget drops the lowest-priority files first, one at a time", () => {
  const file = (name, size) => ({
    path: name, mediaType: "text/plain", bytes: size, truncated: false, content: "x".repeat(size),
  });
  const context = { included: [file("ds/tokens.css", 10), file("a.txt", 50), file("z.txt", 50)], skipped: [] };
  const buildPrompt = (ctx) => ctx.included.map((f) => f.content).join("");

  const fitted = fitContextToPromptBudget({ context, buildPrompt, limit: 70 });

  assert.equal(fitted.droppedFiles, 1);
  assert.deepEqual(fitted.context.included.map((f) => f.path), ["ds/tokens.css", "a.txt"]);
  assert.deepEqual(fitted.context.skipped, [{ path: "z.txt", reason: "prompt-overflow-windows" }]);
  assert.equal(fitted.prompt.length, 60);
});

test("buildAntigravityPrompt adds the design_system block only when packages are present", () => {
  const base = { task: "build the page", context: { included: [], skipped: [] } };
  assert.doesNotMatch(buildAntigravityPrompt(base), /<design_system/);

  const prompt = buildAntigravityPrompt({
    ...base,
    context: {
      included: [],
      skipped: [],
      designSystems: [{
        id: "bmw",
        root: "packages/ui/design-systems/bmw",
        coreFiles: ["packages/ui/design-systems/bmw/tokens.css"],
        onDemandCount: 3,
      }],
    },
  });

  assert.match(prompt, /<design_system id="bmw" root="packages\/ui\/design-systems\/bmw">/);
  assert.match(prompt, /not the product being built/);
  assert.ok(prompt.indexOf("<design_system") < prompt.indexOf("<task>"));
});

