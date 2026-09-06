import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  main,
  FALLBACK_MODEL_CATALOG,
  EXIT_SUCCESS,
  EXIT_QUOTA_EXAUSTED,
  EXIT_AUTH_REQUIRED,
  EXIT_TIMEOUT,
  EXIT_AGY_MISSING,
  EXIT_ERROR,
} from "../scripts/antigravity-bridge.js";

function makeStreams() {
  const outChunks = [];
  const errChunks = [];
  return {
    _stdout: { write: (value) => { outChunks.push(String(value)); return true; } },
    _stderr: { write: (value) => { errChunks.push(String(value)); return true; } },
    get stdout() { return outChunks.join(""); },
    get stderr() { return errChunks.join(""); },
  };
}

function fakeSpawnSync(calls = []) {
  return (command, args = []) => {
    calls.push({ command, args });
    if (command === "where" || command === "which") return { status: 0, stdout: "agy\n" };
    if (args[0] === "--version") return { status: 0, stdout: "1.1.16\n" };
    return { status: 0, stdout: "" };
  };
}

function fakeAsyncSpawn({ stdout = "", stderr = "", exitCode = 0, neverClose = false, error } = {}, calls = []) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => { child.killed = true; };
    queueMicrotask(() => {
      if (error) {
        child.emit("error", error);
        return;
      }
      if (stdout) child.stdout.write(stdout);
      if (stderr) child.stderr.write(stderr);
      child.stdout.end();
      child.stderr.end();
      if (!neverClose) child.emit("close", exitCode);
    });
    return child;
  };
}

function fakePty({ data = "", exitCode = 0 } = {}) {
  return {
    spawn: () => {
      const dataHandlers = [];
      const exitHandlers = [];
      const term = {
        onData: (handler) => dataHandlers.push(handler),
        onExit: (handler) => exitHandlers.push(handler),
        kill: () => {},
      };
      queueMicrotask(() => {
        if (data) dataHandlers.forEach((handler) => handler(data));
        exitHandlers.forEach((handler) => handler({ exitCode }));
      });
      return term;
    },
  };
}

function successEnvelope(response = "done\n") {
  return JSON.stringify({
    conversation_id: "conv-success",
    status: "SUCCESS",
    response,
    duration_seconds: 1,
    num_turns: 1,
    usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
  });
}

async function runMain(args, { spawnResult, asyncCalls = [], syncCalls = [], ...overrides } = {}) {
  const io = makeStreams();
  const exitCode = await main(args, {
    ...io,
    _spawn: fakeAsyncSpawn(spawnResult ?? { stdout: successEnvelope() }, asyncCalls),
    _spawnSync: fakeSpawnSync(syncCalls),
    _resolveModelCatalog: async () => FALLBACK_MODEL_CATALOG,
    _loadNodePty: () => null,
    _conPtyTimeoutMs: 100,
    ...overrides,
  });
  return { exitCode, io, asyncCalls, syncCalls };
}

test("main --help prints usage without spawning AGY", async () => {
  const asyncCalls = [];
  const { exitCode, io } = await runMain(["--help"], { asyncCalls });
  assert.equal(exitCode, EXIT_SUCCESS);
  assert.match(io.stdout, /Usage:/);
  assert.equal(asyncCalls.length, 0);
});

test("main --print-command defaults headless output to JSON and disables slash commands", async () => {
  const { exitCode, io } = await runMain(["--print-command", "analyze this"]);
  assert.equal(exitCode, EXIT_SUCCESS);
  assert.match(io.stdout, /--output-format" "json/);
  assert.match(io.stdout, /--disable-slash-commands/);
  assert.doesNotMatch(io.stdout, /--model/);
});

test("main --print-command resolves model aliases and forwards modern flags", async () => {
  const { io } = await runMain([
    "--print-command",
    "--model", "gemini 3.7 flash",
    "--effort", "high",
    "--agent", "code-reviewer",
    "--json-schema", "schema.json",
    "review",
  ]);
  assert.match(io.stdout, /--model" "gemini-3\.7-flash-high/);
  assert.match(io.stdout, /--effort" "high/);
  assert.match(io.stdout, /--agent" "code-reviewer/);
  assert.match(io.stdout, /--json-schema" "schema\.json/);
});

