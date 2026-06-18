import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  asBoolean,
  asString,
  fallbackDescription,
  splitFrontmatter,
} from "./frontmatter.js";
import {
  readMergedExtensionSettings,
  writeUserExtensionSetting,
} from "./settings.js";

export type OutputStyleSource = "built-in" | "user" | "project";

export interface OutputStyleConfig {
  name: string;
  description: string;
  prompt: string;
  source: OutputStyleSource;
  keepCodingInstructions: boolean;
  filePath?: string;
}

export interface OutputStylesBootstrapResult {
  styleCount: number;
  customCount: number;
  activeStyle: string;
  warnings: string[];
}

const DEFAULT_STYLE_NAME = "default";

const BUILT_IN_STYLES: OutputStyleConfig[] = [
  {
    name: "default",
    description: "Default - concise and professional",
    prompt: "",
    source: "built-in",
    keepCodingInstructions: true,
  },
  {
    name: "Explanatory",
    description: "Explain implementation choices with short Insight blocks",
    prompt: [
      "You help with software engineering tasks while also providing educational insights.",
      "",
      "## Insights",
      "Before and after meaningful code changes, provide brief educational explanations using this exact format:",
      "`✦ Insight ─────────────────────────────────────`",
      "- 2-3 concise, specific educational points",
      "`─────────────────────────────────────────────────`",
    ].join("\n"),
    source: "built-in",
    keepCodingInstructions: true,
  },
  {
    name: "Learning",
    description: "Leave small TODO(human) sections when teaching is useful",
    prompt: [
      "Help the user learn by pausing at meaningful implementation points.",
      "When appropriate, leave a small `TODO(human)` section instead of completing every line yourself, and explain what the user should fill in.",
    ].join("\n"),
    source: "built-in",
    keepCodingInstructions: true,
  },
];

const registry = new Map<string, OutputStyleConfig>();
let activeStyleName = DEFAULT_STYLE_NAME;

function seedBuiltIns(): void {
  registry.clear();
  for (const style of BUILT_IN_STYLES) {
    registry.set(style.name, style);
  }
  activeStyleName = DEFAULT_STYLE_NAME;
}

seedBuiltIns();

function getUserOutputStylesDir(homeDir = os.homedir()): string {
  return path.join(homeDir, ".kk-agent", "output-styles");
}

function getProjectOutputStylesDir(cwd: string): string {
  return path.join(path.resolve(cwd), ".kk-agent", "output-styles");
}

async function loadStylesFromDir(
  dir: string,
  source: "user" | "project",
): Promise<{ styles: OutputStyleConfig[]; warnings: string[] }> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { styles: [], warnings: [] };
    }
    return {
      styles: [],
      warnings: [`[output-styles] Failed to read ${dir}: ${error instanceof Error ? error.message : String(error)}`],
    };
  }

  const styles: OutputStyleConfig[] = [];
  const warnings: string[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) {
      continue;
    }

    const filePath = path.join(dir, entry.name);
    const split = splitFrontmatter(await readFile(filePath, "utf8"));

    if (split.parseError || !split.body.trim()) {
      warnings.push(`[output-styles] Skipping ${filePath}: ${split.parseError ?? "empty prompt"}`);
      continue;
    }

    const filename = entry.name.replace(/\.md$/i, "");
    styles.push({
      name: asString(split.raw.name) ?? filename,
      description: asString(split.raw.description) ??
        fallbackDescription(split.body, `Custom ${filename} output style`),
      prompt: split.body.trim(),
      source,
      keepCodingInstructions: asBoolean(
        split.raw["keep-coding-instructions"] ?? split.raw.keepCodingInstructions,
        true,
      ),
      filePath,
    });
  }

  return { styles, warnings };
}

