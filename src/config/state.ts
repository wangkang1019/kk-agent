import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  getAgentHome,
  getLocalSettingsPath,
  getProjectSettingsPath,
  writeJsonAtomic,
} from "./settings.js";

export interface ProjectTrustEntry {
  trusted: boolean;
  trustedAt?: string;
}

export interface GlobalState {
  version: 1;
  trustedProjects: Record<string, ProjectTrustEntry>;
}

export interface ProjectTrustInfo {
  key: string;
  trusted: boolean;
  hasRiskyConfig: boolean;
  riskyItems: string[];
}

let stateCache: { path: string; state: GlobalState } | null = null;
const sessionTrustedProjects = new Set<string>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emptyState(): GlobalState {
  return { version: 1, trustedProjects: {} };
}

function normalizeKey(filePath: string): string {
  return path.resolve(filePath).split(path.sep).join("/");
}

export function getStatePath(homeDir = os.homedir()): string {
  return path.join(getAgentHome(homeDir), "state.json");
}

export function resetGlobalStateCache(): void {
  stateCache = null;
  sessionTrustedProjects.clear();
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function getProjectTrustKey(cwd: string): Promise<string> {
  let current = path.resolve(cwd);
  const root = path.parse(current).root;

  while (true) {
    if (await pathExists(path.join(current, ".git"))) {
      return normalizeKey(current);
    }

    if (current === root) {
      return normalizeKey(cwd);
    }

    current = path.dirname(current);
  }
}

function isHomeProjectKey(key: string, homeDir = os.homedir()): boolean {
  return key === normalizeKey(homeDir);
}

function isAncestorOrSelf(ancestor: string, child: string): boolean {
  return child === ancestor || child.startsWith(`${ancestor}/`);
}

export async function getGlobalState(homeDir = os.homedir()): Promise<GlobalState> {
  const statePath = getStatePath(homeDir);
  if (stateCache?.path === statePath) {
    return stateCache.state;
  }

  try {
    const parsed = JSON.parse(await readFile(statePath, "utf8")) as unknown;
    if (isRecord(parsed)) {
      const legacyProjects = isRecord(parsed.projects) ? parsed.projects : {};
      const trustedProjects = isRecord(parsed.trustedProjects)
        ? parsed.trustedProjects
        : legacyProjects;
      const state: GlobalState = {
        version: 1,
        trustedProjects: Object.fromEntries(
          Object.entries(trustedProjects)
            .filter(([, value]) => isRecord(value) && value.trusted === true)
            .map(([key, rawValue]) => {
              const value = rawValue as Record<string, unknown>;
              return [
                normalizeKey(key),
              {
                trusted: true,
                ...(typeof value.trustedAt === "string" && {
                  trustedAt: value.trustedAt,
                }),
              },
              ];
            }),
        ),
      };
      stateCache = { path: statePath, state };
      return state;
    }
  } catch {
    // Missing or bad state falls back to an empty trusted-project map.
  }

  const state = emptyState();
  stateCache = { path: statePath, state };
  return state;
}

export async function saveGlobalState(
  update: (draft: GlobalState) => void,
  homeDir = os.homedir(),
): Promise<void> {
  const draft = JSON.parse(JSON.stringify(await getGlobalState(homeDir))) as GlobalState;
  update(draft);
  await writeJsonAtomic(getStatePath(homeDir), draft);
  stateCache = { path: getStatePath(homeDir), state: draft };
}

export async function trustProject(params: {
  cwd: string;
  homeDir?: string;
}): Promise<string> {
  const homeDir = params.homeDir ?? os.homedir();
  const key = await getProjectTrustKey(params.cwd);

  if (isHomeProjectKey(key, homeDir)) {
    sessionTrustedProjects.add(key);
    return key;
  }

  await saveGlobalState((state) => {
    state.trustedProjects[key] = {
      trusted: true,
      trustedAt: new Date().toISOString(),
    };
  }, homeDir);

  return key;
}

export async function isProjectTrusted(params: {
  cwd: string;
  homeDir?: string;
}): Promise<boolean> {
  const key = await getProjectTrustKey(params.cwd);
  if (sessionTrustedProjects.has(key)) {
    return true;
  }

  const state = await getGlobalState(params.homeDir);
  return Object.entries(state.trustedProjects).some(([trustedKey, value]) => {
    return value.trusted && isAncestorOrSelf(normalizeKey(trustedKey), key);
  });
}

async function readJsonObject(filePath: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function addRiskItemsFromSettings(
  settings: Record<string, unknown>,
  label: string,
  out: string[],
): void {
  if (isRecord(settings.hooks) && Object.keys(settings.hooks).length > 0) {
    out.push(`${label}: lifecycle hooks`);
  }
  if (isRecord(settings.mcpServers) && Object.keys(settings.mcpServers).length > 0) {
    out.push(`${label}: MCP servers`);
  }
  if (
    Array.isArray(settings.allow) &&
    settings.allow.some((rule) => typeof rule === "string" && rule.startsWith("Bash("))
  ) {
    out.push(`${label}: Bash allow rules`);
  }
  if (isRecord(settings.sandbox)) {
    const sandbox = settings.sandbox;
    if (sandbox.enabled === true || sandbox.allowUnsandboxedCommands === false) {
      out.push(`${label}: sandbox policy`);
    }
  }
  if (typeof settings.statusLine === "string" && settings.statusLine.trim()) {
    out.push(`${label}: status line command`);
  }
}

async function hasProjectMcpJson(cwd: string): Promise<boolean> {
  const mcpPath = path.join(path.resolve(cwd), ".kk-agent", "mcp.json");
  const parsed = await readJsonObject(mcpPath);
  return isRecord(parsed.mcpServers) && Object.keys(parsed.mcpServers).length > 0;
}

export async function getProjectTrustInfo(params: {
  cwd: string;
  homeDir?: string;
}): Promise<ProjectTrustInfo> {
  const key = await getProjectTrustKey(params.cwd);
  const trusted = await isProjectTrusted(params);
  const project = await readJsonObject(getProjectSettingsPath(params.cwd));
  const local = await readJsonObject(getLocalSettingsPath(params.cwd));
  const riskyItems: string[] = [];

  addRiskItemsFromSettings(project, "project settings", riskyItems);
  addRiskItemsFromSettings(local, "local settings", riskyItems);
  if (await hasProjectMcpJson(params.cwd)) {
    riskyItems.push("project MCP config");
  }

  return {
    key,
    trusted,
    hasRiskyConfig: riskyItems.length > 0,
    riskyItems,
  };
}