test("main --dump-prompt writes the effective prompt and an undegraded audit sidecar", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-dump-"));
  const dumpPath = path.join(tempDir, "prompt.txt");

  const { exitCode } = await runMain([
    "--print-command",
    "--dump-prompt", dumpPath,
    "analyze this",
  ]);

  assert.equal(exitCode, EXIT_SUCCESS);
  const written = await fs.readFile(dumpPath, "utf8");
  assert.match(written, /analyze this/);

  const audit = JSON.parse(await fs.readFile(`${dumpPath}.audit.json`, "utf8"));
  assert.equal(audit.degraded, false);
  assert.equal(audit.droppedFiles, 0);
  assert.equal(audit.limit, 28_000);
  assert.equal(audit.promptChars, written.length);
  assert.deepEqual(audit.included, []);
  assert.deepEqual(audit.skipped, []);
});

test("main --dump-prompt reports stderr pointer to the audit sidecar", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-dump-stderr-"));
  const dumpPath = path.join(tempDir, "prompt.txt");

  const { io } = await runMain(["--print-command", "--dump-prompt", dumpPath, "analyze this"]);

  assert.match(io.stderr, /BRIDGE_CONTEXT_REPORT: /);
  assert.ok(io.stderr.includes(`${dumpPath}.audit.json`));
});

test("main --dump-prompt marks context as degraded when the Windows prompt-overflow fallback drops files", async (t) => {
  const originalPlatform = process.platform;
  Object.defineProperty(process, "platform", { value: "win32" });
  t.after(() => Object.defineProperty(process, "platform", { value: originalPlatform }));

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-dump-degraded-"));
  const bigFile = path.join(tempDir, "big.txt");
  await fs.writeFile(bigFile, "x".repeat(30_000));
  const dumpPath = path.join(tempDir, "prompt.txt");

  const { exitCode } = await runMain([
    "--print-command",
    "--dump-prompt", dumpPath,
    "--dirs", tempDir,
    "analyze this",
  ]);

  assert.equal(exitCode, EXIT_SUCCESS);
  const audit = JSON.parse(await fs.readFile(`${dumpPath}.audit.json`, "utf8"));
  assert.equal(audit.degraded, true);
  assert.equal(audit.droppedFiles, 1);
  assert.deepEqual(audit.included, []);
  assert.ok(
    audit.skipped.some((entry) => entry.reason === "prompt-overflow-windows"),
    "dropped file must be recorded with the overflow reason",
  );
});

test("main --read-only emits --mode plan and never skip-permissions", async () => {
  const { io } = await runMain(["--read-only", "--print-command", "analyze"]);
  assert.match(io.stdout, /--mode" "plan/);
  assert.doesNotMatch(io.stdout, /dangerously-skip-permissions/);
  assert.doesNotMatch(io.stdout, /disable-slash-commands/, "AGY 1.1.16 otherwise ignores plan mode");
});

test("main headless JSON uses async spawn and prints only the final response", async () => {
  const asyncCalls = [];
  const { exitCode, io } = await runMain(["analyze"], { asyncCalls });
  assert.equal(exitCode, EXIT_SUCCESS);
  assert.equal(io.stdout, "done\n");
  assert.equal(asyncCalls.length, 1);
  assert.ok(asyncCalls[0].args.includes("--print"));
  assert.ok(asyncCalls[0].args.includes("--output-format"));
});

test("main --agent selects a named headless agent and does not require PTY", async () => {
  const asyncCalls = [];
  const { exitCode } = await runMain(["--agent", "code-reviewer", "review"], { asyncCalls });
  assert.equal(exitCode, EXIT_SUCCESS);
  assert.ok(asyncCalls[0].args.includes("code-reviewer"));
  assert.ok(!asyncCalls[0].args.includes("--prompt-interactive"));
});

test("main --interactive is the only path that requires and uses PTY", async () => {
  const io = makeStreams();
  const exitCode = await main(["--interactive", "chat"], {
    ...io,
    _spawn: () => { throw new Error("headless spawn must not run"); },
    _spawnSync: fakeSpawnSync(),
    _resolveModelCatalog: async () => FALLBACK_MODEL_CATALOG,
    _loadNodePty: () => fakePty({ data: "interactive result\n" }),
    _isTTY: true,
    _conPtyTimeoutMs: 100,
  });
  assert.equal(exitCode, EXIT_SUCCESS);
  assert.match(io.stdout, /interactive result/);
});

test("main --interactive fails clearly when PTY support is unavailable", async () => {
  const { exitCode, io } = await runMain(["--interactive", "chat"]);
  assert.equal(exitCode, EXIT_ERROR);
  assert.match(io.stderr, /PTY support/);
});

