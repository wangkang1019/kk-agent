import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { splitSkillFrontmatter } from "../services/skills/parseFrontmatter.js";
import type { PermissionMode } from "../permissions/permissions.js";
import type { AgentDefinition, AgentSource } from "./types.js";

export interface LoadAgentsResult {
  agents: AgentDefinition[];
  warnings: string[];
}

export interface LoadCustomAgentsParams {
  cwd: string;
  homeDir?: string;
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return undefined;
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map(asString)
      .filter((item): item is string => Boolean(item));
  }

  if (typeof value === "string") {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }

  return [];
}

function asPositiveInt(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

function asPermissionMode(value: unknown): PermissionMode | undefined {
  const text = asString(value);
  return text === "default" || text === "plan" || text === "auto"
    ? text
    : undefined;
}

function asIsolation(value: unknown): AgentDefinition["isolation"] | undefined {
  const text = asString(value);
  return text === "none" || text === "worktree" ? text : undefined;
}

export function getUserAgentsDir(homeDir = os.homedir()): string {
  return path.join(homeDir, ".kk-agent", "agents");
}

export function getProjectAgentsDir(cwd: string): string {
  return path.join(path.resolve(cwd), ".kk-agent", "agents");
}

export async function loadAgentsFromDir(
  dir: string,
  source: AgentSource,
): Promise<LoadAgentsResult> {
  let entries;

  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return { agents: [], warnings: [] };
    }

    return {
      agents: [],
      warnings: [`[agents] Failed to read ${dir}: ${error instanceof Error ? error.message : String(error)}`],
    };
  }

  const agents: AgentDefinition[] = [];
  const warnings: string[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) {
      continue;
    }

    const filePath = path.join(dir, entry.name);
    const raw = await readFile(filePath, "utf8");
    const split = splitSkillFrontmatter(raw);
    const name = asString(split.raw.name);
    const description = asString(split.raw.description);
    const systemPrompt = split.body.trim();

    if (split.parseError || !name || !description || !systemPrompt) {
      warnings.push(`[agents] Skipping ${filePath}: invalid agent definition`);
      continue;
    }

    const tools = asStringArray(split.raw.tools);
    const disallowedTools = asStringArray(
      split.raw.disallowedTools ?? split.raw.disallowed_tools,
    );
    const model = asString(split.raw.model);
    const maxTurns = asPositiveInt(split.raw.maxTurns ?? split.raw.max_turns);
    const permissionMode = asPermissionMode(
      split.raw.permissionMode ?? split.raw.permission_mode,
    );
    const isolation = asIsolation(split.raw.isolation);

    agents.push({
      agentType: name,
      whenToUse: description,
      ...(tools.length > 0 && { tools }),
      ...(disallowedTools.length > 0 && { disallowedTools }),
      ...(model && { model }),
      ...(maxTurns && { maxTurns }),
      ...(permissionMode && { permissionMode }),
      ...(isolation && { isolation }),
      source,
      filePath,
      getSystemPrompt: () => systemPrompt,
    });
  }

  return { agents, warnings };
}

export async function loadAllCustomAgents(
  params: LoadCustomAgentsParams,
): Promise<LoadAgentsResult> {
  const [user, project] = await Promise.all([
    loadAgentsFromDir(getUserAgentsDir(params.homeDir), "user"),
    loadAgentsFromDir(getProjectAgentsDir(params.cwd), "project"),
  ]);

  return {
    agents: [...user.agents, ...project.agents],
    warnings: [...user.warnings, ...project.warnings],
  };
}
