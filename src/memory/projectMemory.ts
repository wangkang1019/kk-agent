import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { getProjectHash } from "../session/transcript.js";

export const MEMORY_DIR_NAME = "memory";
export const MEMORY_ENTRYPOINT = "MEMORY.md";
export const MAX_ENTRYPOINT_LINES = 200;
export const MAX_ENTRYPOINT_BYTES = 25_000;

export type MemoryType = "user" | "feedback" | "project" | "reference";

export interface ProjectMemoryPaths {
  projectKey: string;
  projectDir: string;
  memoryDir: string;
  entrypointPath: string;
}

export interface MemoryCandidate {
  name: string;
  description: string;
  type: MemoryType | string;
  body: string;
}

export interface ProjectMemory {
  filePath: string;
  name: string;
  description: string;
  type: MemoryType;
  body: string;
}

export interface ProjectMemoryParams {
  cwd: string;
  homeDir?: string;
}

export interface SaveMemoryParams extends ProjectMemoryParams {
  memory: MemoryCandidate;
}

const MEMORY_TYPES = new Set<MemoryType>([
  "user",
  "feedback",
  "project",
  "reference",
]);

function defaultHomeDir(): string {
  return path.join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".kk-agent");
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "memory_note"
  );
}

function getMemoryRelativePath(memory: MemoryCandidate): string {
  const fileName = `${slugify(memory.name)}.md`;

  if (memory.type === "project" || memory.type === "reference") {
    return path.join(memory.type, fileName);
  }

  return fileName;
}

function stripHtmlComments(content: string): string {
  return content.replace(/<!--[\s\S]*?-->/g, "").trim();
}

export function getProjectMemoryPaths(
  params: ProjectMemoryParams,
): ProjectMemoryPaths {
  const projectKey = getProjectHash(params.cwd);
  const projectDir = path.join(
    params.homeDir ?? defaultHomeDir(),
    "projects",
    projectKey,
  );
  const memoryDir = path.join(projectDir, MEMORY_DIR_NAME);

  return {
    projectKey,
    projectDir,
    memoryDir,
    entrypointPath: path.join(memoryDir, MEMORY_ENTRYPOINT),
  };
}

export async function ensureMemoryDir(
  params: ProjectMemoryParams,
): Promise<ProjectMemoryPaths> {
  const paths = getProjectMemoryPaths(params);
  await mkdir(paths.memoryDir, { recursive: true });
  return paths;
}

export function shouldStoreAsMemory(candidate: MemoryCandidate): boolean {
  return (
    Boolean(candidate) &&
    MEMORY_TYPES.has(candidate.type as MemoryType) &&
    candidate.name.trim().length > 0 &&
    candidate.description.trim().length > 0 &&
    candidate.description.length <= 200 &&
    candidate.body.trim().length > 0
  );
}

export function buildMemoryFileContent(memory: MemoryCandidate): string {
  return [
    "---",
    `name: ${memory.name}`,
    `description: ${memory.description}`,
    `type: ${memory.type}`,
    "---",
    "",
    memory.body.trim(),
    "",
  ].join("\n");
}

export function parseFrontmatter(
  raw: string,
): Omit<ProjectMemory, "filePath"> | null {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);

  if (!match) {
    return null;
  }

  const fields: Record<string, string> = {};

  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    const index = line.indexOf(":");

    if (index === -1) {
      continue;
    }

    fields[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }

  if (
    !fields.name ||
    !fields.description ||
    !MEMORY_TYPES.has(fields.type as MemoryType)
  ) {
    return null;
  }

  return {
    name: fields.name,
    description: fields.description,
    type: fields.type as MemoryType,
    body: (match[2] ?? "").trim(),
  };
}

export async function writeMemoryFile(
  params: SaveMemoryParams,
): Promise<string> {
  if (!shouldStoreAsMemory(params.memory)) {
    throw new Error("Invalid memory payload.");
  }

  const { memoryDir } = await ensureMemoryDir(params);
  const filePath = path.join(memoryDir, getMemoryRelativePath(params.memory));

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, buildMemoryFileContent(params.memory), "utf8");
  return filePath;
}

export async function readMemoryFile(
  filePath: string,
): Promise<ProjectMemory | null> {
  const raw = await readFile(filePath, "utf8");
  const parsed = parseFrontmatter(stripHtmlComments(raw));

  if (!parsed) {
    return null;
  }

  return {
    filePath,
    ...parsed,
  };
}

