// Compatibility with AGY CLI 1.4.1-1.5.16 (plugin 4.7.0). Fixtures marked
// "real" were captured from AGY 1.5.16 on Windows 11 build 26300.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AUTO_UNAVAILABLE_PATTERNS,
  buildAntigravityArgs,
  classifyAgyOutput,
  compareModelsNewestFirst,
  createAgyStreamParser,
  isKnownModel,
  parseAgyJsonResult,
  parseCliArgs,
  readAutoUnavailable,
  resolveAutoModel,
  resolveModelAlias,
  resolvePermissionStrategy,
  resolveRuntimeCapabilities,
  writeAutoUnavailable,
  FALLBACK_MODEL_CATALOG,
} from "../scripts/antigravity-bridge.js";

// Real `agy models` output from AGY 1.5.16 (consumer account).
const AGY_1_5_16_CATALOG = Object.freeze([
  ["gemini-4-neon-high", "Gemini 4 Neon (High)"],
  ["gemini-4-neon-xhigh", "Gemini 4 Neon (XHigh)"],
  ["gemini-4-neon-medium", "Gemini 4 Neon (Medium)"],
  ["gemini-4-neon-low", "Gemini 4 Neon (Low)"],
  ["gemini-4-carbon-medium", "Gemini 4 Carbon (Medium)"],
  ["gemini-4-carbon-high", "Gemini 4 Carbon (High)"],
  ["gemini-4-carbon-low", "Gemini 4 Carbon (Low)"],
  ["gemini-4-argon-medium", "Gemini 4 Argon (Medium)"],
  ["gemini-4-argon-high", "Gemini 4 Argon (High)"],
  ["gemini-4-argon-low", "Gemini 4 Argon (Low)"],
  ["gemini-4-hydrogen-high", "Gemini 4 Hydrogen (High)"],
  ["gemini-4-hydrogen-xhigh", "Gemini 4 Hydrogen (XHigh)"],
  ["gemini-4-hydrogen-medium", "Gemini 4 Hydrogen (Medium)"],
  ["gemini-4-hydrogen-low", "Gemini 4 Hydrogen (Low)"],
  ["gemini-pro-orchestrator-neon", "Orchestrator (Neon)"],
  ["gemini-pro-orchestrator", "Orchestrator (Carbon)"],
  ["gemini-pro-orchestrator-argon", "Orchestrator (Argon)"],
  ["gemini-3.8-flash-high", "Gemini 3.8 Flash (High)"],
  ["gemini-3.8-flash-medium", "Gemini 3.8 Flash (Medium)"],
  ["gemini-3.8-flash-low", "Gemini 3.8 Flash (Low)"],
  ["claude-opus-5-5-low", "Claude Opus 5.5 (Low)"],
  ["claude-opus-5-5-medium", "Claude Opus 5.5 (Medium)"],
  ["claude-opus-5-5-high", "Claude Opus 5.5 (High)"],
  ["claude-sonnet-5-5-low", "Claude Sonnet 5.5 (Low)"],
  ["claude-sonnet-5-5-medium", "Claude Sonnet 5.5 (Medium)"],
  ["claude-sonnet-5-5-high", "Claude Sonnet 5.5 (High)"],
  ["gpt-oss-120b-medium", "GPT-OSS 120B (Medium)"],
].map(([slug, label]) => ({ slug, label })));

// Real AGY 1.5.16 output for `--output-format json --print-timeout 2s` (exit 3).
const REAL_PRINT_TIMEOUT_ENVELOPE = {
  conversation_id: "c9015c36-20a4-46b8-9899-3b295636b9c4",
  status: "ERROR",
  response: "",
  error: "print timeout after 2s with the turn still in progress; the response is partial",
  duration_seconds: 0,
  num_turns: 1,
  usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 },
  finished_reason: "print_timeout",
};
const REAL_PRINT_TIMEOUT_STDERR = [
  "[agy] print timeout after 2s with turn in progress; returning partial output",
  "error: print timeout after 2s with the turn still in progress; the response is partial",
  'AGY_ERROR: {"short_error":"print timeout after 2s with the turn still in progress; the response is partial","status":"DEADLINE_EXCEEDED","retryable":false,"reason":"print_timeout"}',
  "",
].join("\n");
// Real AGY 1.5.16 stderr when Auto mode is unavailable for the account (exit 0).
const REAL_AUTO_UNAVAILABLE_WARNING =
  "warning: --mode auto is not available for this account; continuing in the default mode.\n";

// ─── Task 1: quota classification ────────────────────────────────────────────

