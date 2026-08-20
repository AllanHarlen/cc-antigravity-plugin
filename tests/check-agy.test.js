import test from "node:test";
import assert from "node:assert/strict";

import { checkAgy, compareVersions, MIN_AGY_VERSION } from "../scripts/check-agy.js";

function makeStderr() {
  const chunks = [];
  return {
    stream: { write: (value) => { chunks.push(String(value)); return true; } },
    get value() { return chunks.join(""); },
  };
}

test("compareVersions compares semantic version components numerically", () => {
  assert.ok(compareVersions("1.1.16", "1.1.8") > 0);
  assert.equal(compareVersions("agy 1.1.8", MIN_AGY_VERSION), 0);
  assert.ok(compareVersions("1.0.15", MIN_AGY_VERSION) < 0);
});

test("checkAgy warns but does not fail when the installed CLI is too old", () => {
  const stderr = makeStderr();
  let call = 0;
  const result = checkAgy({
    _stderr: stderr.stream,
    _spawnSync: () => {
      call += 1;
      return call === 1
        ? { status: 0, stdout: "agy\n" }
        : { status: 0, stdout: "1.0.15\n" };
    },
  });
  assert.equal(result.installed, true);
  assert.equal(result.supported, false);
  assert.match(stderr.value, /agy update/);
});

test("checkAgy accepts AGY 1.1.16 without a warning", () => {
  const stderr = makeStderr();
  let call = 0;
  const result = checkAgy({
    _stderr: stderr.stream,
    _spawnSync: () => {
      call += 1;
      return call === 1
        ? { status: 0, stdout: "agy\n" }
        : { status: 0, stdout: "1.1.16\n" };
    },
  });
  assert.equal(result.supported, true);
  assert.equal(stderr.value, "");
});
