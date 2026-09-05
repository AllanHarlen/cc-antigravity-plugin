import fs from "node:fs";
import path from "node:path";
import process from "node:process";

export function resolveDefaultLogPath() {
  const isWin = process.platform === "win32";
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

// Log files older than this are pruned so the directory doesn't grow forever.
const LOG_RETENTION_DAYS = 14;

// Both memoized per process: mkdirSync is a syscall on every call otherwise,
// and the retention sweep only needs to run once per process lifetime, not
// once per logged event.
const ensuredDirs = new Set();
const sweptDirs = new Set();

function pruneOldLogs(dir) {
  if (sweptDirs.has(dir)) return;
  sweptDirs.add(dir);
  try {
    const cutoffMs = Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith("plugin-") || !name.endsWith(".jsonl")) continue;
      const filePath = path.join(dir, name);
      try {
        if (fs.statSync(filePath).mtimeMs < cutoffMs) fs.unlinkSync(filePath);
      } catch {
        // best-effort per-file; one bad entry shouldn't stop the sweep
      }
    }
  } catch {
    // Logging must never affect plugin execution.
  }
}

export function logEvent(event, data = {}) {
  const logPath = process.env.CC_ANTIGRAVITY_LOG_PATH || resolveDefaultLogPath();
  try {
    const dir = path.dirname(logPath);
    if (!ensuredDirs.has(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      ensuredDirs.add(dir);
      pruneOldLogs(dir);
    }
    fs.appendFileSync(
      logPath,
      JSON.stringify({
        timestamp: new Date().toISOString(),
        pid: process.pid,
        event,
        ...data,
      }) + "\n",
      "utf8",
    );
  } catch {
    // Logging must never affect plugin execution.
  }
}
