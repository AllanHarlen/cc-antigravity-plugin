#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import process from "node:process";

const isWin = process.platform === "win32";
const whichCmd = isWin ? "where" : "which";
const result = spawnSync(whichCmd, ["agy"], { encoding: "utf8", shell: false });

if (result.status !== 0 || !result.stdout.trim()) {
  process.stderr.write(
    "Warning: Antigravity CLI (agy) was not found on PATH. Install and authenticate it before using cc-antigravity-plugin.\n",
  );
}

process.exit(0);
