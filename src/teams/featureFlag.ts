import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const TRUTHY_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSEY_VALUES = new Set(["0", "false", "no", "off"]);

export interface AgentTeamsEnabledParams {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  homeDir?: string;
}

function isTruthy(value: string | undefined): boolean {
  return value !== undefined && TRUTHY_VALUES.has(value.trim().toLowerCase());
}

function envBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (TRUTHY_VALUES.has(normalized)) {
    return true;
  }
  if (FALSEY_VALUES.has(normalized)) {
    return false;
  }

  return undefined;
}

function readSettingsFlag(filePath: string): boolean | undefined {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as {
      agentTeams?: { enabled?: unknown };
      agentTeamsEnabled?: unknown;
    };

    if (typeof parsed.agentTeams?.enabled === "boolean") {
      return parsed.agentTeams.enabled;
    }

    if (typeof parsed.agentTeamsEnabled === "boolean") {
      return parsed.agentTeamsEnabled;
    }
  } catch {
    // Settings are optional; a bad or missing file should not block startup.
  }

  return undefined;
}

function readSettingsEnabled(params: AgentTeamsEnabledParams): boolean | undefined {
  const homeDir = params.homeDir ?? os.homedir();
  const cwd = params.cwd ?? process.cwd();
  const userFlag = readSettingsFlag(path.join(homeDir, ".kk-agent", "settings.json"));
  const projectFlag = readSettingsFlag(path.join(cwd, ".kk-agent", "settings.json"));

  return projectFlag ?? userFlag;
}

export function isAgentTeamsEnabled(params: AgentTeamsEnabledParams = {}): boolean {
  const argv = params.argv ?? process.argv;
  const env = params.env ?? process.env;

  if (argv.includes("--agent-teams")) {
    return true;
  }

  const kkEnv = envBoolean(env.KK_AGENT_TEAMS);
  if (kkEnv !== undefined) {
    return kkEnv;
  }

  if (isTruthy(env.EASY_AGENT_TEAMS)) {
    return true;
  }

  return readSettingsEnabled(params) === true;
}
