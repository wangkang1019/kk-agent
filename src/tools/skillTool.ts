import type { Tool } from "./Tool.js";
import { findSkill } from "../services/skills/registry.js";

export const SKILL_NAME_RE = /^[a-zA-Z0-9_-]+$/;

function posixify(filePath: string): string {
  return filePath.split(/[\\/]/).join("/");
}

function getStringInput(
  input: Record<string, unknown>,
  key: string,
): string {
  const value = input[key];
  return typeof value === "string" ? value : "";
}

function substituteSkillVariables(params: {
  body: string;
  baseDir: string;
  args: string;
  sessionId: string;
}): string {
  return params.body
    .replaceAll("${CLAUDE_SKILL_DIR}", posixify(params.baseDir))
    .replaceAll("${CLAUDE_SESSION_ID}", params.sessionId)
    .replaceAll("$ARGUMENTS", params.args);
}

export function buildSkillInvocationText(params: {
  skillName: string;
  body: string;
  baseDir: string;
  args: string;
  sessionId: string;
}): string {
  return [
    `[skill_invocation:${params.skillName}]`,
    `Run skill "${params.skillName}" with the following instructions.`,
    `Base directory for this skill: ${posixify(params.baseDir)}`,
    "",
    substituteSkillVariables({
      body: params.body,
      baseDir: params.baseDir,
      args: params.args,
      sessionId: params.sessionId,
    }),
  ].join("\n");
}

export const skillTool: Tool = {
  name: "Skill",
  description:
    "Load and execute a named skill. The tool returns Markdown instructions; read them and continue following them for this turn.",
  inputSchema: {
    type: "object",
    properties: {
      skill: {
        type: "string",
        description: "The skill name to load.",
      },
      args: {
        type: "string",
        description: "Optional arguments to substitute into the skill instructions.",
      },
    },
    required: ["skill"],
    additionalProperties: false,
  },
  async call(input, context) {
    const name = getStringInput(input, "skill").trim();
    const args = getStringInput(input, "args");

    if (!name || !SKILL_NAME_RE.test(name)) {
      return {
        content: "Error: invalid skill name. Use letters, digits, underscores, or dashes.",
        isError: true,
      };
    }

    const skill = findSkill(name);

    if (!skill) {
      return {
        content: `Error: skill "${name}" not found.`,
        isError: true,
      };
    }

    if (skill.frontmatter.disableModelInvocation) {
      return {
        content: `Error: skill "${name}" can only be invoked by the user.`,
        isError: true,
      };
    }

    if (skill.frontmatter.hasForkContext) {
      return {
        content: `Error: skill "${name}" requires forked sub-agent context.`,
        isError: true,
      };
    }

    if (skill.frontmatter.allowedTools.length > 0) {
      context.addSessionAllowRules?.(skill.frontmatter.allowedTools);
    }

    const sessionId = context.sessionId ?? "unknown-session";
    const instructions = buildSkillInvocationText({
      skillName: skill.name,
      body: skill.body,
      baseDir: skill.baseDir,
      args,
      sessionId,
    });

    return {
      content: [
        `Loaded skill "${skill.name}" from ${skill.source}.`,
        "Follow the instructions below; they are the next steps for this turn.",
        "",
        instructions,
      ].join("\n"),
    };
  },
  isReadOnly() {
    return false;
  },
  isEnabled() {
    return true;
  },
};
