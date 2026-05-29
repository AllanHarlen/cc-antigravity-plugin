#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import process from "node:process";
import { logEvent } from "./utils.js";

const isWin = process.platform === "win32";
const whichCmd = isWin ? "where" : "which";

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
