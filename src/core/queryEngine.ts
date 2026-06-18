import crypto from "node:crypto";
import path from "node:path";

import { buildSystemPrompt } from "../context/systemPrompt.js";
import {
  buildTokenBudgetSnapshot,
  compactMessages as defaultCompactMessages,
  isAutoCompactCircuitOpen,
  recordAutoCompactFailure,
  recordAutoCompactSuccess,
  resetAutoCompactFailures,
  shouldAutoCompact,
  type CompactMessagesParams,
  type CompactMessagesResult,
  type TokenBudgetSnapshot,
} from "../context/compaction.js";
import {
  getProjectMemoryPaths,
  shouldIgnoreMemory,
} from "../memory/projectMemory.js";
import {
  buildPlanExitAttachment,
  getPlanFilePath,
  getPlanModeAttachment,
  getPlansDirectory,
} from "../context/planMode.js";
import {
  type PermissionDecision,
  type PermissionMode,
  type PermissionResponse,
  type PermissionSettings,
} from "../permissions/permissions.js";
import {
  appendTranscriptEntry,
  createCompactionEntry,
  createFileHistorySnapshotEntry,
  createMessageEntry,
  createSessionId,
  createSystemEntry,
  createToolEventEntry,
  createUsageEntry,
  formatProjectSessionHistory,
  initSessionStorage,
  restoreSession,
} from "../session/transcript.js";
import {
  createFileHistoryStore,
  type FileHistorySnapshot,
  type FileHistoryStore,
} from "../session/fileHistory.js";
import { clearTodos } from "../state/todoStore.js";
import {
  getTaskListId,
  resetTaskList,
} from "../state/taskStore.js";
import {
  getTaskMode,
  setTaskMode,
  type TaskMode,
} from "../state/taskModeStore.js";
import {
  getAllAsyncAgents,
  killAsyncAgent,
} from "../state/asyncAgentStore.js";
import { drainPendingNotifications } from "../state/notificationStore.js";
import { getActiveTeam } from "../state/teamContext.js";
import {
  getMcpRegistry,
  getMcpRegistryEntry,
  reconnectMcpServer,
} from "../services/mcp/index.js";
import {
  findSkill,
  getAllUserInvocableSkills,
  getModelVisibleSkills,
} from "../services/skills/registry.js";
import { getAllAgents } from "../agents/index.js";
import {
  getInboxPath,
  isAgentTeamsEnabled,
  readTeamFile,
} from "../teams/index.js";
import {
  getSandboxRuntimeStatus,
  loadSandboxSettings,
} from "../sandbox/index.js";
import {
  formatConfigValue,
  getPathValue,
  getProjectTrustInfo,
  isProjectTrusted,
  loadSettings,
  parseConfigValue,
  trustProject,
  writeSetting,
  type SettingWriteScope,
} from "../config/index.js";
import {
  formatHookContextMessage,
  formatHooksStatus,
  runSessionStartHooks,
  runUserPromptSubmitHooks,
} from "../hooks/index.js";
import { getUserFacingErrorMessage } from "../services/api/errors.js";
import {
  findUserCommand,
  formatUserCommandsStatus,
  parseUserSlashCommand,
  substituteUserCommandArguments,
} from "../services/extensions/userCommands.js";
import {
  formatOutputStylesStatus,
  setActiveOutputStyle,
} from "../services/extensions/outputStyles.js";
import type { Message, Usage } from "../types/message.js";
import { getToolsApiParams } from "../tools/registry.js";
import {
  buildSkillInvocationText,
  SKILL_NAME_RE,
} from "../tools/skillTool.js";
import {
  query as runAgenticLoop,
  type QueryEvent,
  type QueryParams,
  type QueryResult,
} from "./agenticLoop.js";

export interface QueryEngineParams {
  model: string;
  cwd: string;
  initialMessages?: Message[];
  initialUsage?: Usage;
  session?: {
    enabled: boolean;
    sessionId?: string;
    startedAt?: string;
    homeDir?: string;
    alreadyInitialized?: boolean;
    fileHistorySnapshots?: FileHistorySnapshot[];
  };
  permissionMode?: PermissionMode;
  permissionSettings?: PermissionSettings;
  requestPermission?: (
    decision: PermissionDecision,
  ) => Promise<PermissionResponse>;
  compactMessages?: (
    messages: Message[],
    params: CompactMessagesParams,
  ) => Promise<CompactMessagesResult>;
  query?: (
    params: QueryParams,
  ) => AsyncGenerator<QueryEvent, QueryResult>;
}

export interface QueryEngineResult {
  handled: boolean;
  terminationReason?: QueryResult["terminationReason"];
  errorMessage?: string;
}

export type QueryEngineEvent =
  | QueryEvent
  | {
      type: "messages_updated";
      messages: Message[];
    }
  | {
      type: "usage_updated";
      totalUsage: Usage;
      turnUsage: Usage;
    }
  | {
      type: "context_budget_updated";
      snapshot: TokenBudgetSnapshot;
    }
  | {
      type: "compaction_started";
      trigger: "manual" | "auto";
    }
  | {
      type: "compaction_finished";
      trigger: "manual" | "auto";
      beforeMessageCount: number;
      afterMessageCount: number;
      beforeTokens: number;
      afterTokens: number;
      didFullCompact: boolean;
      didMicroCompact: boolean;
    }
  | {
      type: "command";
      kind: "info" | "error";
      message: string;
    };

function emptyUsage(): Usage {
  return { input_tokens: 0, output_tokens: 0 };
}

function addUsage(left: Usage, right: Usage): Usage {
  return {
    input_tokens: left.input_tokens + right.input_tokens,
    output_tokens: left.output_tokens + right.output_tokens,
  };
}

function cloneMessages(messages: Message[]): Message[] {
  return [...messages];
}

