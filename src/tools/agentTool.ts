import { DEFAULT_MODEL } from "../services/api/anthropic.js";
import { registerAsyncAgent } from "../state/asyncAgentStore.js";
import {
  completeSubAgentProgress,
  startSubAgentProgress,
  updateSubAgentProgress,
} from "../state/subAgentProgressStore.js";
import { findAgent, getAllAgents } from "../agents/registry.js";
import type { AgentProgressEvent } from "../agents/types.js";
import type { Tool, ToolContext, ToolResult } from "./Tool.js";
import type { RunChildAgentParams } from "../agents/runAgent.js";
import { ensureTaskOutputFile } from "../agents/taskOutput.js";
import {
  cleanupWorktreeIfNeeded,
  createAgentWorktree,
  type WorktreeInfo,
} from "../agents/worktree.js";
import { runAsyncAgentLifecycle } from "../agents/runAsyncAgent.js";
import {
  TEAM_LEAD_NAME,
  addTeamMember,
  formatAgentId,
  getActiveTeam,
  isAgentTeamsEnabled,
  sanitizeMemberName,
  sanitizeTeamName,
  type TeammateIdentity,
} from "../teams/index.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function loadAllTools(): Promise<Tool[]> {
  const { getAllTools } = await import("./registry.js");
  return getAllTools();
}

async function defaultRunAgent(params: RunChildAgentParams) {
  const { runChildAgent } = await import("../agents/runAgent.js");
  return runChildAgent(params);
}

function shortId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function formatAgentResult(params: {
  agentType: string;
  description: string;
  finalText: string;
  turnCount: number;
  totalToolUseCount: number;
  totalTokens: number;
  reason: string;
  warnings?: string[];
}): string {
  return [
    `Sub-agent '${params.agentType}' completed.`,
    params.description ? `task: ${params.description}` : "",
    `reason: ${params.reason}`,
    `turns: ${params.turnCount} | tools used: ${params.totalToolUseCount}`,
    `tokens: ${params.totalTokens}`,
    params.warnings?.length ? `warnings: ${params.warnings.join("; ")}` : "",
    "",
    "<sub_agent_result>",
    params.finalText,
    "</sub_agent_result>",
  ].filter(Boolean).join("\n");
}

function handleProgress(toolUseId: string | undefined, event: AgentProgressEvent): void {
  if (!toolUseId) {
    return;
  }

  if (event.type === "tool_use_start") {
    const current = event.toolName;
    updateSubAgentProgress(toolUseId, {
      ...(current && { lastToolName: current }),
    });
  } else if (event.type === "tool_use_done") {
    updateSubAgentProgress(toolUseId, {
      ...(event.toolName && { lastToolName: event.toolName }),
      ...(event.isError !== undefined && { lastToolIsError: event.isError }),
    });
  } else if (event.type === "turn_usage" && event.cumulativeUsage) {
    updateSubAgentProgress(toolUseId, {
      inputTokens: event.cumulativeUsage.input_tokens,
      outputTokens: event.cumulativeUsage.output_tokens,
      totalTokens:
        event.cumulativeUsage.input_tokens + event.cumulativeUsage.output_tokens,
    });
  }
}

