import { parse as parseYaml } from "yaml";

import type { SkillFrontmatter } from "../../types/skill.js";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export interface SplitSkillFrontmatterResult {
  raw: Record<string, unknown>;
  body: string;
  parseError?: string;
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
      .map((item) => asString(item))
      .filter((item): item is string => Boolean(item));
  }

  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [];
}

function asBoolean(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "true" || normalized === "yes" || normalized === "1";
  }

  if (typeof value === "number") {
    return value !== 0;
  }

  return false;
}

export function splitSkillFrontmatter(content: string): SplitSkillFrontmatterResult {
  const normalizedContent = content.replace(/^\uFEFF/, "");
  const match = normalizedContent.match(FRONTMATTER_RE);

  if (!match) {
    return { raw: {}, body: normalizedContent };
  }

  const yamlText = match[1] ?? "";
  const body = match[2] ?? "";

  try {
    const parsed = parseYaml(yamlText) as unknown;

    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return {
        raw: parsed as Record<string, unknown>,
        body,
      };
    }

    return {
      raw: {},
      body,
      parseError: "Frontmatter must be a YAML mapping.",
    };
  } catch (error) {
    return {
      raw: {},
      body,
      parseError: error instanceof Error ? error.message : String(error),
    };
  }
}

export function extractFallbackDescription(body: string): string {
  const buffer: string[] = [];

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (!line) {
      if (buffer.length > 0) {
        break;
      }
      continue;
    }

    if (buffer.length === 0 && line.startsWith("#")) {
      continue;
    }

    buffer.push(line);
  }

  return buffer.join(" ").replace(/\s+/g, " ").trim();
}

export function normalizeSkillFrontmatter(
  raw: Record<string, unknown>,
): SkillFrontmatter {
  const allowedTools = asStringArray(raw["allowed-tools"] ?? raw.allowedTools);
  const paths = asStringArray(raw.paths);

  return {
    ...(asString(raw.name) && { name: asString(raw.name) }),
    ...(asString(raw.description) && { description: asString(raw.description) }),
    ...(asString(raw.when_to_use ?? raw.whenToUse) && {
      whenToUse: asString(raw.when_to_use ?? raw.whenToUse),
    }),
    allowedTools,
    ...(asString(raw["argument-hint"] ?? raw.argumentHint) && {
      argumentHint: asString(raw["argument-hint"] ?? raw.argumentHint),
    }),
    disableModelInvocation: asBoolean(
      raw["disable-model-invocation"] ?? raw.disableModelInvocation,
    ),
    ...(paths.length > 0 && { paths }),
    hasForkContext: asString(raw.context) === "fork",
    raw,
  };
}
