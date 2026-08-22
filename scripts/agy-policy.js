#!/usr/bin/env node

// SessionStart hook: ships the coding-delegation policy as session context so the
// behavior lives in the plugin instead of a per-user rules file. Outputs the
// policy as `additionalContext`; the host adds it to the session at start.
//
// Toggle with the `coding_policy` userConfig option (env CLAUDE_PLUGIN_OPTION_CODING_POLICY).
// Default is on; set it to off/false/0/no/disabled to suppress injection.

import process from "node:process";
import { pathToFileURL } from "node:url";
import { logEvent } from "./utils.js";

export const POLICY_DISABLED_VALUES = new Set(["off", "false", "0", "no", "disabled"]);

export function policyEnabled(env = process.env) {
  const raw = env.CLAUDE_PLUGIN_OPTION_CODING_POLICY;
  if (raw == null || raw === "") return true; // default on
  return !POLICY_DISABLED_VALUES.has(String(raw).trim().toLowerCase());
}

export function buildPolicyContext() {
  return [
    "[cc-antigravity-plugin] Coding-delegation policy (shipped by the plugin):",
    "",
    "- Delegate file-creating/editing work (build, implement, refactor, fix, generate, format",
    "  a feature/app/component) to Antigravity CLI (AGY) instead of writing it directly with",
    "  Write/Edit. Use either path:",
    "    - Skill(\"cc-antigravity-plugin:antigravity\", \"--parallel --add-dir <dir> <task>\")",
    "      or the /cc-antigravity-plugin:antigravity command (simplest), or",
    "    - the antigravity-coder subagent when you want the run tracked by the harness.",
    "  Both route through the bridge -> AGY -> Gemini, so file generation does not spend Claude tokens.",
    "- Large front-end work: pass --parallel to fan out independent components/screens.",
    "- Model guidance: omit --model unless the user requests one, preserving their AGY /model;",
    "  generic Flash -> --model gemini-3.7-flash-high (runtime aliases track the newest catalog);",
    "  Claude review -> --model claude-sonnet-4-6; maximum Claude -> --model claude-opus-4-6-thinking.",
    "- Headless tasks use JSON and disable slash-command expansion by default. Use --format stream-json",
    "  for live tool/subagent progress, --effort only when explicitly requested, and --agent <name>",
    "  for custom agents. --interactive is exclusively the PTY mode.",
    "- antigravity-agent is read-only: never use it for coding.",
    "- Front-end images: when antigravity-coder returns an IMAGE_SUGGESTIONS block, present the",
    "  candidates to the user with AskUserQuestion (multiSelect) BEFORE generating, then generate",
    "  only the approved ones (one --generate-image call each) and wire them into the components.",
    "",
    "Small one-off edits to local/config files (including this plugin's own files) do not require delegation.",
    "",
    "- Precedence: this is the default when no more specific routing applies. An active",
    "  cc-orchestrador-subagents or cc-executor-subagents run has already resolved a",
    "  Project_Config (backendExecutor/frontendExecutor) for the work in flight — follow that",
    "  routing instead of this policy for any task inside that run, including when it assigns",
    "  back-end or full-stack work to Codex.",
  ].join("\n");
}

export function buildHookOutput(env = process.env) {
  if (!policyEnabled(env)) return null;
  return {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: buildPolicyContext(),
    },
  };
}

function main() {
  const output = buildHookOutput();
  if (output) {
    logEvent("agy.policy.injected");
    process.stdout.write(JSON.stringify(output));
  } else {
    logEvent("agy.policy.disabled");
  }
  process.exit(0);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