export function createAgentTool(
  runAgent: (params: RunChildAgentParams) => ReturnType<typeof defaultRunAgent> = defaultRunAgent,
): Tool {
  return {
    name: "Agent",
    description: "Delegate a focused subtask to a SubAgent with isolated context and a filtered tool pool.",
    inputSchema: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description: "Self-contained task prompt for the SubAgent.",
      },
      description: {
        type: "string",
        description: "Short 3-5 word task description shown in progress UI.",
      },
      subagent_type: {
        type: "string",
        description: "SubAgent type to use. Defaults to general-purpose.",
      },
      model: {
        type: "string",
        description: "Optional model override for this SubAgent run.",
      },
      run_in_background: {
        type: "boolean",
        description: "Run the SubAgent in the background and notify the parent conversation later.",
      },
      isolation: {
        type: "string",
        enum: ["none", "worktree"],
        description: "Optional isolation mode. Use worktree to run in a separate git worktree.",
      },
      name: {
        type: "string",
        description: "Optional teammate name when spawning an Agent Team member.",
      },
      team_name: {
        type: "string",
        description: "Team name for a named teammate. Must be used with name.",
      },
    },
    required: ["prompt", "description"],
    additionalProperties: false,
    },
    async call(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    if (!isRecord(input)) {
      return { content: "Error: Agent input must be an object.", isError: true };
    }

    const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
    const description = typeof input.description === "string"
      ? input.description.trim()
      : "";
    const agentType = typeof input.subagent_type === "string" && input.subagent_type.trim()
      ? input.subagent_type.trim()
      : "general-purpose";
    const rawTeammateName = typeof input.name === "string" ? input.name.trim() : "";
    const rawTeamName = typeof input.team_name === "string" ? input.team_name.trim() : "";
    const teammateName = rawTeammateName ? sanitizeMemberName(rawTeammateName) : "";
    const teamName = rawTeamName ? sanitizeTeamName(rawTeamName) : "";

    if (!prompt) {
      return { content: "Error: prompt is required.", isError: true };
    }

    if (teammateName || teamName) {
      if (!isAgentTeamsEnabled()) {
        return { content: "Error: Agent Teams feature is not enabled.", isError: true };
      }
      if (!teammateName || !teamName) {
        return { content: "Error: name and team_name must be used together.", isError: true };
      }
      const activeTeam = getActiveTeam();
      if (!activeTeam) {
        return { content: "Error: no team is active.", isError: true };
      }
      if (activeTeam.teamName !== teamName) {
        return { content: "Error: team_name doesn't match active team.", isError: true };
      }
      if (teammateName === TEAM_LEAD_NAME) {
        return { content: "Error: team-lead is reserved.", isError: true };
      }
      if (context.teammateIdentity) {
        return { content: "Error: nested teammate spawn rejected.", isError: true };
      }
      if (input.run_in_background !== true) {
        return { content: "Error: named teammates must run in background.", isError: true };
      }
    }

    const agent = findAgent(agentType);

    if (!agent) {
      return {
        content: [
          `Error: unknown sub-agent '${agentType}'.`,
          `Available: ${getAllAgents().map((item) => item.agentType).join(", ")}`,
        ].join("\n"),
        isError: true,
      };
    }

      if (context.toolUseId) {
        startSubAgentProgress(context.toolUseId, {
          agentType,
          description,
          ...(teammateName && { teammateName }),
          ...(teamName && { teamName }),
        });
      }

    try {
      const model = typeof input.model === "string" && input.model.trim()
        ? input.model.trim()
        : agent.model ?? context.defaultModel ?? DEFAULT_MODEL;
      const allTools = context.availableTools ?? await loadAllTools();
      const isolationInput = typeof input.isolation === "string" ? input.isolation : undefined;
      const isolation = isolationInput === "worktree" || isolationInput === "none"
        ? isolationInput
        : agent.isolation ?? "none";
      const warnings: string[] = [];
      let worktreeInfo: WorktreeInfo | undefined;

      if (isolation === "worktree") {
        try {
          worktreeInfo = await createAgentWorktree(
            `agent-${agentType}-${shortId()}`,
            context.cwd,
          );
        } catch (error) {
          warnings.push(
            `Worktree isolation requested but unavailable: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      if (input.run_in_background === true) {
        const teammateIdentity: TeammateIdentity | undefined = teammateName && teamName
          ? {
            agentId: formatAgentId(teammateName, teamName),
            agentName: teammateName,
            teamName,
          }
          : undefined;
        const agentId = teammateIdentity?.agentId ?? shortId();
        const outputFile = await ensureTaskOutputFile({
          cwd: context.cwd,
          sessionId: context.sessionId ?? "default",
          agentId,
        });
        if (teammateIdentity) {
          await addTeamMember(teamName, {
            agentId,
            name: teammateName,
            agentType,
            joinedAt: Date.now(),
            isActive: true,
            outputFile,
            ...(worktreeInfo?.worktreePath && {
              worktreePath: worktreeInfo.worktreePath,
            }),
            ...(worktreeInfo?.worktreeBranch && {
              worktreeBranch: worktreeInfo.worktreeBranch,
            }),
            ...(worktreeInfo?.gitRoot && {
              gitRoot: worktreeInfo.gitRoot,
            }),
          });
        }
        const entry = registerAsyncAgent({
          agentId,
          agentType,
          description,
          prompt,
          outputFile,
          ...(teammateName && { teammateName }),
          ...(teamName && { teamName }),
          ...(worktreeInfo?.worktreePath && {
            worktreePath: worktreeInfo.worktreePath,
          }),
          ...(worktreeInfo?.worktreeBranch && {
            worktreeBranch: worktreeInfo.worktreeBranch,
          }),
        });

        void runAsyncAgentLifecycle({
          entry,
          agentDefinition: agent,
          prompt,
          availableTools: allTools,
          model,
          parentToolContext: context,
          worktreeInfo,
          teammateIdentity,
          runChildAgent: runAgent,
        });

        return {
          content: [
            `Sub-agent '${agentType}' launched in the background.`,
            `task: ${description}`,
            `agent_id: ${agentId}`,
            teammateIdentity ? `teammate: ${teammateIdentity.agentName}@${teammateIdentity.teamName}` : "",
            `output_file: ${outputFile}`,
            worktreeInfo
              ? `worktree: ${worktreeInfo.worktreePath} (branch: ${worktreeInfo.worktreeBranch})`
              : "",
            warnings.length ? `warnings: ${warnings.join("; ")}` : "",
            "",
            "<async_launched>",
            `  <agent_id>${agentId}</agent_id>`,
            teammateIdentity ? `  <teammate>${teammateIdentity.agentName}</teammate>` : "",
            teammateIdentity ? `  <team_name>${teammateIdentity.teamName}</team_name>` : "",
            `  <output_file>${outputFile}</output_file>`,
            worktreeInfo ? `  <worktree_path>${worktreeInfo.worktreePath}</worktree_path>` : "",
            "</async_launched>",
          ].filter(Boolean).join("\n"),
        };
      }

      const result = await runAgent({
        agentDefinition: agent,
        prompt,
        availableTools: allTools,
        model,
        cwd: context.cwd,
        cwdOverride: worktreeInfo?.worktreePath,
        parentToolContext: context,
        permissionMode: context.getPermissionMode?.(),
        permissionSettings: context.permissions?.settings,
        sessionAllowRules: context.permissions?.sessionAllowRules,
        requestPermission: context.permissions?.requestPermission,
        abortSignal: context.abortSignal,
        onProgress: (event) => handleProgress(context.toolUseId, event),
      });
      const worktreeFinal = await cleanupWorktreeIfNeeded(worktreeInfo);

      if (context.toolUseId) {
        completeSubAgentProgress(context.toolUseId, {
          status: result.reason === "completed" ? "completed" : "error",
          durationMs: result.totalDurationMs,
          toolUseCount: result.totalToolUseCount,
          totalTokens: result.totalTokens,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
        });
      }

      return {
        content: formatAgentResult({
          agentType,
          description,
          finalText: result.finalText,
          turnCount: result.turnCount,
          totalToolUseCount: result.totalToolUseCount,
          totalTokens: result.totalTokens,
          reason: result.reason,
          warnings: [
            ...(result.warnings ?? []),
            ...warnings,
            ...(worktreeFinal?.worktreePath
              ? [`Worktree preserved: ${worktreeFinal.worktreePath} (${worktreeFinal.worktreeBranch})`]
              : []),
          ],
        }),
      };
    } catch (error) {
      if (context.toolUseId) {
        completeSubAgentProgress(context.toolUseId, { status: "error" });
      }

      return {
        content: `Error: SubAgent failed: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }
    },
    isReadOnly(): boolean {
      return true;
    },
    isEnabled(): boolean {
      return true;
    },
    isConcurrencySafe(): boolean {
      return true;
    },
  };
}

export const agentTool = createAgentTool();
