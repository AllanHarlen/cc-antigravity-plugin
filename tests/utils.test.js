import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { logEvent, resolveDefaultLogPath } from "../scripts/utils.js";

test("resolveDefaultLogPath returns a path under a cc-plugin-logs directory named for today", () => {
  const logPath = resolveDefaultLogPath();
  const today = new Date().toISOString().slice(0, 10);
  assert.ok(logPath.includes("cc-plugin-logs"));
  assert.ok(logPath.endsWith(`plugin-${today}.jsonl`));
});

test("logEvent appends a JSON line with timestamp, pid, and event fields", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-utils-test-"));
  const logPath = path.join(dir, "plugin-test.jsonl");
  const previousEnv = process.env.CC_ANTIGRAVITY_LOG_PATH;
  process.env.CC_ANTIGRAVITY_LOG_PATH = logPath;
  try {
    logEvent("test.event", { foo: "bar" });
    const contents = fs.readFileSync(logPath, "utf8").trim();
    const line = JSON.parse(contents);
    assert.equal(line.event, "test.event");
    assert.equal(line.foo, "bar");
    assert.equal(typeof line.pid, "number");
    assert.ok(new Date(line.timestamp).toString() !== "Invalid Date");
  } finally {
    if (previousEnv === undefined) delete process.env.CC_ANTIGRAVITY_LOG_PATH;
    else process.env.CC_ANTIGRAVITY_LOG_PATH = previousEnv;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("logEvent never throws even when the log path is unwritable", () => {
  const previousEnv = process.env.CC_ANTIGRAVITY_LOG_PATH;
  // A path with a null byte is invalid on every platform and cannot be created.
  process.env.CC_ANTIGRAVITY_LOG_PATH = path.join(os.tmpdir(), "agy-utils-test-\0invalid", "plugin.jsonl");
  try {
    assert.doesNotThrow(() => logEvent("test.unwritable", {}));
  } finally {
    if (previousEnv === undefined) delete process.env.CC_ANTIGRAVITY_LOG_PATH;
    else process.env.CC_ANTIGRAVITY_LOG_PATH = previousEnv;
  }
});

test("logEvent prunes log files older than the retention window", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-utils-retention-"));
  const oldFile = path.join(dir, "plugin-2020-01-01.jsonl");
  fs.writeFileSync(oldFile, "{}\n");
  const oldMs = Date.now() - 30 * 24 * 60 * 60 * 1000;
  fs.utimesSync(oldFile, oldMs / 1000, oldMs / 1000);

  const logPath = path.join(dir, "plugin-today.jsonl");
  const previousEnv = process.env.CC_ANTIGRAVITY_LOG_PATH;
  process.env.CC_ANTIGRAVITY_LOG_PATH = logPath;
  try {
    logEvent("test.retention", {});
    assert.equal(fs.existsSync(oldFile), false, "log file older than the retention window should be pruned");
    assert.equal(fs.existsSync(logPath), true);
  } finally {
    if (previousEnv === undefined) delete process.env.CC_ANTIGRAVITY_LOG_PATH;
    else process.env.CC_ANTIGRAVITY_LOG_PATH = previousEnv;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
