import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  getProjectMemoryPaths,
  readMemoryEntrypoint,
} from "../memory/projectMemory.js";
import { getAllAgents, formatAgentsSystemReminder } from "../agents/index.js";
import { formatSkillsSystemReminder } from "../services/skills/registry.js";
import { formatTeamSystemReminder } from "../teams/index.js";
import {
  renderOutputStyleSection,
  shouldKeepCodingInstructions,
} from "../services/extensions/outputStyles.js";

const execFileAsync = promisify(execFile);

export interface PlatformInfo {
  os: string;
  release: string;
  arch: string;
}

export interface GitInfo {
  available: boolean;
  branch?: string;
  status?: string;
  lastCommit?: string;
}

export interface AgentMemoryFile {
  source: string;
  content: string;
}

export interface BuildSystemPromptParams {
  cwd: string;
  workspaceRoot?: string;
  additionalInstructions?: string;
  now?: Date;
  homeDir?: string;
  includeProjectMemory?: boolean;
  platform?: PlatformInfo;
  git?: (cwd: string) => Promise<GitInfo>;
}

export interface CollectAgentMemoryFilesParams {
  cwd: string;
  workspaceRoot?: string;
  homeDir?: string;
}

const AGENT_MEMORY_FILENAMES = ["AGENT.md"];

const ALWAYS_ON_STATIC_INSTRUCTIONS = [
  "## Identity",
  "You are KK-Agent, a terminal-native agentic coding assistant.",
  "You are not Claude, Claude Code, an Anthropic product, or a fixed model identity. Do not claim to be a specific provider model unless the runtime context explicitly says so.",
  "",
  "## Operating Style",
  "Be warm, direct, practical, and action-oriented. Simple questions should usually get natural prose and a short answer; complex engineering work can use concise structure.",
  "Own mistakes plainly and fix them. Do not collapse into self-blame, over-apologize, or surrender judgment.",
  "",
  "## Context and Memory",
  "Treat the current system prompt, dynamic context, conversation history, tool results, project memory, and active task state as the complete working context for this request.",
  "Do not pretend to remember facts that were not provided in the current context or available project memory.",
  "If the user refers to a file, path, command, session, or configuration, verify it with available tools when accuracy matters instead of assuming it exists.",
  "",
  "## Current Information",
  "If a question depends on current or recently changed facts, use available search, MCP, or local tools before answering. If no suitable tool is available, say what you can and cannot verify.",
  "",
  "## Safety and High-Stakes Boundaries",
  "Be cautious with destructive commands, credentials, private data, malware, exploit development, weapon or explosive construction, illicit drug instructions, and other high-risk requests.",
  "For medical, legal, or financial topics, provide factual orientation and encourage appropriate professional judgment instead of giving definitive professional advice.",
  "When declining or narrowing unsafe requests, stay conversational and offer a safer alternative when possible.",
  "",
  "## Protocol Hygiene",
  "Do not output provider-specific protocol tags, Claude-specific citation markup, voice_note blocks, Artifacts-specific instructions, or other non-KK-Agent protocol text unless the user explicitly asks about those formats.",
];

const CODING_STATIC_INSTRUCTIONS = [
  "## Agentic Coding Behavior",
  "Prefer understanding before changing: inspect the relevant files, existing patterns, and project conventions before making edits.",
  "Prefer specialized tools before Bash. Use Read, Grep, Glob, task tools, Skill, Agent, MCP tools, or other semantic tools when they fit; use Bash when a shell command is genuinely the right interface.",
  "Keep edits focused, reversible, and scoped to the user's request. Avoid unrelated refactors.",
  "After changing files, run the smallest meaningful verification that supports the claim, and report any verification gap.",
  "Treat tool errors and test failures as feedback for the next step rather than as the end of the task.",
  "",
  "## Formatting",
  "Avoid over-formatting. Use headings, bullets, and bold text only when they materially improve clarity.",
  "For technical work, lead with the result, then include the key files changed, verification evidence, and remaining risks when useful.",
];

export function stripHtmlComments(content: string): string {
  return content.replace(/<!--[\s\S]*?-->/g, "").trim();
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readMemoryFile(filePath: string): Promise<AgentMemoryFile | null> {
  if (!(await fileExists(filePath))) {
    return null;
  }

  const raw = await readFile(filePath, "utf8");
  const content = stripHtmlComments(raw);

  if (!content) {
    return null;
  }

  return {
    source: filePath,
    content,
  };
}

function getDirectoryChain(workspaceRoot: string, cwd: string): string[] {
  const resolvedRoot = path.resolve(workspaceRoot);
  const resolvedCwd = path.resolve(cwd);
  const relative = path.relative(resolvedRoot, resolvedCwd);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return [resolvedCwd];
  }

  const dirs = [resolvedRoot];
  let current = resolvedRoot;

  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    dirs.push(current);
  }

  return dirs;
}