test("AGY_ERROR with an unmapped status and a quota message maps to exit 10 without throwing", () => {
  const stderr = 'AGY_ERROR: {"status":"FAILED_PRECONDITION","message":"Spend cap reached"}\n';
  const classification = classifyAgyOutput({ status: "ERROR", error: "" }, { exitCode: 1, stderr });
  assert.equal(classification.type, "QUOTA_EXHAUSTED");
  assert.equal(classification.exitCode, 10);
});

for (const error of [
  "Your project reached its spend cap for this month.",
  "Prepaid balance exhausted. Add credits to continue.",
  "Weekly quota reached for this model.",
  "You hit the weekly usage limit.",
]) {
  test(`AGY 1.5.10 hard limit is QUOTA: ${error}`, () => {
    const classification = classifyAgyOutput({ status: "ERROR", error }, { format: "json", exitCode: 1 });
    assert.equal(classification?.type, "QUOTA_EXAUSTED");
    assert.equal(classification.exitCode, 10);
  });
}

// ─── Task 2: finished_reason and print timeout ───────────────────────────────

test("parseAgyJsonResult exposes finished_reason and defaults it to empty", () => {
  assert.equal(parseAgyJsonResult(REAL_PRINT_TIMEOUT_ENVELOPE).finishedReason, "print_timeout");
  assert.equal(parseAgyJsonResult({ status: "SUCCESS", response: "ok" }).finishedReason, "");
});

test("stream-json result carries finished_reason", () => {
  const parser = createAgyStreamParser();
  parser.push(JSON.stringify({ event: "result", result: { ...REAL_PRINT_TIMEOUT_ENVELOPE, response: "partial" } }) + "\n");
  const result = parser.end();
  assert.equal(result.finishedReason, "print_timeout");
  assert.equal(result.response, "partial");
});

test("real AGY 1.5.16 print timeout classifies as TIMEOUT 12 and keeps the AGY_ERROR", () => {
  const result = parseAgyJsonResult(REAL_PRINT_TIMEOUT_ENVELOPE);
  const classification = classifyAgyOutput(result, { format: "json", exitCode: 3, stderr: REAL_PRINT_TIMEOUT_STDERR });
  assert.equal(classification.type, "TIMEOUT");
  assert.equal(classification.exitCode, 12);
  assert.match(classification.reason, /print timeout after 2s/);
  assert.equal(classification.agyError.reason, "print_timeout");
});

test("finished_reason print_timeout alone is TIMEOUT even without stderr", () => {
  const classification = classifyAgyOutput({ status: "ERROR", error: "", finishedReason: "print_timeout" }, { exitCode: 3 });
  assert.equal(classification.type, "TIMEOUT");
  assert.equal(classification.exitCode, 12);
});

test("the [agy] print timeout stderr line alone is TIMEOUT for a failed run", () => {
  const stderr = "[agy] print timeout after 5m with turn in progress; returning partial output\n";
  assert.equal(classifyAgyOutput("partial text", { format: "text", exitCode: 3, stderr }).exitCode, 12);
  assert.equal(classifyAgyOutput("done", { format: "text", exitCode: 0, stderr }), null,
    "a successful run that merely prints the line is not reclassified");
});

test("finished_reason interrupted is a failure of type INTERRUPTED", () => {
  const classification = classifyAgyOutput({ status: "ERROR", error: "canceled", finishedReason: "interrupted" }, { exitCode: 130 });
  assert.equal(classification.type, "INTERRUPTED");
  assert.equal(classification.exitCode, 1);
});

test("exit 3 without a timeout marker keeps the generic AGY_ERROR mapping", () => {
  const stderr = 'AGY_ERROR: {"status":"UNAVAILABLE","code":503,"message":"backend down"}\n';
  const classification = classifyAgyOutput({ status: "ERROR", error: "" }, { exitCode: 3, stderr });
  assert.equal(classification.type, "AGY_ERROR");
  assert.equal(classification.exitCode, 1);
});

test("a normal success without finished_reason is untouched", () => {
  assert.equal(classifyAgyOutput(parseAgyJsonResult({ status: "SUCCESS", response: "ok" }), { exitCode: 0 }), null);
});

// ─── Task 3: -r / --resume ────────────────────────────────────────────────────

