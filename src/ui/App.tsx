import { readFile } from "node:fs/promises";

import { useApp, useInput, Box, Text } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import {
  QueryEngine,
  type QueryEngineEvent,
} from "../core/queryEngine.js";
import type {
  PermissionDecision,
  PlanApprovalChoice,
  PermissionMode,
  PermissionResponse,
} from "../permissions/permissions.js";
import type { Message, Usage } from "../types/message.js";
import {
  listProjectSessions,
  type SessionSummary,
} from "../session/transcript.js";
import type { FileHistorySnapshot } from "../session/fileHistory.js";
import { getTodos, subscribeTodos } from "../state/todoStore.js";
import {
  getTaskListId,
  listTasks,
  subscribeTasks,
} from "../state/taskStore.js";
import {
  getTaskMode,
  subscribeTaskMode,
  type TaskMode,
} from "../state/taskModeStore.js";
import {
  subscribeSubAgentProgress,
  type SubAgentProgress,
} from "../state/subAgentProgressStore.js";
import {
  getBashProgress,
  subscribeBashProgress,
  type BashProgressEntry,
} from "../state/bashProgressStore.js";
import {
  getAllAsyncAgents,
  killAsyncAgent,
  subscribeAsyncAgents,
  type AsyncAgentEntry,
} from "../state/asyncAgentStore.js";
import type { Task } from "../types/task.js";
import type { TodoItem } from "../types/todo.js";
import {
  createPlanApprovalResponse,
  movePlanApprovalSelection,
  PLAN_APPROVAL_OPTIONS,
  requiresPlanFeedback,
} from "./planApproval.js";
import { Spinner } from "./components/Spinner.js";
import {
  ConversationView,
  conversationItemToLines,
  flattenConversation,
  shouldResetStaticHistory,
  type ConversationItem,
} from "./components/ConversationView.js";
import { getInProgressTask, TaskList } from "./components/TaskList.js";
import { getInProgressTodo, TodoList } from "./components/TodoList.js";
import { TranscriptOverlay } from "./components/TranscriptOverlay.js";
import { CommandSuggestions } from "./components/CommandSuggestions.js";
import { CommandPanel } from "./components/CommandPanel.js";
import { InputPrompt } from "./components/InputPrompt.js";
import { PermissionRequestCard } from "./components/PermissionRequestCard.js";
import { AppHeader } from "./components/AppHeader.js";
import { StreamingMarkdownText } from "./markdown/index.js";
import { handlePromptInputKey } from "./hooks/usePromptInput.js";
import { useTextInput } from "./hooks/useTextInput.js";
import {
  reduceTranscriptState,
  useTranscript,
} from "./hooks/useTranscript.js";
import {
  formatTaskOutputLines,
  selectRecentOutputLines,
} from "./teammateOutputView.js";
import {
  completeCommandSuggestion,
  filterCommandSuggestions,
  moveCommandSelection,
} from "./commandSuggestions.js";
import {
  movePanelSelection,
  nextPermissionMode,
  panelSelectionForInput,
  PERMISSION_MODE_OPTIONS,
  type CommandPanelState,
  type CommandPanelOption,
} from "./commandPanel.js";
import {
  movePermissionSelection,
  permissionResponseForIndex,
  permissionResponseForKey,
} from "./permissionPrompt.js";
import {
  getAllOutputStyles,
  getActiveOutputStyleName,
} from "../services/extensions/outputStyles.js";
import {
  getMcpRegistry,
} from "../services/mcp/index.js";
import {
  getAllAgents,
} from "../agents/index.js";
import {
  getActiveTeam,
  isAgentTeamsEnabled,
} from "../teams/index.js";
import {
  getProjectTrustInfo,
  trustProject,
  type ProjectTrustInfo,
} from "../config/index.js";
import {
  getSandboxRuntimeStatus,
  loadSandboxSettings,
  writeProjectSandboxSettings,
  type SandboxSettings,
} from "../sandbox/index.js";

interface AppProps {
  model: string;
  version?: string;
  startupDurationMs?: number;
  permissionMode?: PermissionMode;
  initialMessages?: Message[];
  initialUsage?: Usage;
  sessionId?: string;
  sessionStartedAt?: string;
  sessionAlreadyInitialized?: boolean;
  initialFileHistorySnapshots?: FileHistorySnapshot[];
}

interface ToolCallInfo {
  id?: string;
  name: string;
  resultLength?: number;
  subAgentProgress?: SubAgentProgress;
  bashProgress?: BashProgressEntry;
}

interface PendingPermission {
  decision: PermissionDecision;
  resolve: (response: PermissionResponse) => void;
  planContent?: string;
}

type CommandPanelKind =
  | "mode"
  | "resume"
  | "sandbox"
  | "tasks"
  | "output-style"
  | "model"
  | "mcp"
  | "agents"
  | "teams"
  | "config";

function commandPanelKindForInput(value: string): CommandPanelKind | null {
  const trimmed = value.trim();
  const raw = value;

  if (!raw.startsWith("/") || (trimmed && /\s+\S/.test(raw))) {
    return null;
  }

  switch (trimmed) {
    case "/mode":
      return "mode";
    case "/resume":
      return "resume";
    case "/sandbox":
      return "sandbox";
    case "/tasks":
      return "tasks";
    case "/output-style":
      return "output-style";
    case "/model":
      return "model";
    case "/mcp":
      return "mcp";
    case "/agents":
      return "agents";
    case "/teams":
      return "teams";
    case "/config":
      return "config";
    default:
      return null;
  }
}

function shortSessionId(sessionId: string): string {
  return sessionId.length > 12 ? `${sessionId.slice(0, 8)}...` : sessionId;
}

function formatSessionDescription(session: SessionSummary): string {
  const total = session.totalUsage.input_tokens + session.totalUsage.output_tokens;
  return `${shortSessionId(session.sessionId)} · ${session.messageCount} messages · ${total} tokens · ${session.updatedAt}`;
}

function isPlanApprovalPermission(pending: PendingPermission | null): boolean {
  return pending?.decision.request.toolName === "ExitPlanMode";
}

