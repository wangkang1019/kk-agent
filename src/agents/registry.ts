import type { AgentDefinition } from "./types.js";

const registry = new Map<string, AgentDefinition>();

export function setAgents(agents: AgentDefinition[]): void {
  registry.clear();

  for (const agent of agents) {
    registry.set(agent.agentType, agent);
  }
}

export function getAllAgents(): AgentDefinition[] {
  return [...registry.values()];
}

export function findAgent(agentType: string): AgentDefinition | undefined {
  return registry.get(agentType);
}
