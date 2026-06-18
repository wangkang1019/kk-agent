import { readdir, readFile, realpath } from "node:fs/promises";
import type { Dirent } from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  LoadSkillsResult,
  Skill,
  SkillSource,
} from "../../types/skill.js";
import {
  extractFallbackDescription,
  normalizeSkillFrontmatter,
  splitSkillFrontmatter,
} from "./parseFrontmatter.js";

export const SKILL_FILE = "SKILL.md";

export interface LoadAllSkillsParams {
  cwd: string;
  homeDir?: string;
}

export function getUserSkillsDir(homeDir = os.homedir()): string {
  return path.join(homeDir, ".kk-agent", "skills");
}

export function getProjectSkillsDir(cwd: string): string {
  return path.join(path.resolve(cwd), ".kk-agent", "skills");
}

async function loadFromOneDir(
  dir: string,
  source: SkillSource,
): Promise<LoadSkillsResult> {
  let dirents: Dirent[];

  try {
    dirents = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { skills: [], warnings: [] };
    }

    return {
      skills: [],
      warnings: [`[skills] Failed to read ${dir}: ${error instanceof Error ? error.message : String(error)}`],
    };
  }

  const skills: Skill[] = [];
  const warnings: string[] = [];

  for (const dirent of dirents) {
    if (!dirent.isDirectory()) {
      continue;
    }

    const skillDir = path.join(dir, dirent.name);
    const filePath = path.join(skillDir, SKILL_FILE);
    let rawText: string;

    try {
      rawText = await readFile(filePath, "utf8");
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
        warnings.push(
          `[skills] Skipping ${skillDir}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      continue;
    }

    const split = splitSkillFrontmatter(rawText);

    if (split.parseError) {
      warnings.push(`[skills] Skipping ${dirent.name}: ${split.parseError}`);
      continue;
    }

    const frontmatter = normalizeSkillFrontmatter(split.raw);
    const name = frontmatter.name ?? dirent.name;
    const description =
      frontmatter.description ?? extractFallbackDescription(split.body) ?? name;
    const realFile = await realpath(filePath).catch(() => filePath);
    const realDir = await realpath(skillDir).catch(() => skillDir);

    skills.push({
      name,
      description,
      ...(frontmatter.whenToUse && { whenToUse: frontmatter.whenToUse }),
      body: split.body,
      filePath: realFile,
      baseDir: realDir,
      source,
      frontmatter,
    });
  }

  return { skills, warnings };
}

export async function loadAllSkills(
  params: LoadAllSkillsParams,
): Promise<LoadSkillsResult> {
  const [userResult, projectResult] = await Promise.all([
    loadFromOneDir(getUserSkillsDir(params.homeDir), "user"),
    loadFromOneDir(getProjectSkillsDir(params.cwd), "project"),
  ]);
  const seenRealPaths = new Set<string>();
  const byName = new Map<string, Skill>();

  for (const skill of [...userResult.skills, ...projectResult.skills]) {
    if (seenRealPaths.has(skill.filePath)) {
      continue;
    }

    seenRealPaths.add(skill.filePath);
    byName.set(skill.name, skill);
  }

  return {
    skills: [...byName.values()],
    warnings: [...userResult.warnings, ...projectResult.warnings],
  };
}
