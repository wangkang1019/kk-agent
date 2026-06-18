import type {
  Tool as AnthropicTool,
} from "@anthropic-ai/sdk/resources/messages/messages";

import type {
  AssistantMessage,
  ContentBlock,
  Message,
  StreamRequestParams,
  StreamResult,
  StreamEvent,
  Usage,
  UserMessage,
} from "../types/message.js";
import { buildSystemPrompt } from "../context/systemPrompt.js";
import {
  calculateTokenWarningState,
  compactMessages as defaultCompactMessages,
  type CompactMessagesParams,
  type CompactMessagesResult,
  estimateMessagesTokens,
  type TokenWarningState,
} from "../context/compaction.js";
import {
  loadPermissionSettings,
  type PermissionMode,
  type PermissionResponse,
  type PermissionSettings,
  type PermissionDecision,
} from "../permissions/permissions.js";
import { streamMessage } from "../services/api/stream.js";
import {
  CAPPED_DEFAULT_MAX_TOKENS,
  ESCALATED_MAX_TOKENS,
} from "../services/api/anthropic.js";
import {
  getUserFacingErrorMessage,
  isPromptTooLongError,
} from "../services/api/errors.js";
import { executeTools } from "../tools/executeTools.js";
import { getToolsApiParams } from "../tools/registry.js";
import type { Tool, ToolContext } from "../tools/Tool.js";
import type { TeammateIdentity } from "../teams/types.js";
import {
  formatHookContextMessage,
  runStopHooks,
} from "../hooks/index.js";

export const DEFAULT_MAX_TOOL_TURNS = 50;
export const MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3;
export const OUTPUT_TOKENS_RECOVERY_PROMPT =
  "Output token limit hit. Resume directly - no apology, no recap. Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.";

export interface LoopState {
  messages: Message[];
  turnCount: number;
  aborted: boolean;
}

export type LoopTerminationReason =
  | "completed"
  | "aborted"
  | "model_error"
  | "max_turns"
  | "blocking_limit"
  | "max_output_tokens_recovery_limit"
  | "prompt_too_long_after_compact";

export interface QueryParams {
  messages: Message[];
  model?: string;
  system?: string;
  maxTurns?: number;
  cwd?: string;
  homeDir?: string;
  signal?: AbortSignal;
  permissionMode?: PermissionMode;
  permissionSettings?: PermissionSettings;
  sessionAllowRules?: string[];
  allowedRoots?: string[];
  planFilePath?: string;
  planHomeDir?: string;
  planSessionId?: string;
  sessionId?: string;
  currentMessageId?: string;
  fileHistory?: ToolContext["fileHistory"];
  getTools?: () => AnthropicTool[];
  getPermissionMode?: () => PermissionMode;
  setPermissionMode?: (mode: PermissionMode) => void;
  addSessionAllowRules?: (rules: string[]) => void;
  allowedTools?: Tool[];
  teammateIdentity?: TeammateIdentity;
  requestPermission?: (
    decision: PermissionDecision,
  ) => Promise<PermissionResponse>;
  stream?: (
    params: StreamRequestParams,
  ) => AsyncGenerator<StreamEvent, StreamResult>;
  compactMessages?: (
    messages: Message[],
    params: CompactMessagesParams,
  ) => Promise<CompactMessagesResult>;
  querySource?: StreamRequestParams["querySource"];
  maxRetries?: number;
}

export interface QueryResult {
  messages: Message[];
  usage: Usage;
  terminationReason: LoopTerminationReason;
  turnCount: number;
  error?: Error;
}

export type QueryEvent =
  | StreamEvent
  | {
      type: "assistant_message";
      message: AssistantMessage;
    }
  | {
      type: "tool_result_message";
      message: UserMessage;
    }
  | {
      type: "turn_complete";
      usage: Usage;
      turnCount: number;
    }
  | {
      type: "token_warning";
      warning: TokenWarningState;
    }
  | {
      type: "tool_use_done";
      id?: string;
      name: string;
      resultLength: number;
      isError?: boolean;
    };

export async function runTools(
  contentBlocks: ContentBlock[],
  toolContext: ToolContext,
): Promise<UserMessage> {
  return executeTools(contentBlocks, toolContext);
}

function addUsage(left: Usage, right: Usage): Usage {
  return {
    input_tokens: left.input_tokens + right.input_tokens,
    output_tokens: left.output_tokens + right.output_tokens,
  };
}

function getToolUseBlocks(
  contentBlocks: ContentBlock[],
): Extract<ContentBlock, { type: "tool_use" }>[] {
  return contentBlocks.filter(
    (block): block is Extract<ContentBlock, { type: "tool_use" }> =>
      block.type === "tool_use",
  );
}

