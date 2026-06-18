import type { Tool as AnthropicTool } from "@anthropic-ai/sdk/resources/messages/messages";

import {
  query as defaultQuery,
  type QueryEvent,
  type QueryParams,
  type QueryResult,
} from "../core/agenticLoop.js";
import type { Tool, ToolContext } from "../tools/Tool.js";
import type { Message, Usage } from "../types/message.js";
import { resolveAgentTools } from "./resolveAgentTools.js";
import {
  drainUnreadMessages,
  formatMailboxAttachment,
  type TeammateIdentity,
} from "../teams/index.js";
import {
  formatHookContextMessage,
  runSubagentStopHooks,
} from "../hooks/index.js";
import type {
  AgentDefinition,
  AgentProgressEvent,
  AgentRunResult,
} from "./types.js";

export const DEFAULT_AGENT_MAX_TURNS = 30;

export interface RunChildAgentParams {
  agentDefinition: AgentDefinition;
  prompt: string;
  availableTools: Tool[];
  model?: string;
  cwd: string;
  cwdOverride?: string;
  parentToolContext: ToolContext;
  permissionMode?: QueryParams["permissionMode"];
  permissionSettings?: QueryParams["permissionSettings"];
  sessionAllowRules?: string[];
  requestPermission?: QueryParams["requestPermission"];
  shouldAvoidPermissionPrompts?: boolean;
  querySource?: QueryParams["querySource"];
  teammateIdentity?: TeammateIdentity;
  abortSignal?: AbortSignal;
  query?: (
    params: QueryParams,
  ) => AsyncGenerator<QueryEvent, QueryResult>;
  onProgress?: (event: AgentProgressEvent) => void;
}

function toolToApiParam(tool: Tool): AnthropicTool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as AnthropicTool["input_schema"],
  };
}

function addUsage(left: Usage, right: Usage): Usage {
  return {
    input_tokens: left.input_tokens + right.input_tokens,
    output_tokens: left.output_tokens + right.output_tokens,
  };
}

export function extractFinalAssistantText(messages: Message[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];

    if (message?.role !== "assistant") {
      continue;
    }

    if (typeof message.content === "string" && message.content.trim()) {
      return message.content.trim();
    }

    if (Array.isArray(message.content)) {
      const text = message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();

      if (text) {
        return text;
      }
    }
  }

  return "(SubAgent completed but produced no text output.)";
}

function countToolUses(messages: Message[]): number {
  return messages.reduce((count, message) => {
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      return count;
    }

    return count + message.content.filter((block) => block.type === "tool_use").length;
  }, 0);
}

export async function runChildAgent(
  params: RunChildAgentParams,
): Promise<AgentRunResult> {
  const start = Date.now();
  const agent = params.agentDefinition;
  const resolved = resolveAgentTools(agent, params.availableTools);
  const childSessionId = [
    params.parentToolContext.sessionId ?? "session",
    `agent-${agent.agentType}-${Date.now().toString(36)}`,
  ].join("/");
  const query = params.query ?? defaultQuery;
  const mailboxAttachment = params.teammateIdentity
    ? formatMailboxAttachment(
      await drainUnreadMessages(
        params.teammateIdentity.agentName,
        params.teammateIdentity.teamName,
      ),
    )
    : "";
  const initialMessages: Message[] = [
    {
      role: "user",
      content: mailboxAttachment
        ? `${mailboxAttachment}\n\n${params.prompt}`
        : params.prompt,
    },
  ];
  let finalMessages = initialMessages;
  let totalUsage: Usage = { input_tokens: 0, output_tokens: 0 };
  let turnCount = 0;
  let reason = "completed";

  const loop = query({
    messages: initialMessages,
    model: params.model ?? agent.model,
    system: agent.getSystemPrompt(),
    maxTurns: agent.maxTurns ?? DEFAULT_AGENT_MAX_TURNS,
    cwd: params.cwdOverride ?? params.cwd,
    homeDir: params.parentToolContext.homeDir,
    signal: params.abortSignal ?? params.parentToolContext.abortSignal,
    permissionMode: agent.permissionMode ?? params.permissionMode,
    permissionSettings: params.permissionSettings,
    sessionAllowRules: params.sessionAllowRules,
    requestPermission: params.shouldAvoidPermissionPrompts
      ? undefined
      : params.requestPermission,
    sessionId: childSessionId,
    allowedTools: resolved.resolvedTools,
    getTools: () => resolved.resolvedTools.map(toolToApiParam),
    teammateIdentity: params.teammateIdentity,
    querySource: params.querySource ?? "foreground",
  });

  while (true) {
    const { value, done } = await loop.next();

    if (done) {
      finalMessages = value.messages;
      totalUsage = addUsage(totalUsage, value.usage);
      turnCount = value.turnCount;
      reason = value.terminationReason;
      break;
    }

    if (value.type === "text") {
      params.onProgress?.({ type: "text", text: value.text });
    } else if (value.type === "tool_use_start") {
      params.onProgress?.({ type: "tool_use_start", toolName: value.name });
    } else if (value.type === "tool_use_done") {
      params.onProgress?.({
        type: "tool_use_done",
        toolName: value.name,
        isError: value.isError,
      });
    } else if (value.type === "turn_complete") {
      params.onProgress?.({
        type: "turn_usage",
        cumulativeUsage: value.usage,
      });
    }
  }

  let finalText = extractFinalAssistantText(finalMessages);
  const subagentStopOutcome = await runSubagentStopHooks({
    agentType: agent.agentType,
    lastAssistantMessage: finalText,
    cwd: params.cwdOverride ?? params.cwd,
    homeDir: params.parentToolContext.homeDir,
    sessionId: childSessionId,
    signal: params.abortSignal ?? params.parentToolContext.abortSignal,
  });
  const hookContext = subagentStopOutcome.additionalContext ??
    subagentStopOutcome.systemMessage ??
    subagentStopOutcome.blockingError;

  if (hookContext) {
    finalText = `${finalText}\n\n${formatHookContextMessage("SubagentStop", hookContext)}`;
  }

  return {
    agentType: agent.agentType,
    finalText,
    messages: finalMessages,
    totalToolUseCount: countToolUses(finalMessages),
    totalDurationMs: Date.now() - start,
    totalTokens: totalUsage.input_tokens + totalUsage.output_tokens,
    inputTokens: totalUsage.input_tokens,
    outputTokens: totalUsage.output_tokens,
    turnCount,
    reason,
    ...(resolved.invalidTools.length > 0 && {
      warnings: [`Unknown tools ignored: ${resolved.invalidTools.join(", ")}`],
    }),
  };
}
