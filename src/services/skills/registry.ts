import path from "node:path";

import ignore from "ignore";

import type { Skill } from "../../types/skill.js";

export const DEFAULT_SKILL_BUDGET_CHARS = 8_000;
const MAX_LISTING_DESC_CHARS = 250;
const MIN_DESC_CHARS_PER_SKILL = 20;

const dynamicSkills = new Map<string, Skill>();
const conditionalSkills = new Map<string, Skill>();
let initialized = false;

function posixify(filePath: string): string {
  return filePath.split(/[\\/]/).join("/");
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  if (maxChars <= 3) {
    return "...";
  }

  return `${value.slice(0, maxChars - 3).trimEnd()}...`;
}

function buildSkillLine(skill: Skill, descMaxChars: number): string {
  const fullDescription = skill.whenToUse
    ? `${skill.description} - ${skill.whenToUse}`
    : skill.description;

  return `- ${skill.name}: ${truncate(fullDescription, Math.min(descMaxChars, MAX_LISTING_DESC_CHARS))}`;
}

export function setSkills(skills: Skill[]): void {
  dynamicSkills.clear();
  conditionalSkills.clear();

  for (const skill of skills) {
    if (skill.frontmatter.paths && skill.frontmatter.paths.length > 0) {
      conditionalSkills.set(skill.name, skill);
    } else {
      dynamicSkills.set(skill.name, skill);
    }
  }

  initialized = true;
}

export function clearSkillsForTesting(): void {
  dynamicSkills.clear();
  conditionalSkills.clear();
  initialized = false;
}

export function isSkillsInitialized(): boolean {
  return initialized;
}

export function getModelVisibleSkills(): Skill[] {
  return [...dynamicSkills.values()].filter(
    (skill) => !skill.frontmatter.disableModelInvocation,
  );
}

export function getAllUserInvocableSkills(): Skill[] {
  return [...dynamicSkills.values(), ...conditionalSkills.values()];
}

export function findSkill(name: string): Skill | undefined {
  return dynamicSkills.get(name) ?? conditionalSkills.get(name);
}

export function activateConditionalSkill(name: string): boolean {
  const skill = conditionalSkills.get(name);

  if (!skill) {
    return false;
  }

  conditionalSkills.delete(name);
  dynamicSkills.set(skill.name, skill);
  return true;
}

export function formatSkillsWithinBudget(
  skills: Skill[],
  budget = DEFAULT_SKILL_BUDGET_CHARS,
): string {
  if (skills.length === 0) {
    return "";
  }

  const fullLines = skills.map((skill) => buildSkillLine(skill, MAX_LISTING_DESC_CHARS));
  const fullLength = fullLines.reduce((sum, line) => sum + line.length + 1, 0);

  if (fullLength <= budget) {
    return fullLines.join("\n");
  }

  const prefixLength = skills.reduce((sum, skill) => {
    return sum + `- ${skill.name}: `.length + 1;
  }, 0);
  const descBudget = budget - prefixLength;

  if (descBudget >= skills.length * MIN_DESC_CHARS_PER_SKILL) {
    const perDescription = Math.floor(descBudget / skills.length);
    const lines = skills.map((skill) => buildSkillLine(skill, perDescription));
    const length = lines.reduce((sum, line) => sum + line.length + 1, 0);

    if (length <= budget) {
      return lines.join("\n");
    }
  }

  return skills.map((skill) => `- ${skill.name}`).join("\n");
}

export function formatSkillsSystemReminder(skills = getModelVisibleSkills()): string {
  const listing = formatSkillsWithinBudget(skills);

  if (!listing) {
    return "";
  }

  return [
    "<system-reminder>",
    "Available skills you can invoke via the `Skill` tool.",
    "Call `Skill(skill=\"<name>\", args=\"<optional args>\")` when a skill matches the user's request.",
    "",
    listing,
    "</system-reminder>",
  ].join("\n");
}

export function activateConditionalSkillsForPaths(
  filePaths: string[],
  cwd: string,
): string[] {
  if (filePaths.length === 0 || conditionalSkills.size === 0) {
    return [];
  }

  const relativePaths = filePaths
    .map((filePath) => {
      const absolute = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
      const relative = path.relative(path.resolve(cwd), absolute);

      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
        return null;
      }

      return posixify(relative);
    })
    .filter((filePath): filePath is string => Boolean(filePath));
  const activated: string[] = [];

  for (const skill of conditionalSkills.values()) {
    const patterns = skill.frontmatter.paths;

    if (!patterns || patterns.length === 0) {
      continue;
    }

    const matcher = ignore().add(patterns);

    if (relativePaths.some((filePath) => matcher.ignores(filePath))) {
      if (activateConditionalSkill(skill.name)) {
        activated.push(skill.name);
      }
    }
  }

  return activated;
}

export function extractToolFilePaths(
  toolName: string,
  input: Record<string, unknown>,
): string[] {
  if (toolName === "Read" || toolName === "Write" || toolName === "Edit") {
    return typeof input.file_path === "string" ? [input.file_path] : [];
  }

  if (toolName === "Glob") {
    return typeof input.path === "string" ? [input.path] : [];
  }

  return [];
}
