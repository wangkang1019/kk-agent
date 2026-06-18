import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  isProjectTrusted,
  loadSettings,
} from "../config/index.js";
import {
  getSandboxRuntimeStatus,
  loadSandboxSettings,
  normalizeSandboxSettings,
  shouldUseSandbox,
  type SandboxRuntimeStatus,
  type SandboxSettings,
} from "../sandbox/index.js";
import { isReadOnlyShellCommand } from "../tools/bashTool.js";
import type { Tool } from "../tools/Tool.js";

export type PermissionBehavior = "allow" | "ask" | "deny";
export type PermissionMode = "default" | "plan" | "auto";
export type PlanApprovalChoice =
  | "allow_clear_context"
  | "allow_keep_context"
  | "allow_manual_edits"
  | "keep_planning";
export interface PlanApprovalResponse {
  type: "plan_approval";
  choice: PlanApprovalChoice;
  planContent: string;
  feedback?: string;
}

export type PermissionResponse =
  | "allow"
  | "deny"
  | "always_allow"
  | PlanApprovalResponse;

export interface PermissionSettings {
  mode?: PermissionMode;
  allow?: string[];
  deny?: string[];
  sandbox?: SandboxSettings;
  sandboxRuntime?: SandboxRuntimeStatus;
}

export interface PermissionRequest {
  toolName: string;
  input: Record<string, unknown>;
  summary: string;
  risk: string;
  suggestedAllowRule: string;
  planFilePath?: string;
}

export interface PermissionDecision {
  behavior: PermissionBehavior;
  reason: string;
  request: PermissionRequest;
}

export interface PermissionRuntimeContext {
  mode?: PermissionMode;
  settings?: PermissionSettings;
  sessionAllowRules?: string[];
  planFilePath?: string;
  requestPermission?: (
    decision: PermissionDecision,
  ) => Promise<PermissionResponse>;
}

export interface CheckPermissionParams {
  tool: Tool;
  input: Record<string, unknown>;
  mode?: PermissionMode;
  settings?: PermissionSettings;
  sessionAllowRules?: string[];
  planFilePath?: string;
}

export interface LoadPermissionSettingsParams {
  cwd: string;
  homeDir?: string;
}

export function isPlanApprovalResponse(
  response: PermissionResponse | undefined,
): response is PlanApprovalResponse {
  return (
    typeof response === "object" &&
    response !== null &&
    response.type === "plan_approval"
  );
}

const DANGEROUS_SHELL_PREFIXES = [
  "del ",
  "format ",
  "git push",
  "git reset --hard",
  "reboot",
  "remove-item ",
  "rm ",
  "rmdir ",
  "shutdown",
  "sudo ",
];

function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function globToRegExp(glob: string): RegExp {
  const pattern = glob
    .split("*")
    .map(escapeRegExp)
    .join(".*");

  return new RegExp(`^${pattern}$`, "i");
}

function getStringInput(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  return typeof value === "string" ? value : "";
}

function firstWords(command: string, count: number): string {
  return normalizeCommand(command).split(/\s+/).slice(0, count).join(" ");
}

export function isDangerousShellCommand(command = ""): boolean {
  const normalized = normalizeCommand(command).toLowerCase();

  return DANGEROUS_SHELL_PREFIXES.some((prefix) => {
    return normalized === prefix.trim() || normalized.startsWith(prefix);
  });
}

export function summarizePermissionRequest(
  toolName: string,
  input: Record<string, unknown>,
): string {
  if (toolName === "Bash") {
    return `command=${getStringInput(input, "command") || "<empty>"}`;
  }

  return Object.entries(input)
    .slice(0, 3)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(", ");
}

export function suggestedAllowRule(
  toolName: string,
  input: Record<string, unknown>,
): string {
  if (toolName.startsWith("mcp__")) {
    const [, serverName] = toolName.split("__");
    return serverName ? `mcp__${serverName}__*` : toolName;
  }

  if (toolName !== "Bash") {
    return toolName;
  }

  const command = getStringInput(input, "command");
  const first = firstWords(command, 1);

  if (!first) {
    return "Bash(*)";
  }

  if (first.toLowerCase() === "git") {
    const gitAction = firstWords(command, 2);
    return `Bash(${gitAction || "git"}*)`;
  }

  return `Bash(${first} *)`;
}

function riskForTool(
  tool: Tool,
  input: Record<string, unknown>,
): string {
  if (tool.name === "Bash") {
    const command = getStringInput(input, "command");

    if (isDangerousShellCommand(command)) {
      return "High risk: dangerous shell command detected";
    }

    if (isReadOnlyShellCommand(command)) {
      return "Low risk: read-only shell command";
    }

    return "Medium risk: shell command may change local state";
  }

  return tool.isReadOnly()
    ? "Low risk: read-only tool"
    : "Medium risk: tool writes local state";
}

