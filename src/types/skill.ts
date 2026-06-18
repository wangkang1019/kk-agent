export type SkillSource = "user" | "project";

export interface SkillFrontmatter {
  name?: string;
  description?: string;
  whenToUse?: string;
  allowedTools: string[];
  argumentHint?: string;
  disableModelInvocation: boolean;
  paths?: string[];
  hasForkContext: boolean;
  raw: Record<string, unknown>;
}

export interface Skill {
  name: string;
  description: string;
  whenToUse?: string;
  body: string;
  filePath: string;
  baseDir: string;
  source: SkillSource;
  frontmatter: SkillFrontmatter;
}

export interface LoadSkillsResult {
  skills: Skill[];
  warnings: string[];
}
