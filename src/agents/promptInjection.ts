import type { AgentDefinition } from "./types.js";

function sortAgents(agents: AgentDefinition[]): AgentDefinition[] {
  return [...agents].sort((left, right) => {
    if (left.source === "built-in" && right.source !== "built-in") {
      return -1;
    }

    if (left.source !== "built-in" && right.source === "built-in") {
      return 1;
    }

    return left.agentType.localeCompare(right.agentType);
  });
}

export function formatAgentsSystemReminder(agents: AgentDefinition[]): string {
  if (agents.length === 0) {
    return "";
  }

  return [
    "<system-reminder>",
    "Available SubAgents can be invoked via the `Agent` tool.",
    'Call `Agent` with `prompt`, `description`, and optional `subagent_type`.',
    "The prompt must be self-contained because SubAgents do not see parent conversation history.",
    "",
    ...sortAgents(agents).map((agent) => {
      return `- ${agent.agentType} [${agent.source}]: ${agent.whenToUse}`;
    }),
    "",
    "Custom SubAgents live at `<cwd>/.kk-agent/agents/<name>.md` or `~/.kk-agent/agents/<name>.md`.",
    "</system-reminder>",
  ].join("\n");
}