export async function collectAgentMemoryFiles(
  params: CollectAgentMemoryFilesParams,
): Promise<AgentMemoryFile[]> {
  const cwd = path.resolve(params.cwd);
  const workspaceRoot = path.resolve(params.workspaceRoot ?? cwd);
  const homeDir = params.homeDir ?? os.homedir();
  const candidates: string[] = [
    path.join(homeDir, ".agent", "AGENT.md"),
  ];

  for (const directory of getDirectoryChain(workspaceRoot, cwd)) {
    for (const filename of AGENT_MEMORY_FILENAMES) {
      candidates.push(path.join(directory, filename));
    }
  }

  const seen = new Set<string>();
  const memoryFiles: AgentMemoryFile[] = [];

  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);

    if (seen.has(resolved)) {
      continue;
    }

    seen.add(resolved);
    const memoryFile = await readMemoryFile(resolved);

    if (memoryFile) {
      memoryFiles.push(memoryFile);
    }
  }

  return memoryFiles;
}

async function getGitValue(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    timeout: 3000,
    windowsHide: true,
  });

  return stdout.trim();
}

export async function getGitInfo(cwd: string): Promise<GitInfo> {
  try {
    const [branch, status, lastCommit] = await Promise.all([
      getGitValue(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
      getGitValue(cwd, ["status", "--short"]),
      getGitValue(cwd, ["log", "-1", "--oneline"]),
    ]);

    return {
      available: true,
      branch,
      status: status || "clean",
      lastCommit,
    };
  } catch {
    return { available: false };
  }
}

function formatGitSection(git: GitInfo): string {
  if (!git.available) {
    return "- Git: not available";
  }

  return [
    `- Git branch: ${git.branch ?? "unknown"}`,
    `- Git status:\n${git.status ?? "unknown"}`,
    `- Recent commit: ${git.lastCommit ?? "unknown"}`,
  ].join("\n");
}

function formatMemorySection(memoryFiles: AgentMemoryFile[]): string {
  if (memoryFiles.length === 0) {
    return "- Agent memory: none found";
  }

  return [
    "## Agent Memory",
    ...memoryFiles.map((memory) => {
      return `# Source: ${memory.source}\n${memory.content}`;
    }),
  ].join("\n\n");
}

async function formatProjectMemorySection(params: {
  cwd: string;
  homeDir?: string;
  includeProjectMemory?: boolean;
}): Promise<string> {
  if (params.includeProjectMemory === false) {
    return "- Project memory: disabled for this turn";
  }

  const paths = getProjectMemoryPaths({
    cwd: params.cwd,
    homeDir: params.homeDir,
  });
  const index = await readMemoryEntrypoint({
    cwd: params.cwd,
    homeDir: params.homeDir,
  });

  if (!index) {
    return [
      "## Project Memory Index",
      `Memory root: ${paths.memoryDir}`,
      "No project memory has been saved yet.",
    ].join("\n");
  }

  return [
    "## Project Memory Index",
    `Memory root: ${paths.memoryDir}`,
    "The index below is a navigation surface. Read specific memory files only when relevant.",
    index.trim(),
  ].join("\n");
}

export async function buildSystemPrompt(
  params: BuildSystemPromptParams,
): Promise<string> {
  const cwd = path.resolve(params.cwd);
  const platform = params.platform ?? {
    os: os.platform(),
    release: os.release(),
    arch: os.arch(),
  };
  const git = await (params.git ?? getGitInfo)(cwd);
  const memoryFiles = await collectAgentMemoryFiles({
    cwd,
    workspaceRoot: params.workspaceRoot ?? cwd,
    homeDir: params.homeDir,
  });
  const projectMemorySection = await formatProjectMemorySection({
    cwd,
    homeDir: params.homeDir,
    includeProjectMemory: params.includeProjectMemory,
  });
  const teamReminder = await formatTeamSystemReminder();
  const keepCodingInstructions = shouldKeepCodingInstructions();

  const staticSection = [
    "<SYSTEM_STATIC_CONTEXT>",
    ...ALWAYS_ON_STATIC_INSTRUCTIONS,
    ...(keepCodingInstructions ? ["", ...CODING_STATIC_INSTRUCTIONS] : []),
    "</SYSTEM_STATIC_CONTEXT>",
  ].join("\n");

  const dynamicParts = [
    renderOutputStyleSection(),
    `- Current working directory: ${cwd}`,
    `- Current date: ${(params.now ?? new Date()).toISOString()}`,
    `- OS: ${platform.os} ${platform.release} (${platform.arch})`,
    formatGitSection(git),
    params.additionalInstructions
      ? `- Session instructions:\n${params.additionalInstructions}`
      : "",
    formatMemorySection(memoryFiles),
    projectMemorySection,
    formatSkillsSystemReminder(),
    formatAgentsSystemReminder(getAllAgents()),
    teamReminder,
  ].filter(Boolean);

  const dynamicSection = [
    "<SYSTEM_DYNAMIC_CONTEXT>",
    ...dynamicParts,
    "</SYSTEM_DYNAMIC_CONTEXT>",
  ].join("\n\n");

  return `${staticSection}\n\n${dynamicSection}`;
}