export async function listMemoryFiles(
  params: ProjectMemoryParams,
): Promise<string[]> {
  const { memoryDir } = await ensureMemoryDir(params);
  const walk = async (directory: string): Promise<string[]> => {
    const entries = await readdir(directory, { withFileTypes: true });
    const files = await Promise.all(
      entries.map(async (entry) => {
        const entryPath = path.join(directory, entry.name);

        if (entry.isDirectory()) {
          return walk(entryPath);
        }

        if (
          entry.isFile() &&
          entry.name.endsWith(".md") &&
          entry.name !== MEMORY_ENTRYPOINT
        ) {
          return [entryPath];
        }

        return [];
      }),
    );

    return files.flat();
  };

  return walk(memoryDir);
}

export function buildMemoryIndex(
  memories: ProjectMemory[],
  memoryRoot?: string,
): string {
  const lines = ["# Project Memory", ""];

  for (const memory of memories) {
    const fileName = memoryRoot
      ? path.relative(memoryRoot, memory.filePath)
      : path.basename(memory.filePath);
    const normalizedFileName = fileName.split(path.sep).join("/");
    lines.push(`- [${memory.name}](${normalizedFileName}) — ${memory.description}`);
  }

  let limited = lines.slice(0, MAX_ENTRYPOINT_LINES).join("\n").trimEnd();
  let truncated = lines.length > MAX_ENTRYPOINT_LINES;

  if (Buffer.byteLength(limited, "utf8") > MAX_ENTRYPOINT_BYTES) {
    while (
      Buffer.byteLength(`${limited}\n`, "utf8") > MAX_ENTRYPOINT_BYTES &&
      limited.length > 0
    ) {
      limited = limited.slice(0, -1);
    }
    truncated = true;
  }

  if (truncated) {
    const warning = "\n\n<!-- Memory index truncated. Keep MEMORY.md concise. -->";
    const candidate = `${limited}${warning}`;

    if (Buffer.byteLength(candidate, "utf8") <= 25_200) {
      limited = candidate;
    }
  }

  return `${limited.trimEnd()}\n`;
}

export async function rebuildMemoryIndex(
  params: ProjectMemoryParams,
): Promise<string> {
  const paths = await ensureMemoryDir(params);
  const memories = (
    await Promise.all((await listMemoryFiles(params)).map(readMemoryFile))
  ).filter((memory): memory is ProjectMemory => memory !== null);
  const index = buildMemoryIndex(memories, paths.memoryDir);

  await writeFile(paths.entrypointPath, index, "utf8");
  return index;
}

export async function saveMemory(params: SaveMemoryParams): Promise<string> {
  const filePath = await writeMemoryFile(params);
  await rebuildMemoryIndex(params);
  return filePath;
}

export async function readMemoryEntrypoint(
  params: ProjectMemoryParams,
): Promise<string | null> {
  const { entrypointPath } = getProjectMemoryPaths(params);

  try {
    return await readFile(entrypointPath, "utf8");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return null;
    }

    throw error;
  }
}

export async function findRelevantMemories(
  params: ProjectMemoryParams & { query: string; limit?: number },
): Promise<string[]> {
  const queryTerms = params.query
    .toLowerCase()
    .split(/\W+/)
    .filter(Boolean);

  if (queryTerms.length === 0) {
    return [];
  }

  const memories = (
    await Promise.all((await listMemoryFiles(params)).map(readMemoryFile))
  ).filter((memory): memory is ProjectMemory => memory !== null);

  return memories
    .map((memory) => {
      const haystack = [
        memory.name,
        memory.description,
        memory.type,
        memory.body,
      ]
        .join("\n")
        .toLowerCase();
      const score = queryTerms.reduce(
        (total, term) => total + (haystack.includes(term) ? 1 : 0),
        0,
      );

      return { memory, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, params.limit ?? 3)
    .map(({ memory }) =>
      [
        `# ${memory.name}`,
        `Type: ${memory.type}`,
        `Description: ${memory.description}`,
        "",
        memory.body,
      ].join("\n"),
    );
}

export function shouldIgnoreMemory(input: string): boolean {
  const normalized = input.toLowerCase();
  return (
    normalized.includes("忽略记忆") ||
    normalized.includes("不要用记忆") ||
    normalized.includes("不使用记忆") ||
    normalized.includes("ignore memory") ||
    normalized.includes("without memory")
  );
}
