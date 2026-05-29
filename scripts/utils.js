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

export function logEvent(event, data = {}) {
  const logPath = process.env.CC_ANTIGRAVITY_LOG_PATH || resolveDefaultLogPath();
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
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
