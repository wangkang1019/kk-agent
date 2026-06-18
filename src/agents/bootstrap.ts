import { getBuiltInAgents } from "./builtIn.js";
import { loadAllCustomAgents } from "./loadAgentsDir.js";
import { setAgents } from "./registry.js";

export interface BootstrapAgentsParams {
  cwd: string;
  homeDir?: string;
}

export async function bootstrapAgents(params: BootstrapAgentsParams): Promise<{
  builtInCount: number;
  customCount: number;
  warnings: string[];
}> {
  const builtIns = getBuiltInAgents();
  const custom = await loadAllCustomAgents(params);
  setAgents([...builtIns, ...custom.agents]);

  return {
    builtInCount: builtIns.length,
    customCount: custom.agents.length,
    warnings: custom.warnings,
  };
}
