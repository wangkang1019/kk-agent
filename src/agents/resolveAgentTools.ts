import type { Tool } from "../tools/Tool.js";
import type { AgentDefinition } from "./types.js";

export interface ResolvedAgentTools {
  resolvedTools: Tool[];
  invalidTools: string[];
  hasWildcard: boolean;
}

export function resolveAgentTools(
  agent: Pick<AgentDefinition, "tools" | "disallowedTools">,
  availableTools: Tool[],
): ResolvedAgentTools {
  const disallowed = new Set(["Agent", ...(agent.disallowedTools ?? [])]);
  const base = availableTools.filter((tool) => !disallowed.has(tool.name));
  const wanted = agent.tools ?? [];
  const hasWildcard = wanted.length === 0 || wanted.includes("*");

  if (hasWildcard) {
    return {
      resolvedTools: base,
      invalidTools: [],
      hasWildcard: true,
    };
  }

  const byName = new Map(base.map((tool) => [tool.name, tool]));
  const resolvedTools: Tool[] = [];
  const invalidTools: string[] = [];

  for (const name of wanted) {
    const tool = byName.get(name);

    if (tool) {
      resolvedTools.push(tool);
    } else {
      invalidTools.push(name);
    }
  }

  return {
    resolvedTools,
    invalidTools,
    hasWildcard: false,
  };
}
