#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { logEvent } from "./utils.js";

export const MIN_AGY_VERSION = "1.1.8";

export function compareVersions(left, right) {
  const parse = (value) => String(value).match(/\d+(?:\.\d+){0,2}/)?.[0]
    .split(".")
    .map((part) => Number.parseInt(part, 10)) ?? [0];
  const leftParts = parse(left);
  const rightParts = parse(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function checkAgy({ _spawnSync = spawnSync, _stderr = process.stderr } = {}) {
  const isWin = process.platform === "win32";
  const whichCmd = isWin ? "where" : "which";
  const whichResult = _spawnSync(whichCmd, ["agy"], { encoding: "utf8", shell: false });
  const agyPath = whichResult.stdout?.trim().split(/\r?\n/)[0]?.trim();
  const installed = whichResult.status === 0 && Boolean(agyPath);

  if (!installed) {
    logEvent("agy.check.not_found");
    _stderr.write(
      "Warning: Antigravity CLI (agy) was not found on PATH. " +
        "Install and authenticate it before using cc-antigravity-plugin.\n",
    );
    return { installed: false, supported: false };
  }

  const versionResult = _spawnSync(agyPath, ["--version"], {
    encoding: "utf8",
    shell: false,
    timeout: 5_000,
  });
  const version = versionResult.stdout?.trim() || versionResult.stderr?.trim() || "(unknown)";

  if (versionResult.status !== 0) {
    logEvent("agy.check.version_failed", {
      agyPath,
      exitCode: versionResult.status,
      stderr: versionResult.stderr?.trim(),
    });
    _stderr.write(
      `Warning: Antigravity CLI found at ${agyPath} but did not respond to --version ` +
        `(exit code ${versionResult.status}). It may require authentication — run \`agy\` once.\n`,
    );
    return { installed: true, supported: false, agyPath, version };
  }

  const supported = compareVersions(version, MIN_AGY_VERSION) >= 0;
  logEvent("agy.check.ok", { agyPath, version, supported, minimum: MIN_AGY_VERSION });
  if (!supported) {
    logEvent("agy.check.outdated", { agyPath, version, minimum: MIN_AGY_VERSION });
    _stderr.write(
      `Warning: Antigravity CLI ${version} is older than the minimum supported version ` +
        `${MIN_AGY_VERSION}. Run \`agy update\` to enable structured headless output.\n`,
    );
  }
  return { installed: true, supported, agyPath, version };
}

const isMain = process.argv[1] != null
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) checkAgy();