test("main classifies the real JSON quota envelope and carries conversation and usage", async () => {
  const quota = JSON.stringify({
    conversation_id: "quota-conv",
    status: "ERROR",
    response: "",
    error: "Individual quota reached. Please upgrade your subscription to increase your limits.",
    duration_seconds: 0,
    num_turns: 1,
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  });
  const { exitCode, io } = await runMain(["task"], {
    spawnResult: { stdout: quota, exitCode: 1 },
  });
  assert.equal(exitCode, EXIT_QUOTA_EXAUSTED);
  const signal = JSON.parse(io.stdout.trim());
  assert.equal(signal.conversation_id, "quota-conv");
  assert.equal(signal.retry, "--conversation quota-conv");
  assert.deepEqual(signal.usage, { input_tokens: 0, output_tokens: 0, total_tokens: 0 });
});

test("main classifies structured authentication failures", async () => {
  const auth = JSON.stringify({
    conversation_id: "",
    status: "ERROR",
    response: "",
    error: "Not authenticated. Please sign in.",
    duration_seconds: 0,
    num_turns: 0,
  });
  const { exitCode, io } = await runMain(["task"], {
    spawnResult: { stdout: auth, exitCode: 1 },
  });
  assert.equal(exitCode, EXIT_AUTH_REQUIRED);
  assert.match(io.stdout, /AUTH_REQUIRED/);
});

test("main text format retains regex classification fallback", async () => {
  const { exitCode, io } = await runMain(["--format", "text", "task"], {
    spawnResult: { stdout: "Individual quota reached", exitCode: 1 },
  });
  assert.equal(exitCode, EXIT_QUOTA_EXAUSTED);
  assert.match(io.stdout, /QUOTA_EXAUSTED/);
});

test("main stream-json renders progress on stderr and final response on stdout", async () => {
  const ndjson = [
    JSON.stringify({ event: "init", conversation_id: "conv-stream", init: {} }),
    JSON.stringify({ event: "step_update", step_update: { tool_info: { name: "run_command", parameters: { CommandLine: "echo ok" } } } }),
    JSON.stringify({ event: "step_update", step_update: { subagent_info: { conversation_id: "sub-1", log_uri: "file:///log" } } }),
    JSON.stringify({ event: "result", result: { conversation_id: "conv-stream", status: "SUCCESS", response: "stream done", duration_seconds: 1, num_turns: 1 } }),
  ].join("\n") + "\n";
  const { exitCode, io } = await runMain(["--format", "stream-json", "--parallel", "task"], {
    spawnResult: { stdout: ndjson, exitCode: 0 },
  });
  assert.equal(exitCode, EXIT_SUCCESS);
  assert.equal(io.stdout, "stream done\n");
  assert.match(io.stderr, /tool run_command/);
  assert.match(io.stderr, /subagent sub-1/);
});

test("main --output-file writes the parsed response and prints its resolved path", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-output-"));
  const outputFile = path.join(tempDir, "result.txt");
  const { exitCode, io } = await runMain(["--output-file", outputFile, "task"]);
  assert.equal(exitCode, EXIT_SUCCESS);
  assert.equal(io.stdout.trim(), outputFile);
  assert.equal(await fs.readFile(outputFile, "utf8"), "done\n");
});

test("main warns and omits an unknown model instead of sending it to AGY", async () => {
  const asyncCalls = [];
  const { exitCode, io } = await runMain(["--model", "not-a-real-model", "task"], { asyncCalls });
  assert.equal(exitCode, EXIT_SUCCESS);
  assert.match(io.stderr, /Valid models:/);
  assert.ok(!asyncCalls[0].args.includes("not-a-real-model"));
});

test("main --generate-image never selects nano-banana as a model", async () => {
  const { io } = await runMain(["--generate-image", "--print-command", "a sunset"]);
  assert.doesNotMatch(io.stdout, /nano-banana/);
  assert.match(io.stdout, /generate_imagem/);
});

test("main converts async spawn ENOENT into EXIT_AGY_MISSING", async () => {
  const error = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
  const { exitCode, io } = await runMain(["task"], { spawnResult: { error } });
  assert.equal(exitCode, EXIT_AGY_MISSING);
  assert.match(io.stderr, /not installed/);
});

test("main headless silence timeout returns EXIT_TIMEOUT", async () => {
  const { exitCode, io } = await runMain(["task"], {
    spawnResult: { neverClose: true },
    _conPtyTimeoutMs: 20,
  });
  assert.equal(exitCode, EXIT_TIMEOUT);
  assert.match(io.stderr, /did not respond/);
});