function getAssistantText(message: AssistantMessage): string {
  if (typeof message.content === "string") {
    return message.content;
  }

  return message.content
    .filter((block): block is Extract<ContentBlock, { type: "text" }> =>
      block.type === "text"
    )
    .map((block) => block.text)
    .join("");
}

function createResult(
  state: LoopState,
  usage: Usage,
  terminationReason: LoopTerminationReason,
  error?: Error,
): QueryResult {
  return {
    messages: state.messages,
    usage,
    terminationReason,
    turnCount: state.turnCount,
    ...(error && { error }),
  };
}

async function* consumeStreamTurn(params: {
  stream: (params: StreamRequestParams) => AsyncGenerator<StreamEvent, StreamResult>;
  request: StreamRequestParams;
}): AsyncGenerator<StreamEvent, StreamResult | null> {
  const generator = params.stream(params.request);

  while (true) {
    const { value, done } = await generator.next();

    if (done) {
      return value ?? null;
    }

    if (value.type === "error") {
      throw value.error;
    }

    yield value;
  }
}

export async function* query(
  params: QueryParams,
): AsyncGenerator<QueryEvent, QueryResult> {
  let state: LoopState = {
    messages: [...params.messages],
    turnCount: 0,
    aborted: false,
  };
  let totalUsage: Usage = { input_tokens: 0, output_tokens: 0 };
  const maxTurns = params.maxTurns ?? DEFAULT_MAX_TOOL_TURNS;
  const stream = params.stream ?? streamMessage;
  const compactMessages = params.compactMessages ?? defaultCompactMessages;
  const cwd = params.cwd ?? process.cwd();
  const permissionSettings =
    params.permissionSettings ?? await loadPermissionSettings({ cwd });
  let stopHookFired = false;
  let outputTokensRecoveryCount = 0;
  let hasAttemptedReactiveCompact = false;

  while (state.turnCount < maxTurns) {
    if (params.signal?.aborted) {
      state = { ...state, aborted: true };
      return createResult(state, totalUsage, "aborted");
    }

    if (state.turnCount > 0) {
      const estimatedTokens = estimateMessagesTokens(state.messages);
      const warning = calculateTokenWarningState(estimatedTokens, params.model);

      if (warning.state !== "normal") {
        yield { type: "token_warning", warning };
      }

      if (warning.state === "blocking") {
        yield {
          type: "turn_complete",
          usage: totalUsage,
          turnCount: state.turnCount,
        };
        return createResult(state, totalUsage, "blocking_limit");
      }
    }

    state = { ...state, turnCount: state.turnCount + 1 };

    let result: StreamResult | null = null;
    let turnUsage: Usage = { input_tokens: 0, output_tokens: 0 };

    try {
      let system = params.system ?? await buildSystemPrompt({ cwd });
      let requestMessages = [...state.messages];
      let maxTokens = CAPPED_DEFAULT_MAX_TOKENS;
      let hasEscalatedMaxTokens = false;

      while (true) {
        const request: StreamRequestParams = {
          messages: requestMessages,
          model: params.model,
          system,
          tools: params.getTools?.() ??
            getToolsApiParams(params.getPermissionMode?.() ?? params.permissionMode),
          signal: params.signal,
          maxTokens,
          querySource: params.querySource ?? "foreground",
          ...(params.maxRetries !== undefined && { maxRetries: params.maxRetries }),
        };
        let collected: StreamResult | null = null;

        try {
          const generator = consumeStreamTurn({ stream, request });

          while (true) {
            const { value, done } = await generator.next();
            if (done) {
              collected = value ?? null;
              break;
            }

            yield value;
          }
        } catch (error) {
          if (!isPromptTooLongError(error) || hasAttemptedReactiveCompact) {
            throw error;
          }

          hasAttemptedReactiveCompact = true;
          const compacted = await compactMessages(state.messages, {
            force: true,
            trigger: "auto",
            model: params.model,
            signal: params.signal,
          });
          state = { ...state, messages: compacted.messages };
          requestMessages = [...state.messages];
          system = params.system ?? await buildSystemPrompt({ cwd });
          yield {
            type: "stream_restart",
            reason: "reactive_compact",
            message: "Context compacted after prompt-too-long error; retrying.",
          };
          continue;
        }

        if (!collected) {
          result = null;
          break;
        }

        turnUsage = addUsage(turnUsage, collected.usage);

        if (collected.stopReason === "max_tokens") {
          if (!hasEscalatedMaxTokens) {
            hasEscalatedMaxTokens = true;
            maxTokens = ESCALATED_MAX_TOKENS;
            yield {
              type: "stream_restart",
              reason: "max_tokens_escalation",
              message: "Output hit the default token limit; retrying with a larger output budget.",
            };
            continue;
          }

          const truncatedMessage = collected.assistantMessage;
          state = {
            ...state,
            messages: [
              ...state.messages,
              truncatedMessage,
            ],
          };

          if (outputTokensRecoveryCount >= MAX_OUTPUT_TOKENS_RECOVERY_LIMIT) {
            totalUsage = addUsage(totalUsage, turnUsage);
            return createResult(
              state,
              totalUsage,
              "max_output_tokens_recovery_limit",
            );
          }

          outputTokensRecoveryCount++;
          state = {
            ...state,
            messages: [
              ...state.messages,
              { role: "user", content: OUTPUT_TOKENS_RECOVERY_PROMPT },
            ],
          };
          requestMessages = [...state.messages];
          maxTokens = ESCALATED_MAX_TOKENS;
          yield {
            type: "stream_restart",
            reason: "max_tokens_continue",
            message: "Output is still too long; asking the model to continue from the cutoff.",
          };
          continue;
        }

        result = collected;
        break;
      }
    } catch (error) {
      if (isPromptTooLongError(error) && hasAttemptedReactiveCompact) {
        totalUsage = addUsage(totalUsage, turnUsage);
        return createResult(
          state,
          totalUsage,
          "prompt_too_long_after_compact",
          new Error(getUserFacingErrorMessage(error, params.model)),
        );
      }

      const normalized = error instanceof Error ? error : new Error(String(error));
      return createResult(state, totalUsage, "model_error", normalized);
    }

    if (params.signal?.aborted) {
      state = { ...state, aborted: true };
      return createResult(state, totalUsage, "aborted");
    }

    if (!result) {
      return createResult(
        state,
        totalUsage,
        "model_error",
        new Error("Model stream ended without a result."),
      );
    }

    totalUsage = addUsage(totalUsage, turnUsage);

    const assistantMessage: AssistantMessage = result.assistantMessage;
    state = {
      ...state,
      messages: [...state.messages, assistantMessage],
    };
    yield { type: "assistant_message", message: assistantMessage };

    if (
      result.stopReason === "tool_use" &&
      Array.isArray(assistantMessage.content)
    ) {
      const toolResultMessage = await runTools(assistantMessage.content, {
        cwd,
        homeDir: params.homeDir,
        abortSignal: params.signal,
        permissions: {
          mode: params.getPermissionMode?.() ?? params.permissionMode,
          settings: permissionSettings,
          sessionAllowRules: params.sessionAllowRules,
          planFilePath: params.planFilePath,
          requestPermission: params.requestPermission,
        },
        allowedRoots: params.allowedRoots,
        planFilePath: params.planFilePath,
        planHomeDir: params.planHomeDir,
        planSessionId: params.planSessionId,
        sessionId: params.sessionId,
        currentMessageId: params.currentMessageId,
        fileHistory: params.fileHistory,
        defaultModel: params.model,
        availableTools: params.allowedTools,
        getPermissionMode: params.getPermissionMode,
        setPermissionMode: params.setPermissionMode,
        addSessionAllowRules: params.addSessionAllowRules,
        teammateIdentity: params.teammateIdentity,
      });
      state = {
        ...state,
        messages: [...state.messages, toolResultMessage],
      };
      yield { type: "tool_result_message", message: toolResultMessage };

      if (Array.isArray(toolResultMessage.content)) {
        const toolUseBlocks = getToolUseBlocks(assistantMessage.content);

        for (const toolResult of toolResultMessage.content) {
          if (toolResult.type !== "tool_result") {
            continue;
          }

          const toolUse = toolUseBlocks.find(
            (block) => block.id === toolResult.tool_use_id,
          );

          yield {
            type: "tool_use_done",
            id: toolUse?.id,
            name: toolUse?.name ?? "unknown",
            resultLength: String(toolResult.content).length,
            ...(toolResult.is_error && { isError: true }),
          };
        }
      }

      yield {
        type: "turn_complete",
        usage: totalUsage,
        turnCount: state.turnCount,
      };
      continue;
    }

    yield {
      type: "turn_complete",
      usage: totalUsage,
      turnCount: state.turnCount,
    };

    if (!stopHookFired) {
      const stopOutcome = await runStopHooks({
        lastAssistantMessage: getAssistantText(assistantMessage),
        cwd,
        homeDir: params.homeDir,
        sessionId: params.sessionId,
        signal: params.signal,
      });
      const stopContext = stopOutcome.blockingError ??
        stopOutcome.additionalContext ??
        stopOutcome.systemMessage;

      if (stopContext) {
        stopHookFired = true;
        state = {
          ...state,
          messages: [
            ...state.messages,
            {
              role: "user",
              content: formatHookContextMessage("Stop", stopContext),
            },
          ],
        };
        continue;
      }
    }

    return createResult(state, totalUsage, "completed");
  }

  return createResult(state, totalUsage, "max_turns");
}