function formatToolCall(toolCall: ToolCallInfo): string {
  if (toolCall.name === "Agent" && toolCall.subAgentProgress) {
    const progress = toolCall.subAgentProgress;
    const label = progress.teammateName
      ? `${progress.teammateName} · ${progress.agentType}`
      : progress.agentType;
    return [
      `Agent[${label}]`,
      progress.description,
      progress.status === "running" ? "Running" : progress.status === "completed" ? "Done" : "Error",
      `${progress.toolUseCount} tools`,
      `${progress.totalTokens} tokens`,
      progress.lastToolName ? `last: ${progress.lastToolName}` : "",
    ].filter(Boolean).join(" | ");
  }

  if (toolCall.name === "Bash" && toolCall.bashProgress) {
    const progress = toolCall.bashProgress;
    const elapsedMs = (progress.endedAt ?? Date.now()) - progress.startedAt;
    const tail = [...progress.stderr, ...progress.stdout].slice(-2).join(" | ");
    return [
      "Bash",
      progress.running ? "running" : `exit ${progress.exitCode ?? 0}`,
      `${Math.max(0, Math.round(elapsedMs / 1000))}s`,
      `${progress.lineCount} lines`,
      tail,
    ].filter(Boolean).join(" | ");
  }

  return toolCall.name;
}

function formatAsyncAgentStatus(agent: AsyncAgentEntry): string {
  const label = agent.teammateName
    ? `${agent.teammateName} · ${agent.agentType}`
    : agent.agentType;
  return [
    `Agent[${label}]`,
    agent.description,
    agent.status,
    `${agent.toolUseCount} tools`,
    `${agent.totalTokens} tokens`,
    agent.lastToolName ? `last: ${agent.lastToolName}` : "",
    agent.worktreePath ? "worktree" : "",
  ].filter(Boolean).join(" | ");
}

async function resolvePlanContent(
  decision: PermissionDecision,
): Promise<string> {
  const inputPlan = decision.request.input.plan;

  if (typeof inputPlan === "string" && inputPlan.trim()) {
    return inputPlan;
  }

  if (decision.request.planFilePath) {
    try {
      const fileContent = await readFile(decision.request.planFilePath, "utf8");

      if (fileContent.trim()) {
        return fileContent;
      }
    } catch {
      // Keep the approval flow usable even if the model forgot to write a file.
    }
  }

  return "(No plan content found)";
}

function PlanApprovalDialog({
  pending,
  selectedIndex,
  feedback,
}: {
  pending: PendingPermission;
  selectedIndex: number;
  feedback: string;
}): ReactNode {
  const selected = PLAN_APPROVAL_OPTIONS[selectedIndex] ?? PLAN_APPROVAL_OPTIONS[0];
  const showFeedback = selected ? requiresPlanFeedback(selected.choice) : false;

  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" paddingX={1}>
      <Text color="yellow" bold>
        Ready to code?
      </Text>
      <Text dimColor>
        {pending.decision.request.planFilePath
          ? `Plan file: ${pending.decision.request.planFilePath}`
          : "Plan file: unavailable"}
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text>{pending.planContent ?? "(No plan content found)"}</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        {PLAN_APPROVAL_OPTIONS.map((option, index) => (
          <Text key={option.choice} color={index === selectedIndex ? "cyan" : undefined}>
            {index === selectedIndex ? "> " : "  "}
            {option.label}
            <Text dimColor>    {option.description}</Text>
          </Text>
        ))}
      </Box>
      {showFeedback && (
        <Box marginTop={1}>
          <Text color="green">feedback: </Text>
          <Text>{feedback}</Text>
          <Text dimColor>_</Text>
        </Box>
      )}
      <Text dimColor>Up/Down select, Enter confirm, Ctrl+C cancel</Text>
    </Box>
  );
}

function TrustProjectDialog({
  info,
  selectedIndex,
}: {
  info: ProjectTrustInfo;
  selectedIndex: number;
}): ReactNode {
  const options = [
    "Yes, I trust this folder",
    "No, exit",
  ];

  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" paddingX={1}>
      <Text color="yellow" bold>Do you trust this folder?</Text>
      <Text>{info.key}</Text>
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>This folder contains executable or high-trust configuration:</Text>
        {info.riskyItems.map((item) => (
          <Text key={item}>  - {item}</Text>
        ))}
      </Box>
      <Box marginTop={1} flexDirection="column">
        {options.map((option, index) => (
          <Text key={option} color={index === selectedIndex ? "cyan" : undefined}>
            {index === selectedIndex ? "> " : "  "}
            {option}
          </Text>
        ))}
      </Box>
      <Text dimColor>Up/Down select, Enter confirm, Esc exits.</Text>
    </Box>
  );
}

