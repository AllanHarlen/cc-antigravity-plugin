import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import {
  buildPolicyContext,
  buildHookOutput,
  policyEnabled,
} from "../scripts/agy-policy.js";

async function read(path) {
  return fs.readFile(path, "utf8");
}

test("antigravity-agent is read-only and cannot use broad Bash", async () => {
  const agent = await read("agents/antigravity-agent.md");

  assert.match(agent, /description:[\s\S]*read-only/i);
  assert.match(agent, /tools:\s*\["Bash\(node \*antigravity-bridge\.js\* --read-only\*\)", "Glob", "Read"\]/);
  assert.doesNotMatch(agent, /tools:\s*\[[^\]]*"Bash"/, "agent must not expose broad Bash");
  assert.match(agent, /Do not use this agent for tasks that create, edit, delete, move, or format/i);
  assert.match(agent, /Skill\("cc-antigravity-plugin:antigravity"/);
});

test("antigravity-coder executes coding via the bridge with no broad Bash or native file tools", async () => {
  const agent = await read("agents/antigravity-coder.md");

  assert.match(agent, /tools:\s*\["Bash\(node \*antigravity-bridge\.js\*\)", "Glob", "Read"\]/);
  assert.doesNotMatch(agent, /--read-only\*\)/, "coder must not be locked to read-only bridge calls");
  assert.doesNotMatch(agent, /tools:\s*\[[^\]]*"Bash"[^)]/, "coder must not expose broad Bash");
  assert.doesNotMatch(agent, /tools:\s*\[[^\]]*"(Write|Edit)"/, "coder must not expose native file-writing tools");
  assert.doesNotMatch(agent, /tools:\s*\[[^\]]*"AskUserQuestion"/, "coder must not expose AskUserQuestion");
  assert.match(agent, /description:[\s\S]*does not burn Claude tokens/i);
});

test("antigravity-coder routes front-end image approval through the caller's AskUserQuestion", async () => {
  const agent = await read("agents/antigravity-coder.md");

  assert.match(agent, /IMAGE_SUGGESTIONS/, "coder must emit a structured IMAGE_SUGGESTIONS block");
  assert.match(agent, /AskUserQuestion/, "coder must reference the AskUserQuestion handoff");
  assert.match(
    agent,
    /do \*\*not\*\* have the\s*\n?\s*`AskUserQuestion` tool/i,
    "coder must state it cannot call AskUserQuestion itself",
  );
  assert.match(
    agent,
    /Generate images only after the caller passes back the approved subset/i,
    "coder must gate generation on caller approval",
  );
});

test("antigravity-coder is registered in the plugin manifest", async () => {
  const manifest = JSON.parse(await read(".claude-plugin/plugin.json"));

  assert.ok(
    manifest.agents.includes("./agents/antigravity-coder.md"),
    "plugin.json must register antigravity-coder",
  );
  assert.ok(
    manifest.agents.includes("./agents/antigravity-agent.md"),
    "plugin.json must still register the read-only antigravity-agent",
  );
});

test("the plugin ships the coding-delegation policy as a SessionStart hook", async () => {
  const hooks = JSON.parse(await read("hooks/hooks.json"));
  const sessionStart = hooks.hooks.SessionStart ?? [];
  const commands = sessionStart.flatMap((group) => group.hooks.map((h) => h.command));

  assert.ok(
    commands.some((c) => c.includes("agy-policy.js")),
    "hooks.json must register the agy-policy.js SessionStart hook",
  );
});

test("policy context carries the delegation directives that replace the user rule", () => {
  const policy = buildPolicyContext();

  assert.match(policy, /Delegate file-creating\/editing work/i);
  assert.match(policy, /cc-antigravity-plugin:antigravity/);
  assert.match(policy, /antigravity-coder/);
  assert.match(policy, /--parallel/);
  assert.match(policy, /antigravity-agent is read-only/i);
  assert.match(policy, /IMAGE_SUGGESTIONS[\s\S]*AskUserQuestion/);
});

test("policy injection is on by default and respects the off toggle", () => {
  assert.equal(policyEnabled({}), true);
  assert.equal(policyEnabled({ CLAUDE_PLUGIN_OPTION_CODING_POLICY: "" }), true);
  assert.equal(policyEnabled({ CLAUDE_PLUGIN_OPTION_CODING_POLICY: "on" }), true);

  for (const off of ["off", "false", "0", "no", "disabled", "OFF"]) {
    assert.equal(
      policyEnabled({ CLAUDE_PLUGIN_OPTION_CODING_POLICY: off }),
      false,
      `"${off}" must disable injection`,
    );
  }

  const emitted = buildHookOutput({});
  assert.equal(emitted.hookSpecificOutput.hookEventName, "SessionStart");
  assert.ok(emitted.hookSpecificOutput.additionalContext.length > 0);
  assert.equal(buildHookOutput({ CLAUDE_PLUGIN_OPTION_CODING_POLICY: "off" }), null);
});

test("coding_policy userConfig toggle is documented in the manifest", async () => {
  const manifest = JSON.parse(await read(".claude-plugin/plugin.json"));

  assert.ok(manifest.userConfig?.coding_policy, "plugin.json must declare the coding_policy option");
  assert.equal(manifest.userConfig.coding_policy.default, "on");
});

test("coding entry points restrict Bash to the bridge", async () => {
  const command = await read("commands/antigravity.md");
  const skill = await read("skills/SKILL.md");

  for (const source of [command, skill]) {
    assert.match(source, /allowed-tools: Bash\(node \*antigravity-bridge\.js\*\), Glob, Read/);
    assert.doesNotMatch(source, /allowed-tools: Bash, Glob, Read/);
  }
});

test("documentation routes coding away from antigravity-agent", async () => {
  const readme = await read("README.md");
  const readmePtBr = await read("README.pt-BR.md");
  const skill = await read("skills/SKILL.md");
  const useCases = await read("CASOS_USO.md");

  assert.match(readme, /Do not use `antigravity-agent` for coding/);
  assert.match(readme, /In Codex, use the skill/);
  assert.doesNotMatch(readme, /@antigravity-agent <task>/);
  assert.match(readmePtBr, /Não use `antigravity-agent` para coding/);
  assert.match(readmePtBr, /No Codex, use o skill/);
  assert.doesNotMatch(readmePtBr, /@antigravity-agent <tarefa>/);
  assert.match(skill, /Do not spawn\s+`antigravity-agent` for work that creates/i);
  assert.match(useCases, /UC13.*MonoRepo/s);
  assert.match(useCases, /\/cc-antigravity-plugin:antigravity --parallel --add-dir \.\/frontend/);
  assert.match(useCases, /Nunca usar Agent\(subagent_type="cc-antigravity-plugin:antigravity-agent"\) para coding/);
});
