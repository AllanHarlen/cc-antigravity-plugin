import test from "node:test";
import assert from "node:assert/strict";

import {
  main,
  EXIT_SUCCESS,
  EXIT_QUOTA_EXAUSTED,
  EXIT_AUTH_REQUIRED,
  EXIT_TIMEOUT,
  EXIT_AGY_MISSING,
  EXIT_ERROR,
} from "../scripts/antigravity-bridge.js";

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
        write: () => {},
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

function fakeSpawnSuccess(calls = []) {
  return (cmd, args = []) => {
    calls.push({ cmd, args });
    if (cmd === "where" || cmd === "which") {
      return { status: 0, stdout: "agy\n" };
    }
    return { error: null, status: 0 };
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

test("main with no task writes error to stderr and returns EXIT_ERROR", async () => {
  const io = makeStreams();
  const result = await main([], io);
  assert.equal(result, EXIT_ERROR);
  assert.match(io.stderr, /task is required/i);
});

// ─── --print-command ──────────────────────────────────────────────────────────

test("main --print-command prints agy command and returns 0", async () => {
  const io = makeStreams();
  const result = await main(["--print-command", "analyze this"], io);
  assert.equal(result, 0);
  assert.match(io.stdout, /--print/);
});

// ─── spawnSync fallback ───────────────────────────────────────────────────────

test("main spawnSync fallback: ENOENT writes install message and returns EXIT_AGY_MISSING", async () => {
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
  assert.equal(result, EXIT_AGY_MISSING);
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
  const calls = [];
  const result = await main(["analyze this"], {
    ...io,
    _spawnSync: fakeSpawnSuccess(calls),
    _loadNodePty: () => null,
  });
  assert.equal(result, 0);
  // calls[0]=where/which, calls[1]=--version (connectivity), calls[2]=actual task
  const taskArgs = calls[2]?.args ?? [];
  assert.ok(taskArgs.includes("--print"), "agy call must include --print");
  assert.ok(taskArgs.includes("--dangerously-skip-permissions"), "agy call must include skip-permissions by default");
  assert.ok(taskArgs.includes("--add-dir"), "agy call must include --add-dir (cwd auto-added)");
});

test("main spawnSync fallback: propagates non-zero exit code from agy", async () => {
  const io = makeStreams();
  let agyCallCount = 0;
  const result = await main(["analyze this"], {
    ...io,
    _spawnSync: (cmd) => {
      if (cmd === "where" || cmd === "which") {
        return { status: 0, stdout: "agy\n" };
      }
      agyCallCount += 1;
      // calls: 1=--version (connectivity), 2=actual task
      return { error: null, status: agyCallCount <= 1 ? 0 : 2 };

    },
    _loadNodePty: () => null,
  });
  assert.equal(result, 2);
});

// ─── ConPTY path ──────────────────────────────────────────────────────────────

test("main ConPTY: exitCode 0 resolves to 0 and writes output to stdout", async () => {
  const io = makeStreams();
  const calls = [];
  const result = await main(["analyze this"], {
    ...io,
    _spawnSync: fakeSpawnSuccess(calls),
    _loadNodePty: () => fakePtyModule({ exitCode: 0, data: "analysis result\n" }),
    _conPtyTimeoutMs: 5_000,
  });
  assert.equal(result, 0);
  // calls[0]=where, calls[1]=--version (connectivity); PTY handles the actual task
  assert.equal(calls[0]?.cmd === "where" || calls[0]?.cmd === "which", true);

  assert.match(io.stdout, /analysis result/);
});

test("main ConPTY: undefined exitCode resolves to 1 (signal-killed)", async () => {
  const io = makeStreams();
  const result = await main(["analyze this"], {
    ...io,
    _spawnSync: fakeSpawnSuccess(),
    _loadNodePty: () => fakePtyModule({ exitCode: undefined }),
    _conPtyTimeoutMs: 5_000,
  });
  assert.equal(result, 1);
});

test("main ConPTY: timeout returns EXIT_TIMEOUT and writes message to stderr", async () => {
  const io = makeStreams();
  const result = await main(["analyze this"], {
    ...io,
    _spawnSync: fakeSpawnSuccess(),
    _loadNodePty: () => fakePtyModule({ neverExit: true }),
    _conPtyTimeoutMs: 50,
  });
  assert.equal(result, EXIT_TIMEOUT);
  assert.match(io.stderr, /did not respond/i);
});

// ─── --agent / --interactive guards ──────────────────────────────────────────

test("main --agent without PTY support fails with clear error", async () => {
  const io = makeStreams();
  const result = await main(["--agent", "do something"], {
    ...io,
    _spawnSync: fakeSpawnSuccess(),
    _loadNodePty: () => null,
  });
  assert.equal(result, 1);
  assert.match(io.stderr, /PTY support/i);
});

test("main --agent with PTY but no TTY warns and continues", async () => {
  const io = makeStreams();
  const result = await main(["--agent", "do something"], {
    ...io,
    _spawnSync: fakeSpawnSuccess(),
    _loadNodePty: () => fakePtyModule({ exitCode: 0, data: "done\n" }),
    _isTTY: false,
    _conPtyTimeoutMs: 5_000,
  });
  assert.match(io.stderr, /no TTY/i);
  assert.equal(result, 0);
});

test("main --agent with PTY and TTY does not warn", async () => {
  const io = makeStreams();
  const result = await main(["--agent", "do something"], {
    ...io,
    _spawnSync: fakeSpawnSuccess(),
    _loadNodePty: () => fakePtyModule({ exitCode: 0 }),
    _isTTY: true,
    _conPtyTimeoutMs: 5_000,
  });
  assert.doesNotMatch(io.stderr, /no TTY/i);
  assert.equal(result, 0);
});

// ─── error surfacing ──────────────────────────────────────────────────────────

test("main error output includes plugin log path", async () => {
  const io = makeStreams();
  await main(["trigger error"], {
    ...io,
    _spawnSync: () => ({ error: Object.assign(new Error("ENOENT"), { code: "ENOENT" }), status: null }),
    _loadNodePty: () => null,
  });
  assert.match(io.stderr, /Plugin log:/i);
});

// ─── QUOTA_EXAUSTED detection via PTY output ──────────────────────────────────

test("main ConPTY: quota output returns EXIT_QUOTA_EXAUSTED and emits JSON signal", async () => {
  const io = makeStreams();
  const result = await main(["analyze this"], {
    ...io,
    _spawnSync: fakeSpawnSuccess(),
    _loadNodePty: () => fakePtyModule({ exitCode: 1, data: "Error: rate limit exceeded. Retry after 60s.\n" }),
    _conPtyTimeoutMs: 5_000,
  });
  assert.equal(result, EXIT_QUOTA_EXAUSTED);
  // stdout should contain the structured JSON signal
  assert.match(io.stdout, /QUOTA_EXAUSTED/);
});

test("main ConPTY: auth output returns EXIT_AUTH_REQUIRED and emits JSON signal", async () => {
  const io = makeStreams();
  const result = await main(["analyze this"], {
    ...io,
    _spawnSync: fakeSpawnSuccess(),
    _loadNodePty: () => fakePtyModule({ exitCode: 1, data: "Error: not authenticated. Please sign in.\n" }),
    _conPtyTimeoutMs: 5_000,
  });
  assert.equal(result, EXIT_AUTH_REQUIRED);
  assert.match(io.stdout, /AUTH_REQUIRED/);
});

// ─── agentic defaults ─────────────────────────────────────────────────────────

test("main --read-only does not include --dangerously-skip-permissions in agy args", async () => {
  const io = makeStreams();
  const result = await main(["--read-only", "--print-command", "analyze this"], io);
  assert.equal(result, EXIT_SUCCESS);
  assert.ok(!io.stdout.includes("--dangerously-skip-permissions"));
});

test("main default agentic mode includes --dangerously-skip-permissions in agy args", async () => {
  const io = makeStreams();
  const result = await main(["--print-command", "analyze this"], io);
  assert.equal(result, EXIT_SUCCESS);
  assert.match(io.stdout, /--dangerously-skip-permissions/);
  assert.match(io.stdout, /--add-dir/);
});
