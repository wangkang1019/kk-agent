import {
  completeAsyncAgent,
  failAsyncAgent,
  getAsyncAgent,
  updateAsyncAgentProgress,
  type AsyncAgentEntry,
} from "../state/asyncAgentStore.js";
import {
  enqueuePendingNotification,
  formatTaskNotification,
} from "../state/notificationStore.js";
import {
  appendTaskOutput,
} from "./taskOutput.js";
import {
  cleanupWorktreeIfNeeded,
  type WorktreeInfo,
} from "./worktree.js";
import type { AgentDefinition } from "./types.js";
import type { Tool, ToolContext } from "../tools/Tool.js";
import type { RunChildAgentParams } from "./runAgent.js";
import { setMemberActive, type TeammateIdentity } from "../teams/index.js";

export interface RunAsyncAgentLifecycleParams {
  entry: AsyncAgentEntry;
  agentDefinition: AgentDefinition;
  prompt: string;
  availableTools: Tool[];
  model?: string;
  parentToolContext: ToolContext;
  worktreeInfo?: WorktreeInfo;
  teammateIdentity?: TeammateIdentity;
  runChildAgent: (params: RunChildAgentParams) => Promise<{
    finalText: string;
    reason: string;
    totalDurationMs: number;
    totalTokens: number;
    totalToolUseCount: number;
    inputTokens: number;
    outputTokens: number;
    turnCount: number;
  }>;
}

export async function runAsyncAgentLifecycle(
  params: RunAsyncAgentLifecycleParams,
): Promise<void> {
  const { entry } = params;
  const startedAt = Date.now();

  await appendTaskOutput(entry.outputFile, {
    type: "started",
    agentType: entry.agentType,
    description: entry.description,
    prompt: params.prompt,
  });

  try {
    const result = await params.runChildAgent({
      agentDefinition: params.agentDefinition,
      prompt: params.prompt,
      availableTools: params.availableTools,
      model: params.model,
      cwd: params.parentToolContext.cwd,
      cwdOverride: params.worktreeInfo?.worktreePath,
      parentToolContext: params.parentToolContext,
      permissionMode: params.parentToolContext.getPermissionMode?.(),
      permissionSettings: params.parentToolContext.permissions?.settings,
      sessionAllowRules: params.parentToolContext.permissions?.sessionAllowRules,
      abortSignal: entry.abortController.signal,
      shouldAvoidPermissionPrompts: true,
      querySource: "background",
      teammateIdentity: params.teammateIdentity,
      onProgress: (event) => {
        if (event.type === "text" && event.text) {
          void appendTaskOutput(entry.outputFile, {
            type: "text",
            text: event.text,
          });
        } else if (event.type === "tool_use_start" && event.toolName) {
          void appendTaskOutput(entry.outputFile, {
            type: "tool_use",
            toolName: event.toolName,
          });
          updateAsyncAgentProgress(entry.agentId, {
            lastToolName: event.toolName,
          });
        } else if (event.type === "tool_use_done" && event.toolName) {
          const nextToolUseCount = (entry.toolUseCount ?? 0) + 1;
          entry.toolUseCount = nextToolUseCount;
          void appendTaskOutput(entry.outputFile, {
            type: "tool_result",
            toolName: event.toolName,
            isError: event.isError === true,
          });
          updateAsyncAgentProgress(entry.agentId, {
            lastToolName: event.toolName,
            toolUseCount: nextToolUseCount,
          });
        } else if (event.type === "turn_usage" && event.cumulativeUsage) {
          const inputTokens = event.cumulativeUsage.input_tokens;
          const outputTokens = event.cumulativeUsage.output_tokens;
          const totalTokens = inputTokens + outputTokens;
          void appendTaskOutput(entry.outputFile, {
            type: "turn_usage",
            inputTokens,
            outputTokens,
            totalTokens,
          });
          updateAsyncAgentProgress(entry.agentId, {
            inputTokens,
            outputTokens,
            totalTokens,
          });
        }
      },
    });
    const durationMs = Date.now() - startedAt;
    const worktreeFinal = await cleanupWorktreeIfNeeded(params.worktreeInfo);

    await appendTaskOutput(entry.outputFile, {
      type: "completed",
      reason: result.reason,
      finalText: result.finalText,
      durationMs,
      totalTokens: result.totalTokens,
      toolUseCount: result.totalToolUseCount,
    });
    if (getAsyncAgent(entry.agentId)?.status !== "killed") {
      completeAsyncAgent(entry.agentId, {
        finalText: result.finalText,
        reason: result.reason,
        durationMs,
        totalTokens: result.totalTokens,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        turnCount: result.turnCount,
        toolUseCount: result.totalToolUseCount,
        ...(worktreeFinal?.worktreePath && {
          worktreePath: worktreeFinal.worktreePath,
        }),
        ...(worktreeFinal?.worktreeBranch && {
          worktreeBranch: worktreeFinal.worktreeBranch,
        }),
      });
    }
    enqueuePendingNotification({
      mode: "task-notification",
      text: formatTaskNotification({
        agentId: entry.agentId,
        agentType: entry.agentType,
        status: result.reason === "aborted" ? "killed" : "completed",
        description: entry.description,
        outputFile: entry.outputFile,
        finalText: result.finalText,
        durationMs,
        totalTokens: result.totalTokens,
        toolUseCount: result.totalToolUseCount,
        ...(worktreeFinal?.worktreePath && {
          worktreePath: worktreeFinal.worktreePath,
        }),
        ...(worktreeFinal?.worktreeBranch && {
          worktreeBranch: worktreeFinal.worktreeBranch,
        }),
      }),
    });
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const message = error instanceof Error ? error.message : String(error);
    const worktreeFinal = await cleanupWorktreeIfNeeded(params.worktreeInfo);

    await appendTaskOutput(entry.outputFile, {
      type: "failed",
      error: message,
      durationMs,
    });
    if (getAsyncAgent(entry.agentId)?.status !== "killed") {
      failAsyncAgent(entry.agentId, message, {
        durationMs,
        ...(worktreeFinal?.worktreePath && {
          worktreePath: worktreeFinal.worktreePath,
        }),
        ...(worktreeFinal?.worktreeBranch && {
          worktreeBranch: worktreeFinal.worktreeBranch,
        }),
      });
    }
    enqueuePendingNotification({
      mode: "task-notification",
      text: formatTaskNotification({
        agentId: entry.agentId,
        agentType: entry.agentType,
        status: "failed",
        description: entry.description,
        outputFile: entry.outputFile,
        error: message,
        durationMs,
        ...(worktreeFinal?.worktreePath && {
          worktreePath: worktreeFinal.worktreePath,
        }),
        ...(worktreeFinal?.worktreeBranch && {
          worktreeBranch: worktreeFinal.worktreeBranch,
        }),
      }),
    });
  } finally {
    if (params.teammateIdentity) {
      await setMemberActive(
        params.teammateIdentity.teamName,
        params.teammateIdentity.agentName,
        false,
      ).catch(() => {});
    }
  }
}