export async function loadAllOutputStyles(params: {
  cwd: string;
  homeDir?: string;
}): Promise<{ styles: OutputStyleConfig[]; warnings: string[] }> {
  const homeDir = params.homeDir ?? os.homedir();
  const [user, project] = await Promise.all([
    loadStylesFromDir(getUserOutputStylesDir(homeDir), "user"),
    loadStylesFromDir(getProjectOutputStylesDir(params.cwd), "project"),
  ]);
  const byName = new Map<string, OutputStyleConfig>();

  for (const style of [...user.styles, ...project.styles]) {
    byName.set(style.name, style);
  }

  return {
    styles: [...byName.values()],
    warnings: [...user.warnings, ...project.warnings],
  };
}

export function setCustomOutputStyles(styles: OutputStyleConfig[]): void {
  const previousActive = activeStyleName;
  seedBuiltIns();
  for (const style of styles) {
    registry.set(style.name, style);
  }
  if (resolveOutputStyle(previousActive)) {
    activeStyleName = resolveOutputStyle(previousActive)?.name ?? DEFAULT_STYLE_NAME;
  }
}

export function resolveOutputStyle(name: string): OutputStyleConfig | undefined {
  const direct = registry.get(name);
  if (direct) {
    return direct;
  }

  const normalized = name.toLowerCase();
  return [...registry.values()].find((style) => style.name.toLowerCase() === normalized);
}

export async function setActiveOutputStyle(
  name: string,
  options?: { homeDir?: string; persist?: boolean },
): Promise<boolean> {
  const style = resolveOutputStyle(name);
  if (!style) {
    return false;
  }

  activeStyleName = style.name;

  if (options?.persist) {
    await writeUserExtensionSetting({
      homeDir: options.homeDir,
      key: "outputStyle",
      value: style.name,
    });
  }

  return true;
}

export function setOutputStyleForTesting(name: string): void {
  const style = resolveOutputStyle(name);
  if (!style) {
    throw new Error(`Unknown output style: ${name}`);
  }
  activeStyleName = style.name;
}

export function getActiveOutputStyleName(): string {
  return activeStyleName;
}

export function getActiveOutputStyleConfig(): OutputStyleConfig | null {
  return registry.get(activeStyleName) ?? null;
}

export function getAllOutputStyles(): OutputStyleConfig[] {
  return [...registry.values()];
}

export function shouldKeepCodingInstructions(): boolean {
  return getActiveOutputStyleConfig()?.keepCodingInstructions ?? true;
}

export function renderOutputStyleSection(): string {
  const style = getActiveOutputStyleConfig();

  if (!style || style.name === DEFAULT_STYLE_NAME || !style.prompt.trim()) {
    return "";
  }

  return [`# Output Style: ${style.name}`, style.prompt.trim()].join("\n\n");
}

export function formatOutputStylesStatus(): string {
  return [
    "Output style status",
    `- Active: ${activeStyleName}`,
    "",
    "Available styles:",
    ...getAllOutputStyles()
      .slice()
      .sort((left, right) => {
        if (left.name === DEFAULT_STYLE_NAME) return -1;
        if (right.name === DEFAULT_STYLE_NAME) return 1;
        return left.name.localeCompare(right.name);
      })
      .map((style) => {
        const marker = style.name === activeStyleName ? "*" : " ";
        return `  ${marker} ${style.name}    ${style.description} [${style.source}]`;
      }),
  ].join("\n");
}

export async function bootstrapOutputStyles(params: {
  cwd: string;
  homeDir?: string;
}): Promise<OutputStylesBootstrapResult> {
  const loaded = await loadAllOutputStyles(params);
  setCustomOutputStyles(loaded.styles);
  activeStyleName = DEFAULT_STYLE_NAME;
  const settings = await readMergedExtensionSettings(params);

  if (settings.outputStyle) {
    const style = resolveOutputStyle(settings.outputStyle);
    activeStyleName = style?.name ?? DEFAULT_STYLE_NAME;
  }

  return {
    styleCount: getAllOutputStyles().length,
    customCount: loaded.styles.length,
    activeStyle: activeStyleName,
    warnings: loaded.warnings,
  };
}

export function clearOutputStylesForTesting(): void {
  seedBuiltIns();
}