export function App({
  model,
  version = "0.1.0",
  startupDurationMs,
  permissionMode,
  initialMessages,
  initialUsage,
  sessionId,
  sessionStartedAt,
  sessionAlreadyInitialized,
  initialFileHistorySnapshots,
}: AppProps): ReactNode {
  const { exit } = useApp();
  const cwd = useMemo(() => process.cwd(), []);

  const [messages, setMessages] = useState<Message[]>(initialMessages ?? []);
  const [historyItems, setHistoryItems] = useState<ConversationItem[]>(
    () => flattenConversation(initialMessages ?? []),
  );
  const [staticEpoch, setStaticEpoch] = useState(0);
  const [activeModel, setActiveModel] = useState(model);
  const [activePermissionMode, setActivePermissionMode] =
    useState<PermissionMode>(permissionMode ?? "default");
  const promptInput = useTextInput();
  const [isLoading, setIsLoading] = useState(false);
  const [spinnerLabel, setSpinnerLabel] = useState("Thinking");
  const [streamingText, setStreamingText] = useState("");
  const [toolCalls, setToolCalls] = useState<ToolCallInfo[]>([]);
  const [lastUsage, setLastUsage] = useState<{
    input: number;
    output: number;
  } | null>(
    initialUsage
      ? {
          input: initialUsage.input_tokens,
          output: initialUsage.output_tokens,
        }
      : null,
  );
  const [infoMessage, setInfoMessage] = useState<string | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [contextPercent, setContextPercent] = useState<number | null>(null);
  const [planApprovalIndex, setPlanApprovalIndex] = useState(0);
  const [planFeedback, setPlanFeedback] = useState("");
  const [permissionSelectionIndex, setPermissionSelectionIndex] = useState(0);
  const [commandSelectionIndex, setCommandSelectionIndex] = useState(0);
  const [panelSelectionIndex, setPanelSelectionIndex] = useState(0);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sandboxSettings, setSandboxSettings] =
    useState<SandboxSettings | null>(null);
  const [trustInfo, setTrustInfo] = useState<ProjectTrustInfo | null>(null);
  const [trustSelectionIndex, setTrustSelectionIndex] = useState(0);
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [asyncAgents, setAsyncAgents] =
    useState<AsyncAgentEntry[]>(getAllAsyncAgents());
  const [teammateViewMode, setTeammateViewMode] =
    useState<"main" | "selecting" | "viewing">("main");
  const [teammateSelectionIndex, setTeammateSelectionIndex] = useState(0);
  const [viewingAgentId, setViewingAgentId] = useState<string | null>(null);
  const [teammateOutputLines, setTeammateOutputLines] = useState<string[]>([]);
  const [taskMode, setTaskModeState] = useState<TaskMode>(getTaskMode());
  const [pendingPermission, setPendingPermission] =
    useState<PendingPermission | null>(null);
  const transcriptLines = useMemo(() => {
    const base = historyItems.flatMap((item) => conversationItemToLines(item, true));
    return streamingText
      ? [...base, "| streaming", ...streamingText.split(/\r?\n/)]
      : base;
  }, [historyItems, streamingText]);
  const transcript = useTranscript(transcriptLines);
  const commandSuggestions = useMemo(
    () =>
      filterCommandSuggestions(promptInput.value, {
        selectedIndex: commandSelectionIndex,
      }),
    [commandSelectionIndex, promptInput.value],
  );
  const activePanelKind = commandPanelKindForInput(promptInput.value);
  const historyItemsWithHeader = useMemo<ConversationItem[]>(() => [
    {
      kind: "header",
      key: "startup-header",
      info: {
        version,
        model: activeModel,
        mode: activePermissionMode,
        cwd,
        contextPercent,
        startupDurationMs,
      },
    },
    ...historyItems,
  ], [
    activeModel,
    activePermissionMode,
    contextPercent,
    cwd,
    historyItems,
    startupDurationMs,
    version,
  ]);

  const permissionResolverRef = useRef<PendingPermission | null>(null);
  const pendingClearContextPlanRef = useRef<string | null>(null);
  const pendingPlanFeedbackRef = useRef<string | null>(null);

  const requestPermission = useCallback(
    async (decision: PermissionDecision): Promise<PermissionResponse> => {
      const planContent = decision.request.toolName === "ExitPlanMode"
        ? await resolvePlanContent(decision)
        : undefined;

      return new Promise((resolve) => {
        const pending = { decision, resolve, planContent };
        permissionResolverRef.current = pending;
        setPlanApprovalIndex(0);
        setPlanFeedback("");
        setPermissionSelectionIndex(0);
        setPendingPermission(pending);
      });
    },
    [],
  );

  const engine = useMemo(() => {
    return new QueryEngine({
      model,
      cwd,
      permissionMode,
      requestPermission,
      initialMessages,
      initialUsage,
      session: {
        enabled: true,
        sessionId,
        startedAt: sessionStartedAt,
        alreadyInitialized: sessionAlreadyInitialized,
        fileHistorySnapshots: initialFileHistorySnapshots,
      },
    });
  }, [
    cwd,
    initialMessages,
    initialUsage,
    model,
    permissionMode,
    requestPermission,
    sessionAlreadyInitialized,
    sessionId,
    sessionStartedAt,
    initialFileHistorySnapshots,
  ]);

  useEffect(() => {
    const nextItems = flattenConversation(messages);

    setHistoryItems((previous) => {
      if (shouldResetStaticHistory(previous, nextItems)) {
        setStaticEpoch((epoch) => epoch + 1);
      }

      return nextItems;
    });
  }, [messages]);

  useEffect(() => {
    const currentSessionId = engine.getSessionId();
    setTodos(getTodos(currentSessionId));

    return subscribeTodos((updatedSessionId, nextTodos) => {
      if (updatedSessionId === currentSessionId) {
        setTodos(nextTodos);
      }
    });
  }, [engine]);

  useEffect(() => {
    const taskListId = getTaskListId(engine.getSessionId());
    const refresh = async (): Promise<void> => {
      setTasks(await listTasks(taskListId));
    };

    void refresh();

    return subscribeTasks((updatedTaskListId) => {
      if (updatedTaskListId === taskListId) {
        void refresh();
      }
    });
  }, [engine]);

  useEffect(() => {
    setTaskModeState(getTaskMode());

    return subscribeTaskMode((mode) => {
      setTaskModeState(mode);
    });
  }, []);

  useEffect(() => {
    return subscribeSubAgentProgress((toolUseId, progress) => {
      setToolCalls((prev) => prev.map((toolCall) => {
        return toolCall.id === toolUseId
          ? { ...toolCall, subAgentProgress: progress }
          : toolCall;
      }));
    });
  }, []);

  useEffect(() => {
    return subscribeBashProgress((toolUseId, progress) => {
      setToolCalls((prev) => prev.map((toolCall) => {
        return toolCall.id === toolUseId
          ? { ...toolCall, bashProgress: progress }
          : toolCall;
      }));
    });
  }, []);

  useEffect(() => {
    return subscribeAsyncAgents(() => {
      setAsyncAgents(getAllAsyncAgents());
    });
  }, []);

  const teammateAgents = useMemo(() => {
    return asyncAgents.filter((agent) => agent.teammateName);
  }, [asyncAgents]);

  useEffect(() => {
    if (
      teammateAgents.length === 0 ||
      teammateSelectionIndex >= teammateAgents.length
    ) {
      setTeammateSelectionIndex(Math.max(0, teammateAgents.length - 1));
    }
  }, [teammateAgents.length, teammateSelectionIndex]);

  useEffect(() => {
    if (teammateViewMode === "viewing" && viewingAgentId) {
      const stillExists = teammateAgents.some((agent) => agent.agentId === viewingAgentId);
      if (!stillExists) {
        setTeammateViewMode("main");
        setViewingAgentId(null);
      }
    }
  }, [teammateAgents, teammateViewMode, viewingAgentId]);

  useEffect(() => {
    if (teammateViewMode !== "viewing" || !viewingAgentId) {
      return;
    }

    const agent = asyncAgents.find((item) => item.agentId === viewingAgentId);
    if (!agent?.outputFile) {
      setTeammateOutputLines(["No output file available."]);
      return;
    }

    let cancelled = false;
    const refresh = async (): Promise<void> => {
      try {
        const raw = await readFile(agent.outputFile, "utf8");
        if (!cancelled) {
          setTeammateOutputLines(
            selectRecentOutputLines(formatTaskOutputLines(raw.split(/\r?\n/))),
          );
        }
      } catch (error) {
        if (!cancelled) {
          setTeammateOutputLines([
            `Unable to read output: ${error instanceof Error ? error.message : String(error)}`,
          ]);
        }
      }
    };

    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 1000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [asyncAgents, teammateViewMode, viewingAgentId]);

  useEffect(() => {
    if (commandSelectionIndex >= commandSuggestions.length) {
      setCommandSelectionIndex(Math.max(0, commandSuggestions.length - 1));
    }
  }, [commandSelectionIndex, commandSuggestions.length]);

  useEffect(() => {
    setPanelSelectionIndex(0);
  }, [activePanelKind]);

  useEffect(() => {
    if (activePanelKind !== "resume") {
      return;
    }

    let cancelled = false;
    void listProjectSessions({ cwd, limit: 12 }).then((nextSessions) => {
      if (!cancelled) {
        setSessions(nextSessions);
      }
    }).catch(() => {
      if (!cancelled) {
        setSessions([]);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [activePanelKind, cwd]);

  useEffect(() => {
    if (activePanelKind !== "sandbox") {
      return;
    }

    let cancelled = false;
    void loadSandboxSettings({ cwd }).then((settings) => {
      if (!cancelled) {
        setSandboxSettings(settings);
      }
    }).catch(() => {
      if (!cancelled) {
        setSandboxSettings(null);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [activePanelKind, cwd]);

  useEffect(() => {
    let cancelled = false;
    void getProjectTrustInfo({ cwd }).then((info) => {
      if (!cancelled && info.hasRiskyConfig && !info.trusted) {
        setTrustInfo(info);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  const resolveNormalPermission = useCallback((
    pending: PendingPermission,
    response: PermissionResponse,
  ): void => {
    pending.resolve(response);
    permissionResolverRef.current = null;
    setPendingPermission(null);

    if (response === "deny") {
      setInfoMessage("Permission denied.");
    } else if (response === "always_allow") {
      setInfoMessage(
        `Always allowed for this session: ${pending.decision.request.suggestedAllowRule}`,
      );
    }
  }, []);

  const commandPanel = useMemo<CommandPanelState | null>(() => {
    if (!activePanelKind) {
      return null;
    }

    let options: CommandPanelOption[] = [];
    let title = "";
    let description = "";

    if (activePanelKind === "mode") {
      title = "Permission mode";
      description = "Choose how KK Agent should handle tool permissions.";
      options = PERMISSION_MODE_OPTIONS.map((option) => ({
        id: option.mode,
        label: option.mode,
        description: option.description,
        command: `/mode ${option.mode}`,
        isCurrent: option.mode === activePermissionMode,
      }));
    } else if (activePanelKind === "resume") {
      title = "Resume session";
      description = "Choose a saved conversation for this project.";
      options = sessions.map((session) => ({
        id: session.sessionId,
        label: session.title ?? shortSessionId(session.sessionId),
        description: formatSessionDescription(session),
        command: `/resume ${session.sessionId}`,
        isCurrent: session.sessionId === engine.getSessionId(),
      }));
    } else if (activePanelKind === "sandbox") {
      const runtime = getSandboxRuntimeStatus();
      title = "Sandbox";
      description = runtime.available
        ? `runtime: ${runtime.kind}`
        : `runtime: ${runtime.kind} unavailable - ${runtime.reason ?? "no hard sandbox"}`;
      const enabled = sandboxSettings?.enabled ?? false;
      const allowFallback = sandboxSettings?.allowUnsandboxedCommands ?? true;
      options = [
        {
          id: "status",
          label: "Show sandbox status",
          description: "Print the current sandbox runtime and settings",
          command: "/sandbox",
        },
        {
          id: "enable",
          label: enabled ? "Disable sandbox policy" : "Enable sandbox policy",
          description: "Write sandbox.enabled in project settings",
          command: `__sandbox:enabled:${enabled ? "false" : "true"}`,
          isCurrent: enabled,
        },
        {
          id: "fallback",
          label: allowFallback
            ? "Block unsandboxed Bash fallback"
            : "Allow unsandboxed Bash fallback",
          description: "Write sandbox.allowUnsandboxedCommands in project settings",
          command: `__sandbox:allowUnsandboxedCommands:${allowFallback ? "false" : "true"}`,
          isCurrent: allowFallback,
        },
      ];
    } else if (activePanelKind === "tasks") {
      title = "Task system";
      description = "Choose the active task tracking backend.";
      options = [
        {
          id: "task",
          label: "Task V2",
          description: "Persistent task graph",
          command: "/tasks task",
          isCurrent: taskMode === "task",
        },
        {
          id: "todo",
          label: "TodoWrite V1",
          description: "Session-only todo list",
          command: "/tasks todo",
          isCurrent: taskMode === "todo",
        },
        {
          id: "reset",
          label: "Reset Task V2 graph",
          description: "Clears persistent tasks for this session",
          command: "/tasks reset",
          isDanger: true,
        },
      ];
    } else if (activePanelKind === "output-style") {
      title = "Output style";
      description = "Choose how assistant responses should be shaped.";
      const activeStyle = getActiveOutputStyleName();
      options = getAllOutputStyles()
        .slice()
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((style) => ({
          id: style.name,
          label: style.name,
          description: `${style.description} [${style.source}]`,
          command: `/output-style ${style.name}`,
          isCurrent: style.name === activeStyle,
        }));
    } else if (activePanelKind === "model") {
      title = "Model";
      description = "Inspect or clear the current model override.";
      options = [
        {
          id: "show",
          label: "Show active model",
          description: activeModel,
          command: "/model",
          isCurrent: true,
        },
        {
          id: "default",
          label: "Clear session override",
          description: "Return to the startup default model",
          command: "/model default",
        },
      ];
    } else if (activePanelKind === "mcp") {
      title = "MCP";
      description = "Inspect MCP servers or reconnect one.";
      const entries = getMcpRegistry();
      options = [
        {
          id: "status",
          label: "Show MCP status",
          description: `${entries.length} configured server(s)`,
          command: "/mcp",
        },
        ...entries.flatMap((entry) => {
          const name = entry.connection.name;
          return [
            {
              id: `tools-${name}`,
              label: `Tools: ${name}`,
              description: `${entry.tools.length} tool(s)`,
              command: `/mcp tools ${name}`,
            },
            {
              id: `reconnect-${name}`,
              label: `Reconnect: ${name}`,
              description: entry.connection.type,
              command: `/mcp reconnect ${name}`,
            },
          ];
        }),
      ];
    } else if (activePanelKind === "agents") {
      title = "Agents";
      description = "Inspect SubAgents or background jobs.";
      const running = asyncAgents.filter((agent) => agent.status === "running");
      options = [
        {
          id: "list",
          label: "List SubAgents",
          description: `${getAllAgents().length} agent definition(s)`,
          command: "/agents",
        },
        {
          id: "jobs",
          label: "Background jobs",
          description: `${asyncAgents.length} launched agent(s)`,
          command: "/agents jobs",
        },
        ...running.map((agent) => ({
          id: `kill-${agent.agentId}`,
          label: `Kill ${agent.teammateName ?? agent.agentType}`,
          description: agent.description,
          command: `/agents kill ${agent.agentId}`,
          isDanger: true,
        })),
      ];
    } else if (activePanelKind === "teams") {
      const enabled = isAgentTeamsEnabled();
      const active = getActiveTeam();
      title = "Agent Teams";
      description = enabled
        ? active
          ? `active team: ${active.teamName}`
          : "enabled, no active team"
        : "disabled";
      options = [
        {
          id: "status",
          label: "Show team status",
          description: enabled ? "Inspect active team and members" : "Teams feature is disabled",
          command: "/teams",
        },
      ];
    } else if (activePanelKind === "config") {
      title = "Config";
      description = "Inspect or update merged settings.";
      options = [
        {
          id: "list",
          label: "List effective config",
          description: "Show merged settings and source for each key",
          command: "/config list",
        },
        {
          id: "sources",
          label: "Show config sources",
          description: "Show paths, trust state, and warnings",
          command: "/config sources",
        },
        {
          id: "trust",
          label: "Trust this project",
          description: "Allow project-level executable configuration",
          command: "/config trust",
        },
      ];
    }

    const selectedIndex = Math.max(
      0,
      Math.min(panelSelectionIndex, Math.max(0, options.length - 1)),
    );

    return {
      title,
      description,
      options,
      selectedIndex,
    };
  }, [
    activeModel,
    activePanelKind,
    activePermissionMode,
    asyncAgents,
    engine,
    panelSelectionIndex,
    sandboxSettings,
    sessions,
    taskMode,
  ]);

  const handleSubmit = useCallback(
    async (text: string): Promise<void> => {
      const trimmed = text.trim();

      if (!trimmed) {
        return;
      }

      if (trimmed === "/exit" || trimmed === "/quit") {
        exit();
        return;
      }

      setStreamingText("");
      setToolCalls([]);
      setErrorText(null);
      setInfoMessage(null);
      setSpinnerLabel("Thinking");
      setIsLoading(true);

      try {
        const loop = engine.submitMessage(trimmed);
        let accumulatedText = "";

        while (true) {
          const { value, done } = await loop.next();

          if (done) {
            if (value.terminationReason === "aborted") {
              setInfoMessage("Interrupted.");
            } else if (value.terminationReason === "model_error") {
              setErrorText(value.errorMessage ?? "Model error.");
            } else if (value.terminationReason === "max_turns") {
              setInfoMessage("Stopped after reaching the maximum tool turns.");
            } else if (value.terminationReason === "blocking_limit") {
              setErrorText("Context window limit reached. Use /compact to free space.");
            } else if (value.terminationReason === "max_output_tokens_recovery_limit") {
              setErrorText(
                "Output is still too long after recovery attempts. Ask for a smaller or segmented response.",
              );
            } else if (value.terminationReason === "prompt_too_long_after_compact") {
              setErrorText(
                value.errorMessage ??
                  "Context is still too long after automatic compaction. Use /compact or /clear.",
              );
            }

            setActiveModel(engine.getActiveModel());
            setActivePermissionMode(engine.getPermissionMode());
            break;
          }

          const event = value as QueryEngineEvent;

          switch (event.type) {
            case "messages_updated":
              setMessages(event.messages);
              break;
            case "usage_updated":
              setLastUsage({
                input: event.totalUsage.input_tokens,
                output: event.totalUsage.output_tokens,
              });
              break;
            case "context_budget_updated":
              setContextPercent(event.snapshot.percentUsed);
              break;
            case "token_warning": {
              setContextPercent(event.warning.percentUsed);
              if (event.warning.state === "warning") {
                setInfoMessage(
                  `Context window filling up — ${event.warning.percentUsed}% used. Consider /compact.`,
                );
              } else if (event.warning.state === "error") {
                setInfoMessage(
                  `Context window nearly full — ${event.warning.percentUsed}% used. Auto-compaction may trigger.`,
                );
              } else if (event.warning.state === "blocking") {
                setErrorText(
                  `Context window limit reached — ${event.warning.percentUsed}% used. Use /compact to free space.`,
                );
              }
              break;
            }
            case "compaction_started":
              setSpinnerLabel("Compacting");
              setInfoMessage(null);
              break;
            case "compaction_finished":
              setSpinnerLabel("Thinking");
              setInfoMessage(
                `Compacted: ${event.beforeMessageCount} -> ${event.afterMessageCount} messages`,
              );
              setContextPercent(
                Math.min(
                  100,
                  Math.ceil((event.afterTokens / 180_000) * 100),
                ),
              );
              break;
            case "api_retry":
              setSpinnerLabel(
                `Retrying in ${Math.ceil(event.delayMs / 1000)}s (${event.attempt}/${event.maxRetries})`,
              );
              setInfoMessage(
                `${event.category}: retrying in ${Math.ceil(event.delayMs / 1000)}s...`,
              );
              break;
            case "stream_restart":
              if (event.reason === "max_tokens_escalation") {
                setSpinnerLabel("Retrying with more output");
              } else if (event.reason === "max_tokens_continue") {
                setSpinnerLabel("Continuing output");
              } else {
                setSpinnerLabel("Retrying after compaction");
              }
              setInfoMessage(event.message);
              setStreamingText("");
              accumulatedText = "";
              break;
            case "command":
              if (event.kind === "error") {
                setErrorText(event.message);
              } else {
                setInfoMessage(event.message);
              }
              setActiveModel(engine.getActiveModel());
              setActivePermissionMode(engine.getPermissionMode());
              break;
            case "text":
              accumulatedText += event.text;
              setStreamingText(accumulatedText);
              break;
            case "tool_use_start":
              setToolCalls((prev) => [...prev, {
                id: event.id,
                name: event.name,
                ...(event.name === "Bash" && getBashProgress(event.id)
                  ? { bashProgress: getBashProgress(event.id) }
                  : {}),
              }]);
              break;
            case "tool_use_done":
              setToolCalls((prev) => {
                const next = [...prev];
                const index = next.findIndex(
                  (toolCall) =>
                    (event.id ? toolCall.id === event.id : true) &&
                    toolCall.name === event.name &&
                    toolCall.resultLength === undefined,
                );

                if (index !== -1) {
                  next[index] = {
                    ...next[index],
                    resultLength: event.resultLength,
                  };
                }

                return next;
              });
              break;
            case "assistant_message":
              accumulatedText = "";
              setStreamingText("");
              break;
            case "tool_result_message":
            case "turn_complete":
              break;
            case "error":
              if (event.error.name === "AbortError") {
                setInfoMessage("Interrupted.");
              } else {
                setErrorText(event.error.message);
              }
              break;
          }
        }
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          setInfoMessage("Interrupted.");
        } else {
          setErrorText(error instanceof Error ? error.message : String(error));
        }
      } finally {
        const clearPlan = pendingClearContextPlanRef.current;
        const feedback = pendingPlanFeedbackRef.current;

        pendingClearContextPlanRef.current = null;
        pendingPlanFeedbackRef.current = null;
        setIsLoading(false);
        setSpinnerLabel("Thinking");
        setStreamingText("");
        setToolCalls([]);
        setPendingPermission(null);
        permissionResolverRef.current = null;

        if (clearPlan) {
          const prompt = engine.clearContextAndImplement(clearPlan);
          void handleSubmit(prompt);
        } else if (feedback) {
          const prompt = engine.revisePlanWithFeedback(feedback);
          void handleSubmit(prompt);
        }
      }
    },
    [engine, exit],
  );

  const executePanelCommand = useCallback(async (command: string): Promise<void> => {
    if (command.startsWith("__sandbox:")) {
      const [, key, value] = command.split(":");
      const boolValue = value === "true";

      if (key === "enabled" || key === "allowUnsandboxedCommands") {
        await writeProjectSandboxSettings({
          cwd,
          patch: { [key]: boolValue },
        });
        const nextSettings = await loadSandboxSettings({ cwd });
        setSandboxSettings(nextSettings);
        setInfoMessage(`Sandbox ${key}: ${boolValue}`);
      }
      promptInput.setText("");
      return;
    }

    promptInput.setText("");
    await handleSubmit(command);
  }, [cwd, handleSubmit, promptInput]);

  useInput((input, key) => {
    if (trustInfo) {
      if (key.upArrow || key.downArrow) {
        setTrustSelectionIndex((prev) => prev === 0 ? 1 : 0);
        return;
      }

      if (key.escape || (key.ctrl && input === "c") || input === "n") {
        exit();
        return;
      }

      if (input === "y" || key.return) {
        if (trustSelectionIndex === 0 || input === "y") {
          void trustProject({ cwd }).then(async () => {
            setTrustInfo(null);
            setInfoMessage("Project trusted.");
            const { bootstrapMcp } = await import("../services/mcp/bootstrap.js");
            void bootstrapMcp(cwd);
          });
        } else {
          exit();
        }
        return;
      }

      return;
    }

    if (transcript.state.isOpen) {
      if (key.escape || (key.ctrl && input === "o")) {
        transcript.setState((state) => reduceTranscriptState(state, { type: "close" }));
        return;
      }

      if (transcript.state.isSearching) {
        if (key.return) {
          transcript.setState((state) =>
            reduceTranscriptState(state, {
              type: "search_commit",
              lines: transcriptLines,
            })
          );
          return;
        }

        if (key.backspace || key.delete) {
          transcript.setState((state) =>
            reduceTranscriptState(state, { type: "search_backspace" })
          );
          return;
        }

        if (input && !key.ctrl && !key.meta) {
          transcript.setState((state) =>
            reduceTranscriptState(state, { type: "search_append", text: input })
          );
          return;
        }
      }

      if (input === "/") {
        transcript.setState((state) => reduceTranscriptState(state, { type: "search_start" }));
        return;
      }

      if (input === "n") {
        transcript.setState((state) =>
          reduceTranscriptState(state, { type: "search_next", lines: transcriptLines })
        );
        return;
      }

      if (input === "N") {
        transcript.setState((state) =>
          reduceTranscriptState(state, {
            type: "search_previous",
            lines: transcriptLines,
          })
        );
        return;
      }

      if (input === "g") {
        transcript.setState((state) => reduceTranscriptState(state, { type: "top" }));
        return;
      }

      if (input === "G") {
        transcript.setState((state) =>
          reduceTranscriptState(state, {
            type: "bottom",
            lineCount: transcriptLines.length,
            height: transcript.height,
          })
        );
        return;
      }

      if (key.upArrow) {
        transcript.setState((state) =>
          reduceTranscriptState(state, {
            type: "scroll",
            delta: -1,
            lineCount: transcriptLines.length,
            height: transcript.height,
          })
        );
        return;
      }

      if (key.downArrow) {
        transcript.setState((state) =>
          reduceTranscriptState(state, {
            type: "scroll",
            delta: 1,
            lineCount: transcriptLines.length,
            height: transcript.height,
          })
        );
        return;
      }

      if (key.pageUp) {
        transcript.setState((state) =>
          reduceTranscriptState(state, {
            type: "scroll",
            delta: -transcript.height,
            lineCount: transcriptLines.length,
            height: transcript.height,
          })
        );
        return;
      }

      if (key.pageDown) {
        transcript.setState((state) =>
          reduceTranscriptState(state, {
            type: "scroll",
            delta: transcript.height,
            lineCount: transcriptLines.length,
            height: transcript.height,
          })
        );
        return;
      }

      return;
    }

    if (isPlanApprovalPermission(pendingPermission) && pendingPermission) {
      if (key.ctrl && input === "c") {
        pendingPermission.resolve(
          createPlanApprovalResponse({
            choice: "keep_planning",
            planContent: pendingPermission.planContent ?? "",
            feedback: "Plan approval cancelled.",
          }),
        );
        permissionResolverRef.current = null;
        setPendingPermission(null);
        setInfoMessage("Plan approval cancelled.");
        return;
      }

      if (key.upArrow) {
        setPlanApprovalIndex((prev) => movePlanApprovalSelection(prev, "up"));
        return;
      }

      if (key.downArrow) {
        setPlanApprovalIndex((prev) => movePlanApprovalSelection(prev, "down"));
        return;
      }

      const selected = PLAN_APPROVAL_OPTIONS[planApprovalIndex] ??
        PLAN_APPROVAL_OPTIONS[0];

      if (
        selected &&
        requiresPlanFeedback(selected.choice) &&
        (key.backspace || key.delete)
      ) {
        setPlanFeedback((prev) => prev.slice(0, -1));
        return;
      }

      if (
        selected &&
        requiresPlanFeedback(selected.choice) &&
        input &&
        !key.ctrl &&
        !key.meta &&
        !key.return
      ) {
        setPlanFeedback((prev) => prev + input);
        return;
      }

      if (key.return && selected) {
        const choice: PlanApprovalChoice = selected.choice;
        const feedback = planFeedback.trim();

        if (requiresPlanFeedback(choice) && !feedback) {
          setInfoMessage("Type feedback before keeping plan mode.");
          return;
        }

        const planContent = pendingPermission.planContent ?? "";
        pendingPermission.resolve(
          createPlanApprovalResponse({
            choice,
            planContent,
            ...(feedback && { feedback }),
          }),
        );

        if (choice === "allow_clear_context") {
          pendingClearContextPlanRef.current = planContent;
          engine.interrupt();
        } else if (choice === "keep_planning") {
          pendingPlanFeedbackRef.current = feedback;
          engine.interrupt();
        }

        permissionResolverRef.current = null;
        setPendingPermission(null);
        setPlanFeedback("");
        setPlanApprovalIndex(0);
        return;
      }

      return;
    }

    if (pendingPermission) {
      if ((key.ctrl && input === "c") || key.escape) {
        resolveNormalPermission(pendingPermission, "deny");
        return;
      }

      if (key.upArrow) {
        setPermissionSelectionIndex((prev) => movePermissionSelection(prev, "up"));
        return;
      }

      if (key.downArrow) {
        setPermissionSelectionIndex((prev) => movePermissionSelection(prev, "down"));
        return;
      }

      const shortcutResponse = input ? permissionResponseForKey(input) : null;
      if (shortcutResponse) {
        resolveNormalPermission(pendingPermission, shortcutResponse);
        return;
      }

      if (key.return) {
        resolveNormalPermission(
          pendingPermission,
          permissionResponseForIndex(permissionSelectionIndex),
        );
        return;
      }

      return;
    }

    if (teammateViewMode === "viewing") {
      if (key.escape) {
        setTeammateViewMode("main");
        setViewingAgentId(null);
        setTeammateOutputLines([]);
      }
      return;
    }

    if (teammateViewMode === "selecting") {
      if (key.escape) {
        setTeammateViewMode("main");
        return;
      }
      if (key.upArrow) {
        setTeammateSelectionIndex((prev) =>
          teammateAgents.length === 0
            ? 0
            : (prev - 1 + teammateAgents.length) % teammateAgents.length,
        );
        return;
      }
      if (key.downArrow) {
        setTeammateSelectionIndex((prev) =>
          teammateAgents.length === 0 ? 0 : (prev + 1) % teammateAgents.length,
        );
        return;
      }
      if (input === "k") {
        const selected = teammateAgents[teammateSelectionIndex];
        if (selected) {
          killAsyncAgent(selected.agentId);
          setInfoMessage(`Background agent killed: ${selected.agentId}`);
        }
        return;
      }
      if (key.return) {
        const selected = teammateAgents[teammateSelectionIndex];
        if (selected) {
          setViewingAgentId(selected.agentId);
          setTeammateViewMode("viewing");
        }
        return;
      }
      return;
    }

    if (key.shift && (key.downArrow || key.upArrow)) {
      if (teammateAgents.length > 0) {
        setTeammateViewMode("selecting");
      } else {
        setInfoMessage("No teammates are available to view.");
      }
      return;
    }

    if (key.ctrl && input === "o") {
      transcript.setState((state) => reduceTranscriptState(state, { type: "open" }));
      return;
    }

    if (key.ctrl && input === "c") {
      if (isLoading) {
        permissionResolverRef.current?.resolve("deny");
        permissionResolverRef.current = null;
        setPendingPermission(null);
        engine.interrupt();
        setIsLoading(false);
        setStreamingText("");
        setInfoMessage("Interrupted.");
      } else {
        exit();
      }
      return;
    }

    if (key.ctrl && input === "d") {
      exit();
      return;
    }

    const isShiftTab =
      ((key as { tab?: boolean }).tab === true && key.shift === true) ||
      input === "\u001b[Z";

    if (isLoading) {
      return;
    }

    if (isShiftTab) {
      const nextMode = nextPermissionMode(activePermissionMode);
      promptInput.setText("");
      void handleSubmit(`/mode ${nextMode}`);
      return;
    }

    if (commandPanel) {
      if (key.escape) {
        promptInput.setText("");
        return;
      }

      if (key.upArrow) {
        setPanelSelectionIndex((prev) =>
          movePanelSelection(prev, "up", commandPanel.options.length)
        );
        return;
      }

      if (key.downArrow) {
        setPanelSelectionIndex((prev) =>
          movePanelSelection(prev, "down", commandPanel.options.length)
        );
        return;
      }

      const numberIndex = input
        ? panelSelectionForInput(input, commandPanel.options.length)
        : null;
      if (numberIndex !== null) {
        const option = commandPanel.options[numberIndex];
        if (option) {
          void executePanelCommand(option.command);
        }
        return;
      }

      if (key.return) {
        const option = commandPanel.options[commandPanel.selectedIndex];
        if (option) {
          void executePanelCommand(option.command);
        }
        return;
      }

      if (!input || key.ctrl || key.meta) {
        return;
      }
    }

    if (commandSuggestions.length > 0) {
      const selected = commandSuggestions[commandSelectionIndex] ??
        commandSuggestions[0];
      const isTab = (key as { tab?: boolean }).tab === true || input === "\t";

      if (key.upArrow) {
        setCommandSelectionIndex((prev) =>
          moveCommandSelection(prev, "up", commandSuggestions.length)
        );
        return;
      }

      if (key.downArrow) {
        setCommandSelectionIndex((prev) =>
          moveCommandSelection(prev, "down", commandSuggestions.length)
        );
        return;
      }

      if (isTab && selected) {
        promptInput.setText(completeCommandSuggestion(selected));
        setCommandSelectionIndex(0);
        return;
      }

      if (key.return && selected) {
        promptInput.setText(completeCommandSuggestion(selected));
        setCommandSelectionIndex(0);
        return;
      }
    }

    handlePromptInputKey({
      input,
      key,
      editor: promptInput,
      onSubmit: (text) => {
        void handleSubmit(text);
      },
    });
  });

  if (trustInfo) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <AppHeader
          version={version}
          model={activeModel}
          mode={activePermissionMode}
          cwd={cwd}
          contextPercent={contextPercent}
          startupDurationMs={startupDurationMs}
        />
        <TrustProjectDialog
          info={trustInfo}
          selectedIndex={trustSelectionIndex}
        />
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      {transcript.state.isOpen ? (
        <TranscriptOverlay
          lines={transcript.visibleLines}
          totalLines={transcriptLines.length}
          state={transcript.state}
        />
      ) : teammateViewMode === "viewing" ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="cyan" bold>
            {`Viewing ${asyncAgents.find((agent) => agent.agentId === viewingAgentId)?.teammateName ?? viewingAgentId}`}
          </Text>
          <Text dimColor>Esc returns to the main conversation.</Text>
          {teammateOutputLines.map((line, index) => (
            <Text key={`viewer-${index}`}>{line}</Text>
          ))}
        </Box>
      ) : (
        <ConversationView items={historyItemsWithHeader} epoch={staticEpoch} />
      )}

      {isLoading && toolCalls.map((toolCall, index) => (
        <Box key={`tc${index}`} marginLeft={2}>
          {toolCall.resultLength !== undefined ? (
            <Text color="green">
              {"ok "}
              {toolCall.name} ({toolCall.resultLength} chars)
            </Text>
          ) : (
            <Text color="yellow">Using tool: {formatToolCall(toolCall)}</Text>
          )}
        </Box>
      ))}

      {taskMode === "task" ? <TaskList tasks={tasks} /> : <TodoList todos={todos} />}

      {asyncAgents.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>
            Background agents
            {teammateAgents.length > 0 ? " · Shift+↓ select teammate" : ""}
          </Text>
          {asyncAgents.slice(-5).map((agent) => (
            <Text
              key={agent.agentId}
              color={agent.status === "running" ? "yellow" : agent.status === "completed" ? "green" : "red"}
            >
              {"  "}
              {formatAsyncAgentStatus(agent)}
            </Text>
          ))}
        </Box>
      )}

      {teammateViewMode === "selecting" && (
        <Box flexDirection="column" marginTop={1} borderStyle="round" paddingX={1}>
          <Text color="cyan" bold>Teammates</Text>
          {teammateAgents.length === 0 ? (
            <Text dimColor>No teammates.</Text>
          ) : teammateAgents.map((agent, index) => (
            <Text
              key={agent.agentId}
              color={index === teammateSelectionIndex ? "cyan" : undefined}
            >
              {index === teammateSelectionIndex ? "> " : "  "}
              {formatAsyncAgentStatus(agent)}
            </Text>
          ))}
          <Text dimColor>Up/Down select, Enter view output, k kill, Esc close</Text>
        </Box>
      )}

      {pendingPermission && (
        isPlanApprovalPermission(pendingPermission) ? (
          <PlanApprovalDialog
            pending={pendingPermission}
            selectedIndex={planApprovalIndex}
            feedback={planFeedback}
          />
        ) : (
          <PermissionRequestCard
            decision={pendingPermission.decision}
            selectedIndex={permissionSelectionIndex}
          />
        )
      )}

      {isLoading && !streamingText && (
        <Spinner
          label={
            taskMode === "task"
              ? getInProgressTask(tasks)?.activeForm ??
                getInProgressTask(tasks)?.subject ??
                spinnerLabel
              : getInProgressTodo(todos)?.activeForm ?? spinnerLabel
          }
        />
      )}

      {isLoading && streamingText && (
        <Box>
          <Text color="magenta">{"| "}</Text>
          <StreamingMarkdownText content={streamingText} />
        </Box>
      )}

      {errorText && (
        <Text color="red">
          Error: {errorText}
        </Text>
      )}

      {infoMessage && <Text dimColor>  {infoMessage}</Text>}

      {lastUsage && !isLoading && (
        <Text dimColor>
          {"  tokens: "}
          {lastUsage.input} in / {lastUsage.output} out
          {contextPercent !== null ? ` / context: ${contextPercent}%` : ""}
        </Text>
      )}

      {!isLoading && (
        <>
          {commandPanel ? (
            <CommandPanel panel={commandPanel} />
          ) : (
            <CommandSuggestions items={commandSuggestions} />
          )}
          <InputPrompt value={promptInput.value} cursor={promptInput.cursor} />
          <Text dimColor>
            {"  context: "}
            {contextPercent !== null ? `${contextPercent}%` : "--"}
            {" · mode: "}
            {activePermissionMode}
            {" · model: "}
            {activeModel}
            {" · Shift+Tab cycles mode"}
          </Text>
        </>
      )}
    </Box>
  );
}

