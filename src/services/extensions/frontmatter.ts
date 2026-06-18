import { parse as parseYaml } from "yaml";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export interface SplitFrontmatterResult {
  raw: Record<string, unknown>;
  body: string;
  parseError?: string;
}

export function splitFrontmatter(content: string): SplitFrontmatterResult {
  const normalized = content.replace(/^\uFEFF/, "");
  const match = normalized.match(FRONTMATTER_RE);

  if (!match) {
    return { raw: {}, body: normalized };
  }

  try {
    const parsed = parseYaml(match[1] ?? "") as unknown;

    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return {
        raw: parsed as Record<string, unknown>,
        body: match[2] ?? "",
      };
    }

    return {
      raw: {},
      body: match[2] ?? "",
      parseError: "Frontmatter must be a YAML mapping.",
    };
  } catch (error) {
    return {
      raw: {},
      body: match[2] ?? "",
      parseError: error instanceof Error ? error.message : String(error),
    };
  }
}

export function asString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return undefined;
}

export function asStringArray(value: unknown): string[] {
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

export function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "yes", "1"].includes(normalized)) {
      return true;
    }
    if (["false", "no", "0"].includes(normalized)) {
      return false;
    }
  }

  if (typeof value === "number") {
    return value !== 0;
  }

  return fallback;
}

export function fallbackDescription(body: string, fallback: string): string {
  const line = body
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item && !item.startsWith("#"));

  return line ?? fallback;
}