for (const flag of ["-r", "--resume", "--conversation"]) {
  test(`${flag} <id> forwards --conversation <id>`, () => {
    const parsed = parseCliArgs([flag, "abc123", "fix", "the", "bug"]);
    assert.equal(parsed.conversationId, "abc123");
    assert.equal(parsed.task, "fix the bug");
    const args = buildAntigravityArgs({ ...parsed, prompt: "x" });
    assert.deepEqual(args.slice(args.indexOf("--conversation"), args.indexOf("--conversation") + 2), ["--conversation", "abc123"]);
    assert.ok(!args.includes("-r") && !args.includes("--resume"));
  });
}

test("-r without a value is an error", () => {
  assert.throws(() => parseCliArgs(["-r"]), /Missing value/i);
});

// ─── Task 4: Gemini 4 model logic ────────────────────────────────────────────

test("family aliases resolve the Gemini 4 generation against the real 1.5.16 catalog", () => {
  assert.equal(resolveModelAlias("hydrogen", AGY_1_5_16_CATALOG), "gemini-4-hydrogen-xhigh");
  assert.equal(resolveModelAlias("neon", AGY_1_5_16_CATALOG), "gemini-4-neon-xhigh");
  assert.equal(resolveModelAlias("argon", AGY_1_5_16_CATALOG), "gemini-4-argon-high");
  assert.equal(resolveModelAlias("carbon high", AGY_1_5_16_CATALOG), "gemini-4-carbon-high");
  assert.equal(resolveModelAlias("gemini 4 neon low", AGY_1_5_16_CATALOG), "gemini-4-neon-low");
  assert.equal(resolveModelAlias("Gemini 4 Argon (Medium)", AGY_1_5_16_CATALOG), "gemini-4-argon-medium");
});

test("orchestrator aliases resolve the planner variants", () => {
  assert.equal(resolveModelAlias("orchestrator", AGY_1_5_16_CATALOG), "gemini-pro-orchestrator");
  assert.equal(resolveModelAlias("Orchestrator (Neon)", AGY_1_5_16_CATALOG), "gemini-pro-orchestrator-neon");
  assert.equal(resolveModelAlias("orchestrator argon", AGY_1_5_16_CATALOG), "gemini-pro-orchestrator-argon");
});

test("Gemini 4 slugs sort ahead of 3.8 and gpt-oss-120b is not version 120", () => {
  const sorted = [...AGY_1_5_16_CATALOG].sort(compareModelsNewestFirst).map(({ slug }) => slug);
  assert.ok(sorted.indexOf("gemini-4-neon-xhigh") < sorted.indexOf("gemini-3.8-flash-high"));
  assert.ok(sorted.indexOf("claude-opus-5-5-high") < sorted.indexOf("gemini-4-neon-xhigh"),
    "5.5 is still newer than major-only 4");
  assert.ok(sorted.indexOf("gpt-oss-120b-medium") > sorted.indexOf("gemini-3.8-flash-low"));
});

test("existing families and auto keep their behavior", () => {
  assert.equal(resolveModelAlias("flash", AGY_1_5_16_CATALOG), "gemini-3.8-flash-high");
  assert.equal(resolveModelAlias("opus", AGY_1_5_16_CATALOG), "claude-opus-5-5-high");
  assert.equal(resolveModelAlias("sonnet", AGY_1_5_16_CATALOG), "claude-sonnet-5-5-high");
  assert.equal(resolveModelAlias("gpt oss", AGY_1_5_16_CATALOG), "gpt-oss-120b-medium");
  assert.equal(resolveAutoModel({ included: [] }, AGY_1_5_16_CATALOG), "gemini-3.8-flash-low");
  assert.equal(isKnownModel("gemini-4-hydrogen-xhigh", AGY_1_5_16_CATALOG), true);
  assert.equal(resolveModelAlias("flash"), "gemini-3.8-flash-high", "fallback catalog unchanged");
  assert.equal(FALLBACK_MODEL_CATALOG.length, 17);
});

// ─── Task 5: runtime capabilities ────────────────────────────────────────────

for (const [platform, version, osRelease, auto, unlimited] of [
  ["linux", "1.3.4", "6.8.0", false, false],
  ["linux", "1.3.5", "6.8.0", true, false],
  ["darwin", "1.4.9", "24.0.0", true, false],
  ["darwin", "1.5.0", "24.0.0", true, true],
  ["win32", "1.4.3", "10.0.26100", false, false],
  ["win32", "1.4.4", "10.0.22631", false, false],
  ["win32", "1.4.4", "10.0.26100", true, false],
  ["win32", "1.5.16", "10.0.26300", true, true],
  ["freebsd", "1.5.16", "14.0", false, true],
]) {
  test(`capabilities ${platform} AGY ${version} (${osRelease}): auto=${auto}, unlimited=${unlimited}`, () => {
    const capabilities = resolveRuntimeCapabilities({ version, platform, osRelease });
    assert.equal(capabilities.autoAvailable, auto);
    assert.equal(capabilities.nativeUnlimitedTimeout, unlimited);
    if (!auto) assert.ok(capabilities.autoUnavailableReason);
  });
}

