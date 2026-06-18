import {
  loadAllSkills,
  type LoadAllSkillsParams,
} from "./loadSkillsDir.js";
import {
  getAllUserInvocableSkills,
  getModelVisibleSkills,
  setSkills,
} from "./registry.js";

export interface BootstrapSkillsResult {
  skillCount: number;
  userInvocableCount: number;
  conditionalCount: number;
  warnings: string[];
}

export async function bootstrapSkills(
  params: LoadAllSkillsParams,
): Promise<BootstrapSkillsResult> {
  const { skills, warnings } = await loadAllSkills(params);
  setSkills(skills);

  return {
    skillCount: getModelVisibleSkills().length,
    userInvocableCount: getAllUserInvocableSkills().length,
    conditionalCount: skills.filter((skill) => skill.frontmatter.paths?.length).length,
    warnings,
  };
}
