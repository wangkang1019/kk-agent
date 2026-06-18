import type { AgentDefinition } from "./types.js";

export const EXPLORE_AGENT: AgentDefinition = {
  agentType: "Explore",
  whenToUse: "Read-only code search and exploration agent. Use it to inspect files, find symbols, map implementation patterns, and report concise findings without modifying the workspace.",
  disallowedTools: ["Write", "Edit", "MemoryWrite", "TaskCreate", "TaskUpdate", "TodoWrite"],
  source: "built-in",
  getSystemPrompt: () => [
    "You are a read-only code exploration sub-agent.",
    "",
    "Do not modify files. Use Read, Grep, Glob, and read-only Bash when useful.",
    "Return a concise report with relevant file paths, line ranges, patterns, and gotchas for the main agent.",
  ].join("\n"),
};

export const GENERAL_PURPOSE_AGENT: AgentDefinition = {
  agentType: "general-purpose",
  whenToUse: "General-purpose sub-agent for focused multi-tool subtasks that benefit from isolated context.",
  source: "built-in",
  getSystemPrompt: () => [
    "You are a focused general-purpose sub-agent.",
    "",
    "Complete the delegated task in your own context window.",
    "Return a concise, factual summary for the main agent. Do not include unnecessary intermediate logs.",
  ].join("\n"),
};

export function getBuiltInAgents(): AgentDefinition[] {
  return [EXPLORE_AGENT, GENERAL_PURPOSE_AGENT];
}
