import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  asString,
  asStringArray,
  fallbackDescription,
  splitFrontmatter,
} from "./frontmatter.js";

export type UserCommandSource = "user" | "project";

export interface UserCommand {
  name: string;
  description: string;
  argumentHint?: string;
  model?: string;
  allowedTools: string[];
  body: string;
  filePath: string;
  source: UserCommandSource;
}

export interface UserCommandsBootstrapResult {
  commandCount: number;
  warnings: string[];
}

const registry = new Map<string, UserCommand>();

function getUserCommandsDir(homeDir = os.homedir()): string {
  return path.join(homeDir, ".kk-agent", "commands");
}

function getProjectCommandsDir(cwd: string): string {
  return path.join(path.resolve(cwd), ".kk-agent", "commands");
}

async function collectMarkdownFiles(dir: string, prefix = ""): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const files: string[] = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...await collectMarkdownFiles(fullPath, relative));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(relative);
    }
  }

  return files;
}

async function loadCommandsFromDir(
  dir: string,
  source: UserCommandSource,
): Promise<{ commands: UserCommand[]; warnings: string[] }> {
  let relPaths: string[] = [];
  try {
    relPaths = await collectMarkdownFiles(dir);
  } catch (error) {
    return {
      commands: [],
      warnings: [`[commands] Failed to read ${dir}: ${error instanceof Error ? error.message : String(error)}`],
    };
  }

  const commands: UserCommand[] = [];
  const warnings: string[] = [];

  for (const relative of relPaths) {
    const filePath = path.join(dir, relative);
    const split = splitFrontmatter(await readFile(filePath, "utf8"));

    if (split.parseError || !split.body.trim()) {
      warnings.push(`[commands] Skipping ${filePath}: ${split.parseError ?? "empty command body"}`);
      continue;
    }

    const name = relative
      .replace(/\.md$/i, "")
      .split(/[\\/]/)
      .join(":");

    commands.push({
      name,
      description: asString(split.raw.description) ??
        fallbackDescription(split.body, `Custom /${name} command`),
      ...(asString(split.raw["argument-hint"] ?? split.raw.argumentHint) && {
        argumentHint: asString(split.raw["argument-hint"] ?? split.raw.argumentHint),
      }),
      ...(asString(split.raw.model) && { model: asString(split.raw.model) }),
      allowedTools: asStringArray(split.raw["allowed-tools"] ?? split.raw.allowedTools),
      body: split.body.trim(),
      filePath,
      source,
    });
  }

  return { commands, warnings };
}

export async function loadAllUserCommands(params: {
  cwd: string;
  homeDir?: string;
}): Promise<{ commands: UserCommand[]; warnings: string[] }> {
  const homeDir = params.homeDir ?? os.homedir();
  const [user, project] = await Promise.all([
    loadCommandsFromDir(getUserCommandsDir(homeDir), "user"),
    loadCommandsFromDir(getProjectCommandsDir(params.cwd), "project"),
  ]);
  const byName = new Map<string, UserCommand>();

  for (const command of [...user.commands, ...project.commands]) {
    byName.set(command.name, command);
  }

  return {
    commands: [...byName.values()],
    warnings: [...user.warnings, ...project.warnings],
  };
}

export async function bootstrapUserCommands(params: {
  cwd: string;
  homeDir?: string;
}): Promise<UserCommandsBootstrapResult> {
  const loaded = await loadAllUserCommands(params);
  setUserCommands(loaded.commands);
  return {
    commandCount: loaded.commands.length,
    warnings: loaded.warnings,
  };
}

export function setUserCommands(commands: UserCommand[]): void {
  registry.clear();
  for (const command of commands) {
    registry.set(command.name, command);
  }
}

export function findUserCommand(name: string): UserCommand | undefined {
  return registry.get(name);
}

export function getAllUserCommands(): UserCommand[] {
  return [...registry.values()];
}

export function clearUserCommandsForTesting(): void {
  registry.clear();
}

export function parseUserCommandArguments(args: string): string[] {
  if (!args.trim()) {
    return [];
  }

  const tokens: string[] = [];
  let current = "";
  let quote: "\"" | "'" | null = null;
  let active = false;

  for (const char of args) {
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "\"" || char === "'") {
      quote = char;
      active = true;
      continue;
    }

    if (/\s/.test(char)) {
      if (active) {
        tokens.push(current);
        current = "";
        active = false;
      }
      continue;
    }

    current += char;
    active = true;
  }

  if (quote) {
    return args.split(/\s+/).filter(Boolean);
  }

  if (active) {
    tokens.push(current);
  }

  return tokens;
}

export function substituteUserCommandArguments(
  template: string,
  args = "",
  appendIfNoPlaceholder = true,
): string {
  const original = template;
  const parsed = parseUserCommandArguments(args);
  let output = template.replace(/\$ARGUMENTS\[(\d+)\]/g, (_match, index) => {
    return parsed[Number(index)] ?? "";
  });

  output = output.replace(/\$(\d+)(?!\w)/g, (_match, index) => {
    return parsed[Number(index) - 1] ?? "";
  });
  output = output.replaceAll("$ARGUMENTS", args);

  if (appendIfNoPlaceholder && output === original && args.trim()) {
    output += `\n\nARGUMENTS: ${args}`;
  }

  return output;
}

export function formatUserCommandsStatus(): string {
  const commands = getAllUserCommands()
    .slice()
    .sort((left, right) => left.name.localeCompare(right.name));

  if (commands.length === 0) {
    return "User Commands (0 available)\n\nNo commands loaded. Add markdown files under ~/.kk-agent/commands or .kk-agent/commands.";
  }

  return [
    `User Commands (${commands.length} available):`,
    "",
    ...commands.map((command) => {
      const args = command.argumentHint ? ` ${command.argumentHint}` : "";
      const model = command.model ? ` model=${command.model}` : "";
      return `  /${command.name}${args}    ${command.description} [${command.source}]${model}`;
    }),
  ].join("\n");
}

export function parseUserSlashCommand(input: string): {
  name: string;
  args: string;
} | null {
  const match = /^\/([a-zA-Z0-9_:-]+)(?:\s+([\s\S]*))?$/.exec(input);

  if (!match) {
    return null;
  }

  return {
    name: match[1] ?? "",
    args: match[2]?.trim() ?? "",
  };
}