function messagesEqual(left: Message[], right: Message[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function parsePositiveInteger(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function describeMcpConnection(entry: ReturnType<typeof getMcpRegistry>[number]): string {
  const { connection, tools } = entry;
  const toolCount = `${tools.length} tool${tools.length === 1 ? "" : "s"}`;

  if (connection.type === "pending") {
    const elapsed = Math.max(0, Math.round((Date.now() - connection.startedAt) / 1000));
    return `… ${connection.name}    connecting  (${elapsed}s elapsed; ${describeMcpConfig(connection.config)})`;
  }

  if (connection.type === "connected") {
    return `✓ ${connection.name}    connected   ${toolCount}   (${describeMcpConfig(connection.config)})`;
  }

  if (connection.type === "failed") {
    return `✗ ${connection.name}    failed      ${connection.error}`;
  }

  return `- ${connection.name}    disabled    (${describeMcpConfig(connection.config)})`;
}

function describeMcpConfig(
  config: ReturnType<typeof getMcpRegistry>[number]["connection"]["config"],
): string {
  if (config.type === "http" || config.type === "sse") {
    return `${config.type}: ${config.url}`;
  }

  return `stdio: ${config.command} ${(config.args ?? []).join(" ")}`.trim();
}

function formatMcpStatus(): string {
  const entries = getMcpRegistry();

  if (entries.length === 0) {
    return "MCP Servers (0 configured)\n\nNo MCP servers configured.";
  }

  return [
    `MCP Servers (${entries.length} configured)`,
    "",
    ...entries.map(describeMcpConnection),
    "",
    "Subcommands: /mcp tools <name> | /mcp reconnect <name>",
  ].join("\n");
}

function formatMcpTools(name: string): string {
  const entry = getMcpRegistryEntry(name);

  if (!entry) {
    return `Unknown MCP server: ${name}`;
  }

  if (entry.tools.length === 0) {
    return `${name} (0 tools)`;
  }

  return [
    `${name} (${entry.tools.length} tools):`,
    ...entry.tools.map((tool) => `  ${tool.name}    ${tool.description}`),
  ].join("\n");
}

function formatSkillsStatus(): string {
  const skills = getAllUserInvocableSkills();
  const modelVisibleNames = new Set(getModelVisibleSkills().map((skill) => skill.name));

  if (skills.length === 0) {
    return "Skills (0 available)\n\nNo skills loaded. Add SKILL.md files under ~/.kk-agent/skills or .kk-agent/skills.";
  }

  return [
    `Skills (${skills.length} available, ${modelVisibleNames.size} model-visible):`,
    "",
    ...skills
      .slice()
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((skill) => {
        const visibility = modelVisibleNames.has(skill.name) ? "visible" : "conditional";
        const args = skill.frontmatter.argumentHint ? ` ${skill.frontmatter.argumentHint}` : "";
        return `  /${skill.name}${args}    ${visibility}    ${skill.description}`;
      }),
  ].join("\n");
}

function formatAgentsStatus(): string {
  const agents = getAllAgents();

  if (agents.length === 0) {
    return "Agents (0 loaded)\n\nNo SubAgents loaded.";
  }

  const lines = agents
    .slice()
    .sort((left, right) => {
      if (left.source === "built-in" && right.source !== "built-in") {
        return -1;
      }
      if (left.source !== "built-in" && right.source === "built-in") {
        return 1;
      }
      return left.agentType.localeCompare(right.agentType);
    })
    .map((agent) => {
      const details = [
        agent.tools?.length ? `tools: ${agent.tools.join(",")}` : "",
        agent.disallowedTools?.length ? `disallowed: ${agent.disallowedTools.join(",")}` : "",
        agent.model ? `model: ${agent.model}` : "",
        agent.maxTurns ? `maxTurns: ${agent.maxTurns}` : "",
        agent.isolation ? `isolation: ${agent.isolation}` : "",
      ].filter(Boolean);
      return `  ${agent.agentType} [${agent.source}]    ${agent.whenToUse}${details.length ? ` (${details.join("; ")})` : ""}`;
    });

  return [
    `Agents (${agents.length} loaded):`,
    "",
    ...lines,
    "",
    "Custom: add ~/.kk-agent/agents/<name>.md or .kk-agent/agents/<name>.md",
    "Jobs: /agents jobs | /agents kill <agent_id>",
  ].join("\n");
}

function formatAsyncAgentJobs(): string {
  const agents = getAllAsyncAgents();

  if (agents.length === 0) {
    return "Background agents (0)\n\nNo background agents have been launched.";
  }

  return [
    `Background agents (${agents.length})`,
    "",
    ...agents.map((agent) => {
      const details = [
        `${agent.agentId}`,
        agent.status,
        `type=${agent.agentType}`,
        agent.description ? `task=${agent.description}` : "",
        `tools=${agent.toolUseCount}`,
        `tokens=${agent.totalTokens}`,
        agent.lastToolName ? `last=${agent.lastToolName}` : "",
        agent.outputFile ? `output=${agent.outputFile}` : "",
        agent.worktreePath ? `worktree=${agent.worktreePath}` : "",
      ].filter(Boolean);

      return `- ${details.join(" | ")}`;
    }),
  ].join("\n");
}

async function formatTeamsStatus(): Promise<string> {
  const enabled = isAgentTeamsEnabled();
  const active = getActiveTeam();

  if (!enabled) {
    return [
      "Agent Teams",
      "",
      "enabled: false",
      "Start with --agent-teams or set KK_AGENT_TEAMS=1 to expose TeamCreate, SendMessage, and TeamDelete.",
    ].join("\n");
  }

  if (!active) {
    return [
      "Agent Teams",
      "",
      "enabled: true",
      "active team: none",
      "Use TeamCreate to create a team.",
    ].join("\n");
  }

  const file = await readTeamFile(active.teamName);
  const members = file?.members ?? [];

  return [
    "Agent Teams",
    "",
    "enabled: true",
    `active team: ${active.teamName}`,
    `team file: ${active.teamFilePath}`,
    file?.description ? `description: ${file.description}` : "",
    "",
    "Members:",
    ...(members.length > 0
      ? members.map((member) => {
        return [
          `- ${member.name}`,
          member.isActive ? "active" : "idle",
          member.agentType ? `type=${member.agentType}` : "",
          member.outputFile ? `output=${member.outputFile}` : "",
          `inbox=${getInboxPath(member.name, active.teamName)}`,
        ].filter(Boolean).join(" | ");
      })
      : ["- (none)"]),
  ].filter(Boolean).join("\n");
}

async function formatSandboxStatus(cwd: string): Promise<string> {
  const settings = await loadSandboxSettings({ cwd });
  const runtime = getSandboxRuntimeStatus();

  return [
    "Sandbox",
    "",
    `enabled: ${settings.enabled}`,
    `runtime: ${runtime.kind} (${runtime.available ? "available" : "unavailable"})`,
    ...(runtime.reason ? [`reason: ${runtime.reason}`] : []),
    `autoAllowBashIfSandboxed: ${settings.autoAllowBashIfSandboxed}`,
    `allowUnsandboxedCommands: ${settings.allowUnsandboxedCommands}`,
    `excludedCommands: ${settings.excludedCommands.length > 0 ? settings.excludedCommands.join(", ") : "(none)"}`,
  ].join("\n");
}

async function formatConfigList(cwd: string, homeDir?: string): Promise<string> {
  const trusted = await isProjectTrusted({ cwd, homeDir });
  const loaded = await loadSettings({ cwd, homeDir, includeUntrustedProject: trusted });
  const entries = Object.entries(loaded.settings)
    .sort(([left], [right]) => left.localeCompare(right));

  if (entries.length === 0) {
    return "Config\n\nNo settings found.";
  }

  return [
    "Config",
    "",
    `project trusted: ${trusted}`,
    "",
    ...entries.map(([key, value]) => {
      const source = loaded.origins[key] ?? "unknown";
      return `${key} = ${formatConfigValue(value)} [${source}]`;
    }),
    ...(loaded.warnings.length > 0
      ? ["", "Warnings:", ...loaded.warnings.map((warning) => `- ${warning}`)]
      : []),
  ].join("\n");
}

async function formatConfigSources(cwd: string, homeDir?: string): Promise<string> {
  const trusted = await isProjectTrusted({ cwd, homeDir });
  const loaded = await loadSettings({ cwd, homeDir, includeUntrustedProject: trusted });
  const trust = await getProjectTrustInfo({ cwd, homeDir });

  return [
    "Config sources",
    "",
    `trust key: ${trust.key}`,
    `project trusted: ${trusted}`,
    `risky project config: ${trust.hasRiskyConfig}`,
    ...(trust.riskyItems.length > 0
      ? ["risk items:", ...trust.riskyItems.map((item) => `- ${item}`)]
      : []),
    "",
    ...loaded.sources.map((source) => {
      const location = source.path ?? "(flags)";
      const status = source.exists ? "present" : "missing";
      const warningCount =
        (source.parseError ? 1 : 0) + source.validationErrors.length;
      return `${source.source}: ${status} ${location}${warningCount ? ` (${warningCount} warning${warningCount === 1 ? "" : "s"})` : ""}`;
    }),
    ...(loaded.warnings.length > 0
      ? ["", "Warnings:", ...loaded.warnings.map((warning) => `- ${warning}`)]
      : []),
  ].join("\n");
}

async function handleConfigCommandText(cwd: string, command: string, homeDir?: string): Promise<{
  kind: "info" | "error";
  message: string;
}> {
  const args = command.slice("/config".length).trim().split(/\s+/).filter(Boolean);
  const subcommand = args[0] ?? "list";

  if (subcommand === "list") {
    return { kind: "info", message: await formatConfigList(cwd, homeDir) };
  }

  if (subcommand === "sources") {
    return { kind: "info", message: await formatConfigSources(cwd, homeDir) };
  }

  if (subcommand === "trust") {
    const key = await trustProject({ cwd, homeDir });
    return { kind: "info", message: `Trusted project: ${key}` };
  }

  if (subcommand === "get") {
    const key = args[1];
    if (!key) {
      return { kind: "error", message: "Usage: /config get <key>" };
    }
    const trusted = await isProjectTrusted({ cwd, homeDir });
    const loaded = await loadSettings({ cwd, homeDir, includeUntrustedProject: trusted });
    const value = getPathValue(loaded.settings, key);
    const topLevelKey = key.split(".")[0] ?? key;
    return {
      kind: "info",
      message: `${key} = ${formatConfigValue(value)} [${loaded.origins[topLevelKey] ?? "unset"}]`,
    };
  }

  if (subcommand === "set") {
    const key = args[1];
    const rawValue = args[2];
    if (!key || rawValue === undefined) {
      return {
        kind: "error",
        message: "Usage: /config set <key> <json|string> [--user|--project|--local]",
      };
    }
    const scope: SettingWriteScope = args.includes("--project")
      ? "project"
      : args.includes("--local")
        ? "local"
        : "user";
    await writeSetting({
      cwd,
      homeDir,
      scope,
      key,
      value: parseConfigValue(rawValue),
    });
    return {
      kind: "info",
      message: `Config set: ${key} [${scope}]`,
    };
  }

  return {
    kind: "error",
    message: "Usage: /config list|sources|trust|get <key>|set <key> <json|string> [--user|--project|--local]",
  };
}

function parseSkillSlashCommand(input: string): {
  name: string;
  args: string;
} | null {
  const match = /^\/([a-zA-Z0-9_-]+)(?:\s+([\s\S]*))?$/.exec(input);

  if (!match) {
    return null;
  }

  return {
    name: match[1] ?? "",
    args: match[2]?.trim() ?? "",
  };
}

export class QueryEngine {
  private messages: Message[] = [];
  private totalUsage: Usage = emptyUsage();
  private sessionId: string;
  private sessionStartedAt: string;
  private readonly sessionHomeDir?: string;
  private readonly shouldPersistSession: boolean;
  private sessionInitialized = false;
  private readonly defaultModel: string;
  private sessionModelOverride: string | null = null;
  private abortController: AbortController | null = null;
  private readonly cwd: string;
  private currentPermissionMode: PermissionMode;
  private prePlanMode: PermissionMode | null = null;
  private needsPlanModeExitAttachment = false;
  private readonly permissionSettings?: PermissionSettings;
  private readonly requestPermission?: (
    decision: PermissionDecision,
  ) => Promise<PermissionResponse>;
  private readonly query: (
    params: QueryParams,
  ) => AsyncGenerator<QueryEvent, QueryResult>;
  private readonly compactMessages: (
    messages: Message[],
    params: CompactMessagesParams,
  ) => Promise<CompactMessagesResult>;
  private readonly sessionAllowRules: string[] = [];
  private lastCallUsage: Usage | null = null;
  private usageAnchorIndex = -1;
  private sessionStartHookFired = false;
  private oneTurnModelOverride: string | null = null;
  private fileHistory: FileHistoryStore;

  constructor(params: QueryEngineParams) {
    this.messages = cloneMessages(params.initialMessages ?? []);
    this.totalUsage = { ...(params.initialUsage ?? emptyUsage()) };
    this.defaultModel = params.model;
    this.cwd = params.cwd;
    this.sessionId = params.session?.sessionId ?? createSessionId();
    this.sessionStartedAt = params.session?.startedAt ?? new Date().toISOString();
    this.sessionHomeDir = params.session?.homeDir;
    this.shouldPersistSession = params.session?.enabled ?? false;
    this.sessionInitialized = params.session?.alreadyInitialized ?? false;
    this.currentPermissionMode =
      params.permissionMode ?? params.permissionSettings?.mode ?? "default";
    this.permissionSettings = params.permissionSettings;
    this.requestPermission = params.requestPermission;
    this.query = params.query ?? runAgenticLoop;
    this.compactMessages = params.compactMessages ?? ((messages, compactParams) => {
      return defaultCompactMessages(messages, compactParams);
    });
    this.fileHistory = this.createFileHistory();
    if (params.session?.fileHistorySnapshots) {
      this.fileHistory.restoreSnapshots(params.session.fileHistorySnapshots);
    }
    resetAutoCompactFailures();
  }

  getActiveModel(): string {
    return this.sessionModelOverride ?? this.defaultModel;
  }

  private getModelForCurrentTurn(): string {
    return this.oneTurnModelOverride ?? this.getActiveModel();
  }

  getMessages(): Message[] {
    return cloneMessages(this.messages);
  }

  getTotalUsage(): Usage {
    return { ...this.totalUsage };
  }

  getPermissionMode(): PermissionMode {
    return this.currentPermissionMode;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  private createFileHistory(): FileHistoryStore {
    return createFileHistoryStore({
      cwd: this.cwd,
      homeDir: this.sessionHomeDir,
      sessionId: this.sessionId,
      onSnapshot: async (snapshot) => {
        if (!this.shouldPersistSession) {
          return;
        }

        await this.ensureSessionInitialized();
        await appendTranscriptEntry({
          cwd: this.cwd,
          homeDir: this.sessionHomeDir,
          sessionId: this.sessionId,
          entry: createFileHistorySnapshotEntry({ snapshot }),
        });
      },
    });
  }

  private async isCheckpointingEnabled(): Promise<boolean> {
    if (process.env.KK_AGENT_DISABLE_CHECKPOINTING === "1") {
      return false;
    }

    const loaded = await loadSettings({ cwd: this.cwd, homeDir: this.sessionHomeDir });
    return getPathValue(loaded.settings, "checkpointingEnabled") !== false;
  }

  clearContextAndImplement(planContent: string): string {
    this.messages = [];
    this.lastCallUsage = null;
    this.usageAnchorIndex = -1;
    return `Implement the following plan:\n\n${planContent}`;
  }

  revisePlanWithFeedback(feedback: string): string {
    this.setPermissionMode("plan");
    return [
      "User rejected the plan.",
      `Feedback: ${feedback}`,
      "Please revise the plan and call ExitPlanMode again when ready.",
    ].join("\n");
  }

  interrupt(): boolean {
    if (!this.abortController) {
      return false;
    }

    this.abortController.abort();
    this.abortController = null;
    return true;
  }

  async *submitMessage(
    input: string,
  ): AsyncGenerator<QueryEngineEvent, QueryEngineResult> {
    const text = input.trim();

    if (!text) {
      return { handled: false };
    }

    if (text.startsWith("/") && this.isBuiltInCommand(text)) {
      return yield* this.handleCommand(text);
    }

    const currentMessageId = crypto.randomUUID();
    this.abortController = new AbortController();
    const abortController = this.abortController;
    const newMessages: Message[] = [];
    if (!this.sessionStartHookFired) {
      this.sessionStartHookFired = true;
      const sessionOutcome = await runSessionStartHooks({
        source: "startup",
        cwd: this.cwd,
        homeDir: this.sessionHomeDir,
        sessionId: this.sessionId,
        signal: abortController.signal,
      });
      const sessionContext = sessionOutcome.additionalContext ??
        sessionOutcome.systemMessage ??
        sessionOutcome.blockingError;

      if (sessionContext) {
        newMessages.push({
          role: "user",
          content: formatHookContextMessage("SessionStart", sessionContext),
        });
      }
    }

    const notifications = drainPendingNotifications();
    const planFilePath = this.getPlanFilePath();

    for (const notification of notifications) {
      newMessages.push({ role: "user", content: notification.text });
    }

    if (this.needsPlanModeExitAttachment) {
      newMessages.push(buildPlanExitAttachment(planFilePath));
      this.needsPlanModeExitAttachment = false;
    }

    if (this.currentPermissionMode === "plan") {
      const attachment = getPlanModeAttachment(this.messages, planFilePath);

      if (attachment) {
        newMessages.push(attachment);
      }
    }

    if (text.startsWith("/")) {
      const expanded = this.expandUserSlashCommand(text);

      if (!expanded.ok) {
        const event = {
          type: "command",
          kind: "error",
          message: expanded.message,
        } as const;
        yield event;
        await this.persistSystem(event.kind, event.message);
        return { handled: true };
      }

      newMessages.push(...expanded.messages);
      this.oneTurnModelOverride = expanded.model ?? null;
    } else {
      this.oneTurnModelOverride = null;
      const promptOutcome = await runUserPromptSubmitHooks({
        prompt: text,
        cwd: this.cwd,
        homeDir: this.sessionHomeDir,
        sessionId: this.sessionId,
        signal: abortController.signal,
      });
      const promptContext = promptOutcome.additionalContext ??
        promptOutcome.systemMessage ??
        promptOutcome.blockingError;

      if (promptContext) {
        newMessages.push({
          role: "user",
          content: formatHookContextMessage("UserPromptSubmit", promptContext),
        });
      }

      const userMessage: Message = { role: "user", content: text };
      newMessages.push(userMessage);
    }

    if (await this.isCheckpointingEnabled()) {
      await this.fileHistory.makeSnapshot(currentMessageId, text);
    }

    await this.ensureSessionInitialized();

    for (const message of newMessages) {
      await this.persistMessage(message);
    }

    this.messages = [...this.messages, ...newMessages];
    yield { type: "messages_updated", messages: this.getMessages() };

    const budget = buildTokenBudgetSnapshot(this.messages, {
      ...(this.lastCallUsage && { usage: this.lastCallUsage }),
      usageAnchorIndex: this.usageAnchorIndex,
      model: this.getActiveModel(),
    });
    yield { type: "context_budget_updated", snapshot: budget };
    const expectsFullAutoCompaction =
      budget.estimatedConversationTokens >= budget.autoCompactThreshold;
    if (expectsFullAutoCompaction) {
      yield {
        type: "compaction_started",
        trigger: "auto",
      };
    }
    const compacted = await this.compactForModel({
      trigger: "auto",
      force: false,
      model: this.getActiveModel(),
      signal: abortController.signal,
    });

    if (compacted) {
      if (compacted.didFullCompact && !expectsFullAutoCompaction) {
        yield {
          type: "compaction_started",
          trigger: "auto",
        };
      }
      this.messages = compacted.messages;
      this.invalidateUsageAnchor();
      await this.persistCompaction(compacted, "auto");
      yield { type: "messages_updated", messages: this.getMessages() };
      yield {
        type: "compaction_finished",
        trigger: "auto",
        beforeMessageCount: compacted.beforeMessageCount,
        afterMessageCount: compacted.afterMessageCount,
        beforeTokens: compacted.beforeTokens,
        afterTokens: compacted.afterTokens,
        didFullCompact: compacted.didFullCompact,
        didMicroCompact: compacted.didMicroCompact,
      };
    }

    const system = await buildSystemPrompt({
      cwd: this.cwd,
      includeProjectMemory: !shouldIgnoreMemory(text),
    });
    const memoryPaths = getProjectMemoryPaths({ cwd: this.cwd });
    const settings = await loadSettings({
      cwd: this.cwd,
      homeDir: this.sessionHomeDir,
    });
    const maxApiRetries = parsePositiveInteger(
      getPathValue(settings.settings, "maxApiRetries"),
    );
    const loop = this.query({
      messages: this.getMessages(),
      model: this.getModelForCurrentTurn(),
      system,
      cwd: this.cwd,
      homeDir: this.sessionHomeDir,
      signal: abortController.signal,
      permissionMode: this.currentPermissionMode,
      permissionSettings: this.permissionSettings,
      sessionAllowRules: this.sessionAllowRules,
      requestPermission: this.requestPermission,
      allowedRoots: [memoryPaths.memoryDir, getPlansDirectory(this.sessionHomeDir)],
      planFilePath,
      planHomeDir: this.sessionHomeDir,
      planSessionId: this.sessionId,
      sessionId: this.sessionId,
      currentMessageId,
      fileHistory: this.fileHistory,
      getTools: () => getToolsApiParams(this.currentPermissionMode),
      getPermissionMode: () => this.currentPermissionMode,
      setPermissionMode: (mode) => this.setPermissionMode(mode),
      addSessionAllowRules: (rules) => this.addSessionAllowRules(rules),
      querySource: "foreground",
      ...(maxApiRetries !== undefined && { maxRetries: maxApiRetries }),
      compactMessages: async (messages, compactParams) => {
        const compacted = await this.compactMessages(messages, {
          ...compactParams,
          model: compactParams.model ?? this.getActiveModel(),
        });
        if (compacted.didFullCompact) {
          this.invalidateUsageAnchor();
          await this.persistCompaction(compacted, "auto");
        }
        return compacted;
      },
    });

    while (true) {
      const { value, done } = await loop.next();

      if (done) {
        this.abortController = null;
        this.oneTurnModelOverride = null;
        const returnedMessages = cloneMessages(value.messages);
        const messagesChangedOutsideEvents = !messagesEqual(
          this.messages,
          returnedMessages,
        );
        this.messages = cloneMessages(value.messages);
        this.totalUsage = addUsage(this.totalUsage, value.usage);
        this.lastCallUsage = { ...value.usage };
        this.usageAnchorIndex = this.messages.length - 1;
        if (
          value.terminationReason === "prompt_too_long_after_compact" ||
          messagesChangedOutsideEvents
        ) {
          this.invalidateUsageAnchor();
        }
        if (messagesChangedOutsideEvents) {
          yield { type: "messages_updated", messages: this.getMessages() };
        }
        await this.persistUsage(value.usage);
        yield {
          type: "usage_updated",
          totalUsage: this.getTotalUsage(),
          turnUsage: { ...value.usage },
        };
        const errorMessage = value.error
          ? getUserFacingErrorMessage(value.error, this.getActiveModel())
          : undefined;

        if (errorMessage && value.terminationReason !== "aborted") {
          await this.persistSystem("error", errorMessage);
        }

        return {
          handled: true,
          terminationReason: value.terminationReason,
          ...(errorMessage && { errorMessage }),
        };
      }

      yield value;

      if (
        value.type === "assistant_message" ||
        value.type === "tool_result_message"
      ) {
        this.messages = [...this.messages, value.message];
        await this.persistMessage(value.message);
        yield { type: "messages_updated", messages: this.getMessages() };
      } else if (value.type === "tool_use_start") {
        await this.persistToolEvent({
          name: value.name,
          phase: "start",
        });
      } else if (value.type === "tool_use_done") {
        await this.persistToolEvent({
          name: value.name,
          phase: "done",
          resultLength: value.resultLength,
          isError: value.isError,
        });
      }
    }
  }

  private async handleRewindCommand(
    command: string,
  ): Promise<Extract<QueryEngineEvent, { type: "command" }>> {
    if (!(await this.isCheckpointingEnabled())) {
      return {
        type: "command",
        kind: "info",
        message: "File history is disabled.",
      };
    }

    const args = command.slice("/rewind".length).trim().split(/\s+/).filter(Boolean);

    if (args[0] === "list") {
      return this.formatRewindList();
    }

    const isPreview = args[0] === "preview";
    const rawOffset = isPreview ? args[1] : args[0];
    const offset = rawOffset === undefined ? 1 : Number(rawOffset);

    if (!Number.isInteger(offset) || offset < 1) {
      return {
        type: "command",
        kind: "error",
        message: "Invalid rewind step count. Usage: /rewind [n] or /rewind preview [n]",
      };
    }

    const total = this.fileHistory.snapshotCount();

    if (total === 0) {
      return {
        type: "command",
        kind: "info",
        message: "No file history snapshots yet.",
      };
    }

    const snapshot = this.fileHistory.getSnapshotByOffset(offset);

    if (!snapshot) {
      return {
        type: "command",
        kind: "error",
        message: `Cannot rewind ${offset} turn(s): only ${total} snapshot(s) available.`,
      };
    }

    const stats = await this.fileHistory.getDiffStats(snapshot.messageId);
    const relativeFiles = stats.filesChanged.map((filePath) => this.relativeToCwd(filePath));
    const suffix = relativeFiles.length > 0
      ? `\n${relativeFiles.map((filePath) => `  ${filePath}`).join("\n")}`
      : "";

    if (isPreview) {
      const preview = await this.fileHistory.getDiffPreview(snapshot.messageId);
      const previewText = this.formatDiffPreview(preview.files);
      return {
        type: "command",
        kind: "info",
        message: `Rewind preview ${offset} turn(s): ${relativeFiles.length} file(s), +${stats.insertions} -${stats.deletions}${suffix}${previewText}`,
      };
    }

    const changed = await this.fileHistory.rewind(snapshot.messageId);

    if (changed.length === 0) {
      return {
        type: "command",
        kind: "info",
        message: "Already at that state - no files changed.",
      };
    }

    return {
      type: "command",
      kind: "info",
      message: `Rewound ${offset} turn(s). Restored ${changed.length} file(s) (+${stats.insertions} -${stats.deletions})${suffix}`,
    };
  }

  private formatRewindList(): Extract<QueryEngineEvent, { type: "command" }> {
    const snapshots = this.fileHistory.listSnapshots();

    if (snapshots.length === 0) {
      return {
        type: "command",
        kind: "info",
        message: "No file history snapshots yet.",
      };
    }

    const lines = [...snapshots]
      .reverse()
      .slice(0, 20)
      .map((snapshot, index) => {
        const offset = index + 1;
        const prompt = snapshot.prompt?.replace(/\s+/g, " ").trim() ||
          `(turn at ${snapshot.timestamp})`;
        const shortPrompt = prompt.length > 80 ? `${prompt.slice(0, 77)}...` : prompt;
        return `preview ${offset}: ${shortPrompt}`;
      });

    return {
      type: "command",
      kind: "info",
      message: ["Rewind snapshots:", ...lines].join("\n"),
    };
  }

  private relativeToCwd(filePath: string): string {
    const relative = path.relative(this.cwd, filePath);
    return relative && !relative.startsWith("..") && !path.isAbsolute(relative)
      ? relative
      : filePath;
  }

  private formatDiffPreview(
    files: Array<{ filePath: string; lines: string[]; truncated: boolean }>,
  ): string {
    if (files.length === 0) {
      return "";
    }

    const lines = ["", "Diff preview:"];

    for (const file of files) {
      lines.push(this.relativeToCwd(file.filePath));
      lines.push(...file.lines.map((line) => `  ${line}`));
      if (file.truncated) {
        lines.push("  ... truncated ...");
      }
    }

    return lines.join("\n");
  }

  private async *handleCommand(
    command: string,
  ): AsyncGenerator<QueryEngineEvent, QueryEngineResult> {
    if (command === "/clear") {
      this.messages = [];
      this.totalUsage = emptyUsage();
      this.lastCallUsage = null;
      this.usageAnchorIndex = -1;
      clearTodos(this.sessionId);
      yield { type: "messages_updated", messages: [] };
      const event = {
        type: "command",
        kind: "info",
        message: "Conversation cleared.",
      } as const;
      yield event;
      await this.persistSystem(event.kind, event.message);
      return { handled: true };
    }

    if (command === "/cost") {
      const event = {
        type: "command",
        kind: "info",
        message: `Input=${this.totalUsage.input_tokens}, Output=${this.totalUsage.output_tokens}`,
      } as const;
      yield event;
      await this.persistSystem(event.kind, event.message);
      return { handled: true };
    }

    if (command === "/history") {
      const message = this.shouldPersistSession
        ? await formatProjectSessionHistory({
            cwd: this.cwd,
            homeDir: this.sessionHomeDir,
          })
        : `${this.messages.length} messages in conversation.`;
      const event = {
        type: "command",
        kind: "info",
        message: this.shouldPersistSession
          ? `${message}\n\nUse /resume <session-id> to restore one.`
          : message,
      } as const;
      yield event;
      await this.persistSystem(event.kind, event.message);
      return { handled: true };
    }

    if (command === "/resume" || command.startsWith("/resume ")) {
      if (!this.shouldPersistSession) {
        const event = {
          type: "command",
          kind: "error",
          message: "Session persistence is not enabled for this session.",
        } as const;
        yield event;
        return { handled: true };
      }

      const raw = command.slice("/resume".length).trim();
      const sessionId = raw && raw !== "latest" ? raw : null;

      try {
        const restored = await restoreSession({
          cwd: this.cwd,
          homeDir: this.sessionHomeDir,
          sessionId,
        });

        this.sessionId = restored.summary.sessionId;
        this.sessionStartedAt = restored.summary.startedAt;
        this.sessionInitialized = true;
        this.messages = cloneMessages(restored.messages);
        this.totalUsage = { ...restored.summary.totalUsage };
        this.invalidateUsageAnchor();
        this.fileHistory = this.createFileHistory();
        this.fileHistory.restoreSnapshots(restored.fileHistorySnapshots);
        clearTodos(this.sessionId);

        yield { type: "messages_updated", messages: this.getMessages() };
        yield {
          type: "usage_updated",
          totalUsage: this.getTotalUsage(),
          turnUsage: emptyUsage(),
        };

        const event = {
          type: "command",
          kind: "info",
          message: `Resumed session: ${this.sessionId}`,
        } as const;
        yield event;
        await this.persistSystem(event.kind, event.message);
      } catch (error) {
        const event = {
          type: "command",
          kind: "error",
          message: `Resume failed: ${error instanceof Error ? error.message : String(error)}`,
        } as const;
        yield event;
      }

      return { handled: true };
    }

    if (command === "/rewind" || command.startsWith("/rewind ")) {
      const event = await this.handleRewindCommand(command);
      yield event;
      await this.persistSystem(event.kind, event.message);
      return { handled: true };
    }

    if (command === "/mcp") {
      const event = {
        type: "command",
        kind: "info",
        message: formatMcpStatus(),
      } as const;
      yield event;
      await this.persistSystem(event.kind, event.message);
      return { handled: true };
    }

    if (command === "/skills") {
      const event = {
        type: "command",
        kind: "info",
        message: formatSkillsStatus(),
      } as const;
      yield event;
      await this.persistSystem(event.kind, event.message);
      return { handled: true };
    }

    if (command === "/agents") {
      const event = {
        type: "command",
        kind: "info",
        message: formatAgentsStatus(),
      } as const;
      yield event;
      await this.persistSystem(event.kind, event.message);
      return { handled: true };
    }

    if (command === "/agents jobs") {
      const event = {
        type: "command",
        kind: "info",
        message: formatAsyncAgentJobs(),
      } as const;
      yield event;
      await this.persistSystem(event.kind, event.message);
      return { handled: true };
    }

    if (command === "/teams") {
      const event = {
        type: "command",
        kind: "info",
        message: await formatTeamsStatus(),
      } as const;
      yield event;
      await this.persistSystem(event.kind, event.message);
      return { handled: true };
    }

    if (command.startsWith("/agents kill ")) {
      const agentId = command.slice("/agents kill ".length).trim();
      const killed = agentId ? killAsyncAgent(agentId) : false;
      const event = {
        type: "command",
        kind: killed ? "info" : "error",
        message: killed
          ? `Background agent killed: ${agentId}`
          : `Background agent not running: ${agentId || "<empty>"}`,
      } as const;
      yield event;
      await this.persistSystem(event.kind, event.message);
      return { handled: true };
    }

    if (command === "/sandbox") {
      const event = {
        type: "command",
        kind: "info",
        message: await formatSandboxStatus(this.cwd),
      } as const;
      yield event;
      await this.persistSystem(event.kind, event.message);
      return { handled: true };
    }

    if (command === "/hooks") {
      const event = {
        type: "command",
        kind: "info",
        message: await formatHooksStatus({
          cwd: this.cwd,
          homeDir: this.sessionHomeDir,
        }),
      } as const;
      yield event;
      await this.persistSystem(event.kind, event.message);
      return { handled: true };
    }

    if (command === "/config" || command.startsWith("/config ")) {
      const outcome = await handleConfigCommandText(
        this.cwd,
        command,
        this.sessionHomeDir,
      );
      const event = {
        type: "command",
        kind: outcome.kind,
        message: outcome.message,
      } as const;
      yield event;
      await this.persistSystem(event.kind, event.message);
      return { handled: true };
    }

    if (command === "/output-style") {
      const event = {
        type: "command",
        kind: "info",
        message: formatOutputStylesStatus(),
      } as const;
      yield event;
      await this.persistSystem(event.kind, event.message);
      return { handled: true };
    }

    if (command.startsWith("/output-style ")) {
      const name = command.slice("/output-style ".length).trim();
      const ok = await setActiveOutputStyle(name, {
        homeDir: this.sessionHomeDir,
        persist: true,
      });
      const event = {
        type: "command",
        kind: ok ? "info" : "error",
        message: ok
          ? `Output style: ${name}`
          : `Unknown output style: ${name || "<empty>"}`,
      } as const;
      yield event;
      await this.persistSystem(event.kind, event.message);
      return { handled: true };
    }

    if (command === "/commands") {
      const event = {
        type: "command",
        kind: "info",
        message: formatUserCommandsStatus(),
      } as const;
      yield event;
      await this.persistSystem(event.kind, event.message);
      return { handled: true };
    }

    if (command.startsWith("/mcp tools ")) {
      const name = command.slice("/mcp tools ".length).trim();
      const event = {
        type: "command",
        kind: getMcpRegistryEntry(name) ? "info" : "error",
        message: name ? formatMcpTools(name) : "Usage: /mcp tools <name>",
      } as const;
      yield event;
      await this.persistSystem(event.kind, event.message);
      return { handled: true };
    }

    if (command.startsWith("/mcp reconnect ")) {
      const name = command.slice("/mcp reconnect ".length).trim();
      const connection = name ? await reconnectMcpServer(name) : null;
      const event = {
        type: "command",
        kind: connection ? "info" : "error",
        message: connection
          ? `Reconnected ${name}: ${connection.type}`
          : `Unknown MCP server: ${name || "<empty>"}`,
      } as const;
      yield event;
      await this.persistSystem(event.kind, event.message);
      return { handled: true };
    }

    if (command.startsWith("/mcp ")) {
      const event = {
        type: "command",
        kind: "error",
        message: "Usage: /mcp | /mcp tools <name> | /mcp reconnect <name>",
      } as const;
      yield event;
      await this.persistSystem(event.kind, event.message);
      return { handled: true };
    }

    if (command === "/tasks") {
      const event = {
        type: "command",
        kind: "info",
        message:
          `Task system: ${getTaskMode()}. Usage: /tasks task|todo|reset`,
      } as const;
      yield event;
      await this.persistSystem(event.kind, event.message);
      return { handled: true };
    }

    if (command.startsWith("/tasks ")) {
      const action = command.slice("/tasks ".length).trim();

      if (action === "task" || action === "todo") {
        setTaskMode(action as TaskMode);
        const event = {
          type: "command",
          kind: "info",
          message: `Task system: ${getTaskMode()}`,
        } as const;
        yield event;
        await this.persistSystem(event.kind, event.message);
        return { handled: true };
      }

      if (action === "reset") {
        await resetTaskList(getTaskListId(this.sessionId));
        const event = {
          type: "command",
          kind: "info",
          message: "Task list has been reset.",
        } as const;
        yield event;
        await this.persistSystem(event.kind, event.message);
        return { handled: true };
      }

      const event = {
        type: "command",
        kind: "error",
        message: "Usage: /tasks task|todo|reset",
      } as const;
      yield event;
      await this.persistSystem(event.kind, event.message);
      return { handled: true };
    }

    if (command === "/mode") {
      const event = {
        type: "command",
        kind: "info",
        message: `Permission mode: ${this.currentPermissionMode}`,
      } as const;
      yield event;
      await this.persistSystem(event.kind, event.message);
      return { handled: true };
    }

    if (command.startsWith("/mode ")) {
      const nextMode = command.slice("/mode ".length).trim();

      if (!["default", "plan", "auto"].includes(nextMode)) {
        const event = {
          type: "command",
          kind: "error",
          message: "Usage: /mode default|plan|auto",
        } as const;
        yield event;
        await this.persistSystem(event.kind, event.message);
        return { handled: true };
      }

      this.setPermissionMode(nextMode as PermissionMode);
      const event = {
        type: "command",
        kind: "info",
        message: `Permission mode: ${this.currentPermissionMode}`,
      } as const;
      yield event;
      await this.persistSystem(event.kind, event.message);
      return { handled: true };
    }

    if (command === "/compact" || command.startsWith("/compact ")) {
      const focus = command.slice("/compact".length).trim();
      yield { type: "compaction_started", trigger: "manual" };
      const compacted = await this.compactForModel({
        trigger: "manual",
        force: true,
        focus,
        model: this.getActiveModel(),
      });

      if (compacted) {
        this.messages = compacted.messages;
        this.lastCallUsage = null;
        this.usageAnchorIndex = -1;
        await this.persistCompaction(compacted, "manual");
        yield { type: "messages_updated", messages: this.getMessages() };
        yield {
          type: "compaction_finished",
          trigger: "manual",
          beforeMessageCount: compacted.beforeMessageCount,
          afterMessageCount: compacted.afterMessageCount,
          beforeTokens: compacted.beforeTokens,
          afterTokens: compacted.afterTokens,
          didFullCompact: compacted.didFullCompact,
          didMicroCompact: compacted.didMicroCompact,
        };
      }

      const event = {
        type: "command",
        kind: "info",
        message: compacted
          ? `Compacted: ${compacted.beforeMessageCount} -> ${compacted.afterMessageCount} messages`
          : "Nothing to compact.",
      } as const;
      yield event;
      await this.persistSystem(event.kind, event.message);
      return { handled: true };
    }

    if (command === "/model") {
      const event = {
        type: "command",
        kind: "info",
        message: `Active model: ${this.getActiveModel()}`,
      } as const;
      yield event;
      await this.persistSystem(event.kind, event.message);
      return { handled: true };
    }

    if (command.startsWith("/model ")) {
      const nextModel = command.slice("/model ".length).trim();
      this.sessionModelOverride =
        !nextModel || nextModel === "default" ? null : nextModel;

      const event = {
        type: "command",
        kind: "info",
        message: `Active model: ${this.getActiveModel()}`,
      } as const;
      yield event;
      await this.persistSystem(event.kind, event.message);
      return { handled: true };
    }

    if (command === "/help") {
      const event = {
        type: "command",
        kind: "info",
        message:
          "Commands: /help /clear /compact [focus] /cost /history /resume [latest|session-id] /rewind [preview] [n] /mcp [tools|reconnect] /skills /commands /<command> [args] /<skill-name> [args] /agents [jobs|kill] /teams /sandbox /hooks /config [list|sources|trust|get|set] /output-style [name] /tasks [task|todo|reset] /mode [default|plan|auto] /model [name|default] /exit /quit",
      } as const;
      yield event;
      await this.persistSystem(event.kind, event.message);
      return { handled: true };
    }

    const event = {
      type: "command",
      kind: "error",
      message: `Unknown command: ${command}`,
    } as const;
    yield event;
    await this.persistSystem(event.kind, event.message);
    return { handled: true };
  }

  private isBuiltInCommand(command: string): boolean {
    return command === "/help" ||
      command === "/clear" ||
      command === "/cost" ||
      command === "/history" ||
      command === "/resume" ||
      command === "/rewind" ||
      command === "/mcp" ||
      command === "/skills" ||
      command === "/agents" ||
      command === "/agents jobs" ||
      command === "/teams" ||
      command === "/sandbox" ||
      command === "/hooks" ||
      command === "/config" ||
      command === "/output-style" ||
      command === "/commands" ||
      command === "/tasks" ||
      command === "/mode" ||
      command === "/compact" ||
      command === "/model" ||
      command.startsWith("/mcp ") ||
      command.startsWith("/config ") ||
      command.startsWith("/resume ") ||
      command.startsWith("/rewind ") ||
      command.startsWith("/agents kill ") ||
      command.startsWith("/tasks ") ||
      command.startsWith("/output-style ") ||
      command.startsWith("/mode ") ||
      command.startsWith("/compact ") ||
      command.startsWith("/model ");
  }

  private expandUserSlashCommand(command: string):
    | { ok: true; messages: Message[]; model?: string }
    | { ok: false; message: string } {
    const userCommand = this.expandUserCommandSlashCommand(command);

    if (userCommand.ok) {
      return userCommand;
    }

    return this.expandSkillSlashCommand(command);
  }

  private expandUserCommandSlashCommand(commandText: string):
    | { ok: true; messages: Message[]; model?: string }
    | { ok: false; message: string } {
    const parsed = parseUserSlashCommand(commandText);

    if (!parsed) {
      return { ok: false, message: `Unknown command: ${commandText}` };
    }

    const command = findUserCommand(parsed.name);

    if (!command) {
      return { ok: false, message: `Unknown command: ${commandText}` };
    }

    if (command.allowedTools.length > 0) {
      this.addSessionAllowRules(command.allowedTools);
    }

    const markerLines = [
      `<command-message>${command.name}</command-message>`,
      `<command-name>/${command.name}</command-name>`,
    ];

    if (parsed.args) {
      markerLines.push(`<command-args>${parsed.args}</command-args>`);
    }

    return {
      ok: true,
      ...(command.model && { model: command.model }),
      messages: [
        {
          role: "user",
          content: markerLines.join("\n"),
        },
        {
          role: "user",
          content: [
            `[user_command:${command.name}]`,
            substituteUserCommandArguments(command.body, parsed.args),
          ].join("\n\n"),
        },
      ],
    };
  }

  private expandSkillSlashCommand(command: string):
    | { ok: true; messages: Message[] }
    | { ok: false; message: string } {
    const parsed = parseSkillSlashCommand(command);

    if (!parsed || !SKILL_NAME_RE.test(parsed.name)) {
      return { ok: false, message: `Unknown command: ${command}` };
    }

    const skill = findSkill(parsed.name);

    if (!skill) {
      return { ok: false, message: `Unknown command: ${command}` };
    }

    if (skill.frontmatter.hasForkContext) {
      return {
        ok: false,
        message: `Skill "${skill.name}" requires forked sub-agent context, which is not implemented in this stage.`,
      };
    }

    if (skill.frontmatter.allowedTools.length > 0) {
      this.addSessionAllowRules(skill.frontmatter.allowedTools);
    }

    const markerLines = [
      `<command-message>${skill.name}</command-message>`,
      `<command-name>/${skill.name}</command-name>`,
    ];

    if (parsed.args) {
      markerLines.push(`<command-args>${parsed.args}</command-args>`);
    }

    return {
      ok: true,
      messages: [
        {
          role: "user",
          content: markerLines.join("\n"),
        },
        {
          role: "user",
          content: buildSkillInvocationText({
            skillName: skill.name,
            body: skill.body,
            baseDir: skill.baseDir,
            args: parsed.args,
            sessionId: this.sessionId,
          }),
        },
      ],
    };
  }

  private async compactForModel(params: {
    trigger: "manual" | "auto";
    force: boolean;
    focus?: string;
    model?: string;
    signal?: AbortSignal;
  }): Promise<CompactMessagesResult | null> {
    const options = {
      ...(this.lastCallUsage && { usage: this.lastCallUsage }),
      usageAnchorIndex: this.usageAnchorIndex,
      force: params.force,
      trigger: params.trigger,
      ...(params.focus && { focus: params.focus }),
      model: params.model,
      signal: params.signal,
    } satisfies CompactMessagesParams;
    const budget = buildTokenBudgetSnapshot(this.getMessages(), {
      ...(this.lastCallUsage && { usage: this.lastCallUsage }),
      usageAnchorIndex: this.usageAnchorIndex,
      model: params.model,
    });

    if (params.trigger === "auto" && isAutoCompactCircuitOpen()) {
      return null;
    }

    if (
      params.trigger === "auto" &&
      budget.estimatedConversationTokens >= budget.autoCompactThreshold &&
      !shouldAutoCompact(
        budget.estimatedConversationTokens,
        params.model,
        "user",
      )
    ) {
      return null;
    }

    let compacted: CompactMessagesResult;

    try {
      compacted = await this.compactMessages(this.getMessages(), options);
      if (params.trigger === "auto" && compacted.didFullCompact) {
        recordAutoCompactSuccess();
      }
    } catch (error) {
      if (params.trigger === "auto") {
        recordAutoCompactFailure();
        await this.persistSystem(
          "error",
          `Auto-compaction failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return null;
      }

      throw error;
    }

    if (
      !compacted.didFullCompact &&
      !compacted.didMicroCompact &&
      compacted.messages.length === this.messages.length
    ) {
      return null;
    }

    return compacted;
  }

  private invalidateUsageAnchor(): void {
    this.lastCallUsage = null;
    this.usageAnchorIndex = -1;
  }

  private getPlanFilePath(): string {
    return getPlanFilePath({
      homeDir: this.sessionHomeDir,
      sessionId: this.sessionId,
    });
  }

  private setPermissionMode(mode: PermissionMode): void {
    const previous = this.currentPermissionMode;

    if (mode === "plan" && previous !== "plan") {
      this.prePlanMode = previous;
      this.currentPermissionMode = "plan";
      return;
    }

    if (mode !== "plan" && previous === "plan") {
      this.currentPermissionMode = this.prePlanMode ?? mode;
      this.prePlanMode = null;
      this.needsPlanModeExitAttachment = true;
      return;
    }

    this.currentPermissionMode = mode;
  }

  private addSessionAllowRules(rules: string[]): void {
    for (const rule of rules) {
      if (!this.sessionAllowRules.includes(rule)) {
        this.sessionAllowRules.push(rule);
      }
    }
  }

  private async ensureSessionInitialized(): Promise<void> {
    if (!this.shouldPersistSession || this.sessionInitialized) {
      return;
    }

    await initSessionStorage({
      cwd: this.cwd,
      homeDir: this.sessionHomeDir,
      sessionId: this.sessionId,
      startedAt: this.sessionStartedAt,
      model: this.defaultModel,
    });
    this.sessionInitialized = true;
  }

  private async persistMessage(message: Message): Promise<void> {
    if (!this.shouldPersistSession) {
      return;
    }

    await this.ensureSessionInitialized();
    await appendTranscriptEntry({
      cwd: this.cwd,
      homeDir: this.sessionHomeDir,
      sessionId: this.sessionId,
      entry: createMessageEntry({ message }),
    });
  }

  private async persistToolEvent(params: {
    name: string;
    phase: "start" | "done";
    resultLength?: number;
    isError?: boolean;
  }): Promise<void> {
    if (!this.shouldPersistSession) {
      return;
    }

    await this.ensureSessionInitialized();
    await appendTranscriptEntry({
      cwd: this.cwd,
      homeDir: this.sessionHomeDir,
      sessionId: this.sessionId,
      entry: createToolEventEntry(params),
    });
  }

  private async persistUsage(turnUsage: Usage): Promise<void> {
    if (!this.shouldPersistSession) {
      return;
    }

    await this.ensureSessionInitialized();
    await appendTranscriptEntry({
      cwd: this.cwd,
      homeDir: this.sessionHomeDir,
      sessionId: this.sessionId,
      entry: createUsageEntry({
        turn: turnUsage,
        total: this.getTotalUsage(),
      }),
    });
  }

  private async persistCompaction(
    compacted: CompactMessagesResult,
    trigger: "manual" | "auto",
  ): Promise<void> {
    if (!this.shouldPersistSession || !compacted.didFullCompact) {
      return;
    }

    await this.ensureSessionInitialized();
    await appendTranscriptEntry({
      cwd: this.cwd,
      homeDir: this.sessionHomeDir,
      sessionId: this.sessionId,
      entry: createCompactionEntry({
        trigger,
        beforeMessageCount: compacted.beforeMessageCount,
        afterMessageCount: compacted.afterMessageCount,
        summary: compacted.summary,
      }),
    });

    for (const message of compacted.messages) {
      await appendTranscriptEntry({
        cwd: this.cwd,
        homeDir: this.sessionHomeDir,
        sessionId: this.sessionId,
        entry: createMessageEntry({ message }),
      });
    }
  }

  private async persistSystem(
    level: "info" | "error",
    message: string,
  ): Promise<void> {
    if (!this.shouldPersistSession) {
      return;
    }

    await this.ensureSessionInitialized();
    await appendTranscriptEntry({
      cwd: this.cwd,
      homeDir: this.sessionHomeDir,
      sessionId: this.sessionId,
      entry: createSystemEntry({ level, message }),
    });
  }
}
