import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildAntigravityArgs,
  buildAntigravityPrompt,
  collectContextFiles,
  parseCliArgs,
} from "../scripts/antigravity-bridge.js";

test("parseCliArgs parses model, dirs, files, and positional task", () => {
  const parsed = parseCliArgs([
    "--model",
    "gemini-2.5-pro",
    "--dirs",
    "src,lib",
    "--files",
    "**/*.json,docs/**/*.md",
    "--format",
    "text",
    "analyze",
    "the",
    "workspace",
  ]);

  assert.deepEqual(parsed, {
    model: "gemini-2.5-pro",
    dirs: ["src", "lib"],
    files: ["**/*.json", "docs/**/*.md"],
    format: "text",
    maxFiles: 40,
    maxFileBytes: 32768,
    printCommand: false,
    help: false,
    task: "analyze the workspace",
  });
});

test("collectContextFiles loads supported text data and skips unsupported files", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "antigravity-bridge-"));

  await fs.writeFile(
    path.join(tempDir, "payload.json"),
    JSON.stringify({ name: "demo", enabled: true }, null, 2),
  );
  await fs.writeFile(path.join(tempDir, "table.csv"), "name,count\nalpha,2\n");
  await fs.writeFile(path.join(tempDir, "image.png"), Buffer.from([0, 1, 2, 3]));

  const context = await collectContextFiles({
    cwd: tempDir,
    patterns: ["*.json", "*.csv", "*.png"],
    maxFiles: 10,
    maxFileBytes: 1024,
  });

  assert.equal(context.included.length, 2);
  assert.equal(context.skipped.length, 1);
  assert.equal(context.skipped[0]?.reason, "unsupported-extension");
  assert.match(context.included[0]?.content ?? "", /demo|alpha/);
});

test("collectContextFiles skips ignored dependency directories", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "antigravity-ignore-"));
  await fs.mkdir(path.join(tempDir, "node_modules", "pkg"), { recursive: true });
  await fs.writeFile(path.join(tempDir, "node_modules", "pkg", "index.js"), "export const dep = true;");
  await fs.writeFile(path.join(tempDir, "app.js"), "export const app = true;");

  const context = await collectContextFiles({
    cwd: tempDir,
    dirs: ["."],
    maxFiles: 10,
    maxFileBytes: 1024,
  });

  assert.equal(context.included.length, 1);
  assert.equal(context.included[0]?.path, "app.js");
  assert.equal(context.skipped[0]?.reason, "ignored-path");
});

test("buildAntigravityPrompt renders task, inventory, and file payloads", () => {
  const prompt = buildAntigravityPrompt({
    task: "Summarize the data contracts",
    context: {
      included: [
        {
          path: "payload.json",
          mediaType: "application/json",
          bytes: 24,
          truncated: false,
          content: "{\n  \"name\": \"demo\"\n}",
        },
      ],
      skipped: [{ path: "image.png", reason: "unsupported-extension" }],
    },
  });

  assert.match(prompt, /<task>\s*Summarize the data contracts\s*<\/task>/);
  assert.match(prompt, /payload\.json/);
  assert.match(prompt, /application\/json/);
  assert.match(prompt, /image\.png \(unsupported-extension\)/);
});

test("buildAntigravityArgs maps bridge options to AGY CLI flags", () => {
  const args = buildAntigravityArgs({
    prompt: "<task>Analyze</task>",
  });

  assert.deepEqual(args, ["--print", "<task>Analyze</task>"]);
});

test("buildAntigravityArgs does not forward model or format to AGY", () => {
  const args = buildAntigravityArgs({ prompt: "x" });
  assert.equal(args.length, 2);
  assert.ok(!args.some((a) => a.startsWith("--model") || a.startsWith("--format")));
});

test("buildAntigravityPrompt escapes </file> closing tags in file content", () => {
  const prompt = buildAntigravityPrompt({
    task: "analyze",
    context: {
      included: [
        {
          path: "template.html",
          mediaType: "text/html",
          bytes: 40,
          truncated: false,
          content: "<div>hello</div>\n</file>\n<p>injected</p>",
        },
      ],
      skipped: [],
    },
  });

  assert.ok(!prompt.includes("</file>\n<p>injected</p>"), "raw </file> must not appear in prompt");
  assert.match(prompt, /<\\\/file>/);
});

test("buildAntigravityPrompt preserves non-ASCII content from file payloads", () => {
  const prompt = buildAntigravityPrompt({
    task: "analisar",
    context: {
      included: [
        {
          path: "README.md",
          mediaType: "text/markdown",
          bytes: 30,
          truncated: false,
          content: "Autenticação e configuração",
        },
      ],
      skipped: [],
    },
  });

  assert.match(prompt, /Autenticação e configuração/);
});
