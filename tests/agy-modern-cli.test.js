import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  parseCliArgs, buildAntigravityArgs, resolveModelAlias, isKnownModel,
  resolveJsonSchema, parseAgyError, classifyAgyOutput, buildAntigravityPrompt,
} from "../scripts/antigravity-bridge.js";

for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
  test(`native effort ${effort} survives parsing and argv construction`, () => {
    const parsed = parseCliArgs(["--effort", effort, "task"]);
    const args = buildAntigravityArgs({ ...parsed, prompt: "task" });
    assert.equal(args[args.indexOf("--effort") + 1], effort);
  });
}

test("Auto mode removes the default bypass in either flag order", () => {
  for (const argv of [["--mode", "auto", "task"], ["task", "--mode", "auto"]]) {
    const parsed = parseCliArgs(argv, { platform: "linux" });
    const args = buildAntigravityArgs({ ...parsed, prompt: "task" });
    assert.equal(parsed.skipPermissions, false);
    assert.equal(args[args.indexOf("--mode") + 1], "auto");
    assert.ok(!args.includes("--dangerously-skip-permissions"));
  }
});

test("Auto mode rejects explicit bypass in either flag order", () => {
  for (const argv of [
    ["--mode", "auto", "--skip-permissions", "task"],
    ["--skip-permissions", "--mode", "auto", "task"],
  ]) assert.throws(() => parseCliArgs(argv, { platform: "linux" }), /cannot be combined/);
  assert.throws(() => buildAntigravityArgs({ mode: "auto", skipPermissions: true }), /cannot bypass/);
});

test("Auto mode reports unsupported Windows and read-only retains precedence", () => {
  assert.throws(() => parseCliArgs(["--mode", "auto", "task"], { platform: "win32" }), /Windows/);
  for (const argv of [
    ["--mode", "auto", "--read-only", "task"],
    ["--read-only", "--mode", "auto", "task"],
  ]) {
    const parsed = parseCliArgs(argv, { platform: "win32" });
    assert.equal(parsed.mode, "plan");
    assert.equal(parsed.skipPermissions, false);
  }
});

test("exact base model preserves native default effort, prose aliases preserve tier selection", () => {
  const catalog = [
    { slug: "new-model-medium", label: "New Model (Medium)" },
    { slug: "new-model-high", label: "New Model (High)" },
    { slug: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
  ];
  assert.equal(resolveModelAlias("new-model", catalog), "new-model");
  assert.equal(isKnownModel("new-model", catalog), true);
  assert.equal(isKnownModel("missing-model", catalog), false);
  assert.equal(resolveModelAlias("sonnet", catalog), "claude-sonnet-5-5");
  assert.equal(resolveModelAlias("gemini 3.7 flash"), "gemini-3.7-flash-high");
  assert.equal(resolveModelAlias("gemini-3.7-flash"), "gemini-3.7-flash");
  const args = buildAntigravityArgs({ model: "new-model", prompt: "task" });
  assert.ok(!args.includes("--effort"));
});

test("model aliases select xhigh and max without confusing xhigh with high", () => {
  const catalog = ["high", "xhigh", "max"].map(tier => ({ slug: `gemini-4-pro-${tier}`, label: tier }));
  assert.equal(resolveModelAlias("pro", catalog), "gemini-4-pro-max");
  assert.equal(resolveModelAlias("pro xhigh", catalog), "gemini-4-pro-xhigh");
});

test("schema resolver accepts inline object schema and a file with spaces", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-schema-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const schema = { type: "object", properties: { ok: { type: "boolean" } } };
  await fs.writeFile(path.join(dir, "my schema.json"), JSON.stringify(schema));
  assert.equal(resolveJsonSchema("my schema.json", dir), path.join(dir, "my schema.json"));
  assert.deepEqual(JSON.parse(resolveJsonSchema(JSON.stringify(schema))), schema);
  assert.equal(resolveJsonSchema(undefined), undefined);
});

for (const value of ['{"type":"string"}', '{"type":"array"}', '{}', '[]', 'string', 'missing-schema.json', '{bad']) {
  test(`schema resolver rejects invalid or missing schema: ${value}`, () => {
    assert.throws(() => resolveJsonSchema(value), /Invalid --json-schema/);
  });
}

for (const [status, code, expectedType, expectedExit] of [
  ["RESOURCE_EXHAUSTED", 429, "QUOTA_EXHAUSTED", 10],
  ["UNAUTHENTICATED", 401, "AUTH_REQUIRED", 11],
  ["DEADLINE_EXCEEDED", 4, "TIMEOUT", 12],
  ["UNAVAILABLE", 503, "AGY_ERROR", 1],
]) {
  test(`structured stderr ${status} takes precedence over a partial result`, () => {
    const diagnostic = { status, code, message: "upstream failed", retryable: true, error_id: "test-id" };
    const stderr = `warning\nAGY_ERROR: ${JSON.stringify(diagnostic)}\n`;
    assert.deepEqual(parseAgyError(stderr), diagnostic);
    const classification = classifyAgyOutput({ status: "ERROR", error: "", response: "partial" }, { exitCode: 3, stderr });
    assert.equal(classification.type, expectedType);
    assert.equal(classification.exitCode, expectedExit);
    assert.deepEqual(classification.agyError, diagnostic);
  });
}

test("successful responses discussing auth and AGY_ERROR never become failures", () => {
  const stderr = 'AGY_ERROR: {"status":"UNAUTHENTICATED","code":401}\n';
  assert.equal(classifyAgyOutput({ status: "SUCCESS", response: stderr }, { exitCode: 0, stderr }), null);
  assert.equal(parseAgyError("AGY_ERROR: {broken"), undefined);
  assert.equal(classifyAgyOutput("Authentication expired. Please log back in.", { exitCode: 1 }).type, "AUTH_REQUIRED");
});

test("read-only uses the current search baseline while prohibiting commands and writes", () => {
  const prompt = buildAntigravityPrompt({ task: "review", context: { included: [], skipped: [] }, readOnly: true });
  assert.match(prompt, /code_search/);
  assert.match(prompt, /Do not assume legacy/);
  assert.match(prompt, /Do not call write_to_file.*or run_command/);
});

test("a versioned model alias never silently downgrades to another generation", () => {
  assert.equal(resolveModelAlias("claude sonnet 5.5"), "claude sonnet 5.5");
  assert.equal(resolveModelAlias("claude-sonnet-5-5"), "claude-sonnet-5-5");
  assert.equal(resolveModelAlias("gemini 99.0 flash"), "gemini 99.0 flash");
});
