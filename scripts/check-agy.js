#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const isWin = process.platform === "win32";
const whichCmd = isWin ? "where" : "which";

function resolveDefaultLogPath() {
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
      JSON.stringify({ timestamp: new Date().toISOString(), pid: process.pid, event, ...data }) +
        "\n",
      "utf8",
    );
  } catch {
    // ignore log errors
  }
}

// Check if agy is on PATH
const whichResult = spawnSync(whichCmd, ["agy"], { encoding: "utf8", shell: false });
const agyPath = whichResult.stdout.trim().split("\n")[0].trim();
const installed = whichResult.status === 0 && agyPath;

if (!installed) {
  logEvent("agy.check.not_found");
  process.stderr.write(
    "Warning: Antigravity CLI (agy) was not found on PATH. " +
      "Install and authenticate it before using cc-antigravity-plugin.\n",
  );
  process.exit(0);
}

// Verify the binary actually responds (catches broken installs)
const versionResult = spawnSync(agyPath, ["--version"], {
  encoding: "utf8",
  shell: false,
  timeout: 5_000,
});

const version = versionResult.stdout?.trim() || versionResult.stderr?.trim() || "(unknown)";
const versionOk = versionResult.status === 0;

if (!versionOk) {
  logEvent("agy.check.version_failed", {
    agyPath,
    exitCode: versionResult.status,
    stderr: versionResult.stderr?.trim(),
  });
  process.stderr.write(
    `Warning: Antigravity CLI found at ${agyPath} but did not respond to --version ` +
      `(exit code ${versionResult.status}). ` +
      "It may not be properly installed or may require authentication — run `agy` once to complete setup.\n",
  );
  process.exit(0);
}

logEvent("agy.check.ok", { agyPath, version });