function createRequest(
  tool: Tool,
  input: Record<string, unknown>,
  planFilePath?: string,
): PermissionRequest {
  return {
    toolName: tool.name,
    input,
    summary: summarizePermissionRequest(tool.name, input),
    risk: riskForTool(tool, input),
    suggestedAllowRule: suggestedAllowRule(tool.name, input),
    ...(planFilePath && { planFilePath }),
  };
}

function isPlanModeTransitionTool(toolName: string): boolean {
  return toolName === "EnterPlanMode" || toolName === "ExitPlanMode";
}

function isSessionTaskStateTool(toolName: string): boolean {
  return toolName === "TodoWrite" ||
    toolName === "TaskCreate" ||
    toolName === "TaskUpdate";
}

function isAlwaysAllowedUtilityTool(toolName: string): boolean {
  return toolName === "Skill" ||
    toolName === "Agent" ||
    toolName === "TeamCreate" ||
    toolName === "SendMessage" ||
    toolName === "TeamDelete";
}

function canAutoAllowSandboxedBash(
  settings: PermissionSettings | undefined,
  input: Record<string, unknown>,
): boolean {
  const sandbox = settings?.sandbox;

  if (!sandbox?.enabled || !sandbox.autoAllowBashIfSandboxed) {
    return false;
  }

  const command = getStringInput(input, "command");
  if (!command) {
    return false;
  }

  return shouldUseSandbox(
    {
      command,
      dangerouslyDisableSandbox: input.dangerouslyDisableSandbox === true,
    },
    sandbox,
    settings?.sandboxRuntime ?? getSandboxRuntimeStatus(),
  );
}

export function matchPermissionRule(
  rule: string,
  toolName: string,
  input: Record<string, unknown>,
): boolean {
  if (rule === toolName) {
    return true;
  }

  if (rule.endsWith("*") && rule.startsWith("mcp__")) {
    return toolName.startsWith(rule.slice(0, -1));
  }

  const bashMatch = /^Bash\((.*)\)$/.exec(rule);

  if (!bashMatch || toolName !== "Bash") {
    return false;
  }

  const command = normalizeCommand(getStringInput(input, "command"));
  return globToRegExp(bashMatch[1] ?? "").test(command);
}

function findMatchingRule(
  rules: string[] | undefined,
  toolName: string,
  input: Record<string, unknown>,
): string | undefined {
  return rules?.find((rule) => matchPermissionRule(rule, toolName, input));
}

export async function checkPermission(
  params: CheckPermissionParams,
): Promise<PermissionDecision> {
  const mode = params.mode ?? params.settings?.mode ?? "default";
  const request = createRequest(params.tool, params.input, params.planFilePath);
  const dangerousBash =
    params.tool.name === "Bash" &&
    isDangerousShellCommand(getStringInput(params.input, "command"));
  const denyRule = findMatchingRule(
    params.settings?.deny,
    params.tool.name,
    params.input,
  );
  const sessionAllowRule = findMatchingRule(
    params.sessionAllowRules,
    params.tool.name,
    params.input,
  );
  const allowRule = findMatchingRule(
    params.settings?.allow,
    params.tool.name,
    params.input,
  );

  if (dangerousBash) {
    return { behavior: "deny", reason: "dangerous shell command", request };
  }

  if (isSessionTaskStateTool(params.tool.name)) {
    return {
      behavior: "allow",
      reason: params.tool.name === "TodoWrite"
        ? "TodoWrite writes session-only state"
        : "Task tools write session task state",
      request,
    };
  }

  if (isAlwaysAllowedUtilityTool(params.tool.name)) {
    return {
      behavior: "allow",
      reason: params.tool.name === "Agent"
        ? "Agent delegates isolated subtasks"
        : params.tool.name.startsWith("Team") || params.tool.name === "SendMessage"
          ? "Agent Teams coordinate internal state"
          : `${params.tool.name} loads session instructions`,
      request,
    };
  }

  if (denyRule) {
    return { behavior: "deny", reason: `matched deny rule: ${denyRule}`, request };
  }

  if (mode === "plan") {
    if (params.tool.isReadOnly()) {
      return {
        behavior: "allow",
        reason: "read-only tool allowed in plan mode",
        request,
      };
    }

    if (isPlanModeTransitionTool(params.tool.name)) {
      return {
        behavior: "ask",
        reason: "plan mode transition requires confirmation",
        request,
      };
    }

    if (
      params.tool.name === "Bash" &&
      isReadOnlyShellCommand(getStringInput(params.input, "command"))
    ) {
      return {
        behavior: "allow",
        reason: "read-only shell command allowed in plan mode",
        request,
      };
    }

    if (params.tool.name === "Write" && params.planFilePath) {
      const requestedPath = getStringInput(params.input, "file_path");

      if (
        requestedPath &&
        path.resolve(requestedPath) === path.resolve(params.planFilePath)
      ) {
        return {
          behavior: "allow",
          reason: "writing to the plan file is allowed in plan mode",
          request,
        };
      }
    }

    return {
      behavior: "deny",
      reason: `plan mode blocks ${params.tool.name}`,
      request,
    };
  }

  if (mode === "auto") {
    return { behavior: "allow", reason: "auto mode", request };
  }

  if (sessionAllowRule) {
    return {
      behavior: "allow",
      reason: `matched session allow rule: ${sessionAllowRule}`,
      request,
    };
  }

  if (allowRule) {
    return {
      behavior: "allow",
      reason: `matched allow rule: ${allowRule}`,
      request,
    };
  }

  if (
    params.tool.name === "Bash" &&
    canAutoAllowSandboxedBash(params.settings, params.input)
  ) {
    return {
      behavior: "allow",
      reason: "Bash command will run inside sandbox",
      request,
    };
  }

  if (
    params.tool.name === "Bash" &&
    isReadOnlyShellCommand(getStringInput(params.input, "command"))
  ) {
    return { behavior: "allow", reason: "read-only shell command", request };
  }

  if (params.tool.isReadOnly()) {
    return { behavior: "allow", reason: "read-only tool", request };
  }

  return {
    behavior: "ask",
    reason: "tool writes local state",
    request,
  };
}

