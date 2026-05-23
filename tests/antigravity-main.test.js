import test from "node:test";
import assert from "node:assert/strict";

import { main } from "../scripts/antigravity-bridge.js";

// Creates injectable stdout/stderr streams so tests never patch process globals.
function makeStreams() {
  const outChunks = [];
  const errChunks = [];
  return {
    _stdout: { write: (s) => { outChunks.push(String(s)); return true; } },
    _stderr: { write: (s) => { errChunks.push(String(s)); return true; } },
    get stdout() { return outChunks.join(""); },
    get stderr() { return errChunks.join(""); },
  };
}

// Minimal fake PTY module.
// Uses "exitCode" in opts so that passing exitCode: undefined is preserved (not defaulted).
function fakePtyModule(opts = {}) {
  const exitCode = "exitCode" in opts ? opts.exitCode : 0;
  const { data = "", delayMs = 0, neverExit = false } = opts;
  return {
    spawn: (_exe, _args, _opts) => {
      const dataHandlers = [];
      const exitHandlers = [];
      const term = {
        onData: (fn) => { dataHandlers.push(fn); },
        onExit: (fn) => { exitHandlers.push(fn); },
        kill: () => {},
      };
      if (!neverExit) {
        setTimeout(() => {
          if (data) dataHandlers.forEach((fn) => fn(data));
          exitHandlers.forEach((fn) => fn({ exitCode }));
        }, delayMs);
      }
      return term;
    },
  };
}

// ─── --help ───────────────────────────────────────────────────────────────────

test("main --help prints usage and returns 0", async () => {
  const io = makeStreams();
  const result = await main(["--help"], io);
  assert.equal(result, 0);
  assert.match(io.stdout, /Usage:/);
});

test("main -h prints usage and returns 0", async () => {
  const io = makeStreams();
  const result = await main(["-h"], io);
  assert.equal(result, 0);
  assert.match(io.stdout, /Usage:/);
});

// ─── missing task ─────────────────────────────────────────────────────────────

test("main with no task writes error to stderr and returns 1", async () => {
  const io = makeStreams();
  const result = await main([], io);
  assert.equal(result, 1);
  assert.match(io.stderr, /task is required/i);
});

// ─── --print-command ──────────────────────────────────────────────────────────

test("main --print-command prints agy command and returns 0", async () => {
  const io = makeStreams();
  const result = await main(["--print-command", "analyze this"], io);
  assert.equal(result, 0);
  assert.match(io.stdout, /agy/);
  assert.match(io.stdout, /--print/);
});

// ─── spawnSync fallback ───────────────────────────────────────────────────────

test("main spawnSync fallback: ENOENT writes install message and returns 1", async () => {
  const io = makeStreams();
  const fakeSpawn = () => ({
    error: Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }),
    status: null,
  });
  const result = await main(["analyze this"], {
    ...io,
    _spawnSync: fakeSpawn,
    _loadNodePty: () => null,
  });
  assert.equal(result, 1);
  assert.match(io.stderr, /not installed/i);
});

test("main spawnSync fallback: non-ENOENT error is surfaced and returns 1", async () => {
  const io = makeStreams();
  const accessErr = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
  const result = await main(["analyze this"], {
    ...io,
    _spawnSync: () => ({ error: accessErr, status: null }),
    _loadNodePty: () => null,
  });
  assert.equal(result, 1);
  assert.match(io.stderr, /EACCES/);
});

test("main spawnSync fallback: propagates exit code 0 from agy", async () => {
  const io = makeStreams();
  const result = await main(["analyze this"], {
    ...io,
    _spawnSync: () => ({ error: null, status: 0 }),
    _loadNodePty: () => null,
  });
  assert.equal(result, 0);
});

test("main spawnSync fallback: propagates non-zero exit code from agy", async () => {
  const io = makeStreams();
  const result = await main(["analyze this"], {
    ...io,
    _spawnSync: () => ({ error: null, status: 2 }),
    _loadNodePty: () => null,
  });
  assert.equal(result, 2);
});

// ─── ConPTY path ──────────────────────────────────────────────────────────────

test("main ConPTY: exitCode 0 resolves to 0 and writes output to stdout", async () => {
  const io = makeStreams();
  const result = await main(["analyze this"], {
    ...io,
    _loadNodePty: () => fakePtyModule({ exitCode: 0, data: "analysis result\n" }),
    _conPtyTimeoutMs: 5_000,
  });
  assert.equal(result, 0);
  assert.match(io.stdout, /analysis result/);
});

test("main ConPTY: undefined exitCode resolves to 1 (signal-killed)", async () => {
  const io = makeStreams();
  const result = await main(["analyze this"], {
    ...io,
    _loadNodePty: () => fakePtyModule({ exitCode: undefined }),
    _conPtyTimeoutMs: 5_000,
  });
  assert.equal(result, 1);
});

test("main ConPTY: timeout rejects, writes timeout message to stderr, returns 1", async () => {
  const io = makeStreams();
  const result = await main(["analyze this"], {
    ...io,
    _loadNodePty: () => fakePtyModule({ neverExit: true }),
    _conPtyTimeoutMs: 50,
  });
  assert.equal(result, 1);
  assert.match(io.stderr, /did not respond/i);
});