/* -------------------------------------------------------------------------- */
/* Achado 7/8: resposta vazia com exit de sucesso e evento terminal bridge.exit */
/* -------------------------------------------------------------------------- */

test("an empty response with --output-file and exit 0, resolved well within timeout, is EXIT_ERROR not silent success", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-empty-"));
  const outputFile = path.join(tempDir, "result.txt");
  // stream-json com so o evento "init" — sem "result" — deixa response vazia.
  const ndjson = JSON.stringify({ event: "init", conversation_id: "conv-empty", init: {} }) + "\n";
  const { exitCode, io } = await runMain(
    ["--format", "stream-json", "--output-file", outputFile, "task"],
    { spawnResult: { stdout: ndjson, exitCode: 0 }, _conPtyTimeoutMs: 10_000 },
  );
  assert.equal(exitCode, EXIT_ERROR);
  assert.match(io.stdout, /"status":"EMPTY_RESPONSE"/);
  assert.equal(await fs.readFile(outputFile, "utf8").catch(() => null), null, "empty-response is terminal, never writes the 0-byte file");
});

test("an empty response very close to the effective timeout is EXIT_TIMEOUT, not EXIT_ERROR", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-empty-timeout-"));
  const outputFile = path.join(tempDir, "result.txt");
  const ndjson = JSON.stringify({ event: "init", conversation_id: "conv-empty", init: {} }) + "\n";
  // Timeout efetivo de 0ms: 0.8 * 0 = 0, e elapsedMs >= 0 e sempre verdadeiro —
  // determinístico sem depender de relogio real. spawnHeadless ainda resolve
  // via o "close" fake (microtask) antes do proprio setTimeout(0) de silencio
  // disparar, entao o teste exercita a classificacao EMPTY_RESPONSE, nao o
  // timeout real de spawnHeadless.
  const { exitCode, io } = await runMain(
    ["--format", "stream-json", "--output-file", outputFile, "task"],
    { spawnResult: { stdout: ndjson, exitCode: 0 }, _conPtyTimeoutMs: 0 },
  );
  assert.equal(exitCode, EXIT_TIMEOUT);
  assert.match(io.stdout, /"status":"EMPTY_RESPONSE"/);
});

test("main logs exactly one terminal bridge.exit event per invocation, with duration and exit code", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-bridge-exit-"));
  const logPath = path.join(dir, "plugin-test.jsonl");
  const previousEnv = process.env.CC_ANTIGRAVITY_LOG_PATH;
  process.env.CC_ANTIGRAVITY_LOG_PATH = logPath;
  try {
    const { exitCode } = await runMain(["task"]);
    assert.equal(exitCode, EXIT_SUCCESS);
    const lines = (await fs.readFile(logPath, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    const exitEvents = lines.filter((l) => l.event === "bridge.exit");
    assert.equal(exitEvents.length, 1, "exactly one bridge.exit per main() call");
    assert.equal(exitEvents[0].exitCode, EXIT_SUCCESS);
    assert.equal(typeof exitEvents[0].durationMs, "number");
    assert.ok(exitEvents[0].durationMs >= 0);
  } finally {
    if (previousEnv === undefined) delete process.env.CC_ANTIGRAVITY_LOG_PATH;
    else process.env.CC_ANTIGRAVITY_LOG_PATH = previousEnv;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("bridge.exit fires on the classification path too, with the classified type recorded", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-bridge-exit-classified-"));
  const logPath = path.join(dir, "plugin-test.jsonl");
  const previousEnv = process.env.CC_ANTIGRAVITY_LOG_PATH;
  process.env.CC_ANTIGRAVITY_LOG_PATH = logPath;
  try {
    const { exitCode } = await runMain(["task"], {
      spawnResult: { stdout: "", stderr: "429 too many requests", exitCode: 1 },
    });
    assert.equal(exitCode, EXIT_QUOTA_EXAUSTED);
    const lines = (await fs.readFile(logPath, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    const exitEvents = lines.filter((l) => l.event === "bridge.exit");
    assert.equal(exitEvents.length, 1);
    assert.equal(exitEvents[0].exitCode, EXIT_QUOTA_EXAUSTED);
    assert.equal(exitEvents[0].classified, "QUOTA_EXAUSTED");
  } finally {
    if (previousEnv === undefined) delete process.env.CC_ANTIGRAVITY_LOG_PATH;
    else process.env.CC_ANTIGRAVITY_LOG_PATH = previousEnv;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