async function readSettingsFile(filePath: string): Promise<PermissionSettings> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as PermissionSettings;

    return {
      ...(parsed.mode && { mode: parsed.mode }),
      allow: Array.isArray(parsed.allow) ? parsed.allow : [],
      deny: Array.isArray(parsed.deny) ? parsed.deny : [],
      ...(parsed.sandbox && { sandbox: normalizeSandboxSettings(parsed.sandbox) }),
    };
  } catch {
    return { allow: [], deny: [] };
  }
}

export async function loadPermissionSettings(
  params: LoadPermissionSettingsParams,
): Promise<PermissionSettings> {
  const trusted = await isProjectTrusted({
    cwd: params.cwd,
    homeDir: params.homeDir,
  });
  const unified = await loadSettings({
    cwd: params.cwd,
    homeDir: params.homeDir,
    includeUntrustedProject: trusted,
  });
  const userSettingsPath = path.join(
    params.homeDir ?? os.homedir(),
    ".kk-agent",
    "settings.json",
  );
  const legacyUserSettingsPath = path.join(
    params.homeDir ?? os.homedir(),
    ".agent",
    "settings.json",
  );
  const projectSettingsPath = path.join(
    path.resolve(params.cwd),
    ".kk-agent",
    "settings.json",
  );
  const legacyProjectSettingsPath = path.join(
    path.resolve(params.cwd),
    ".agent",
    "settings.json",
  );
  const [
    legacyUserSettings,
    userSettings,
    legacyProjectSettings,
    projectSettings,
  ] = await Promise.all([
    readSettingsFile(legacyUserSettingsPath),
    readSettingsFile(userSettingsPath),
    readSettingsFile(legacyProjectSettingsPath),
    readSettingsFile(projectSettingsPath),
  ]);
  const ordered = [
    legacyUserSettings,
    userSettings,
    legacyProjectSettings,
    projectSettings,
  ];
  const sandbox = await loadSandboxSettings({
    cwd: params.cwd,
    ...(params.homeDir && { homeDir: params.homeDir }),
  });
  const unifiedAllow = Array.isArray(unified.settings.allow)
    ? unified.settings.allow.filter((item): item is string => typeof item === "string")
    : [];
  const unifiedDeny = Array.isArray(unified.settings.deny)
    ? unified.settings.deny.filter((item): item is string => typeof item === "string")
    : [];
  const unifiedMode =
    unified.settings.mode === "default" ||
    unified.settings.mode === "plan" ||
    unified.settings.mode === "auto"
      ? unified.settings.mode
      : undefined;

  return {
    mode: unifiedMode ??
      projectSettings.mode ??
      legacyProjectSettings.mode ??
      userSettings.mode ??
      legacyUserSettings.mode ??
      "default",
    allow: [...ordered.flatMap((settings) => settings.allow ?? []), ...unifiedAllow],
    deny: [...ordered.flatMap((settings) => settings.deny ?? []), ...unifiedDeny],
    sandbox,
  };
}
