import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

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
  const skill = await read("skills/SKILL.md");
  const useCases = await read("CASOS_USO.md");

  assert.match(readme, /Não use `antigravity-agent` para coding/);
  assert.doesNotMatch(readme, /@antigravity-agent <tarefa>/);
  assert.match(skill, /Do not spawn\s+`antigravity-agent` for work that creates/i);
  assert.match(useCases, /UC13.*MonoRepo/s);
  assert.match(useCases, /\/cc-antigravity-plugin:antigravity --parallel --add-dir \.\/frontend/);
  assert.match(useCases, /Nunca usar Agent\(subagent_type="cc-antigravity-plugin:antigravity-agent"\) para coding/);
});