test("Windows reasons name the missing AGY version or the Windows build", () => {
  assert.match(resolveRuntimeCapabilities({ version: "1.4.3", platform: "win32", osRelease: "10.0.26100" }).autoUnavailableReason, /AGY 1\.4\.4/);
  assert.match(resolveRuntimeCapabilities({ version: "1.5.16", platform: "win32", osRelease: "10.0.22631" }).autoUnavailableReason, /24H2.*22631/);
  assert.match(resolveRuntimeCapabilities({ version: "1.3.4", platform: "linux" }).autoUnavailableReason, /requires AGY 1\.3\.5/);
});

// ─── Task 6: timeout policy in argv ──────────────────────────────────────────

test("buildAntigravityArgs omits --print-timeout only for unlimited runs without a ceiling", () => {
  assert.ok(!buildAntigravityArgs({ prompt: "x", unlimitedTimeout: true }).includes("--print-timeout"));
  assert.deepEqual(buildAntigravityArgs({ prompt: "x", unlimitedTimeout: true, timeout: "3m" }).slice(-2), ["--print-timeout", "3m"]);
  assert.deepEqual(buildAntigravityArgs({ prompt: "x" }).slice(-2), ["--print-timeout", "600000ms"],
    "the pure default stays the legacy-safe 10-minute ceiling");
});

// ─── Task 8: permission strategy ─────────────────────────────────────────────

test("permission strategy: explicit flags win, Auto where available, bypass elsewhere", () => {
  const auto = { autoAvailable: true };
  const none = { autoAvailable: false };
  assert.deepEqual(resolvePermissionStrategy(parseCliArgs(["task"]), auto), { strategy: "auto-default", mode: "auto", skipPermissions: false });
  assert.deepEqual(resolvePermissionStrategy(parseCliArgs(["task"]), none), { strategy: "bypass-default", mode: undefined, skipPermissions: true });
  assert.equal(resolvePermissionStrategy(parseCliArgs(["task"]), auto, { autoKnownUnavailable: true }).strategy, "bypass-default");
  assert.deepEqual(resolvePermissionStrategy(parseCliArgs(["--skip-permissions", "task"]), auto), { strategy: "bypass-explicit", mode: undefined, skipPermissions: true });
  assert.deepEqual(resolvePermissionStrategy(parseCliArgs(["--read-only", "task"]), auto), { strategy: "read-only", mode: "plan", skipPermissions: false });
  assert.deepEqual(resolvePermissionStrategy(parseCliArgs(["--mode", "auto", "task"]), none), { strategy: "mode-explicit", mode: "auto", skipPermissions: false });
  assert.equal(resolvePermissionStrategy(parseCliArgs(["--mode", "accept-edits", "task"]), auto).strategy, "mode-explicit");
  assert.equal(resolvePermissionStrategy(parseCliArgs(["--generate-image", "x"]), auto).strategy, "bypass-default");
  assert.equal(resolvePermissionStrategy(parseCliArgs(["--interactive", "x"]), auto).strategy, "bypass-default");
});

test("the real AGY 1.5.16 Auto warning matches AUTO_UNAVAILABLE_PATTERNS", () => {
  assert.ok(AUTO_UNAVAILABLE_PATTERNS.some((pattern) => pattern.test(REAL_AUTO_UNAVAILABLE_WARNING)));
  assert.ok(!AUTO_UNAVAILABLE_PATTERNS.some((pattern) => pattern.test("Auto mode reviewed the command and allowed it")));
});

test("Auto unavailability cache is per version and expires after 24h", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-cap-cache-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const cachePath = path.join(dir, "nested", "capabilities.json");
  assert.equal(readAutoUnavailable(cachePath, "1.5.16"), false);
  writeAutoUnavailable(cachePath, "1.5.16", 1_000);
  assert.equal(readAutoUnavailable(cachePath, "1.5.16", 2_000), true);
  assert.equal(readAutoUnavailable(cachePath, "1.5.17", 2_000), false, "an update retries Auto");
  assert.equal(readAutoUnavailable(cachePath, "1.5.16", 1_000 + 24 * 60 * 60 * 1000), false);
});
