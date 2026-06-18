import type {
  ContentBlock,
  Message,
  StreamRequestParams,
  StreamResult,
  Usage,
} from "../types/message.js";
import { streamMessage } from "../services/api/stream.js";
import { COMPACT_MAX_OUTPUT_TOKENS } from "../services/api/anthropic.js";

export const TEXT_CHARS_PER_TOKEN = 4;
export const JSON_CHARS_PER_TOKEN = 2;
export const MESSAGE_OVERHEAD_TOKENS = 12;
export const TOOL_BLOCK_OVERHEAD_TOKENS = 24;
export const FIXED_BINARY_BLOCK_TOKENS = 2_000;

export const MODEL_CONTEXT_WINDOW = 200_000;
export const MODEL_CONTEXT_WINDOW_DEFAULT = 200_000;
export const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000;
export const AUTOCOMPACT_BUFFER_TOKENS = 13_000;
export const WARNING_THRESHOLD_BUFFER_TOKENS = 20_000;
export const MANUAL_COMPACT_BUFFER_TOKENS = 3_000;
export const REFERENCE_EFFECTIVE_CONTEXT_WINDOW = 180_000;
export const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3;
export const DEFAULT_MAX_RESULT_SIZE_CHARS = 100_000;

export const MICROCOMPACT_MIN_MESSAGES = 10;
export const MICROCOMPACT_KEEP_RECENT_MESSAGES = 8;
export const CLEARED_TOOL_RESULT_PLACEHOLDER =
  "[Old tool result content cleared]";

export const COMPACT_SYSTEM_PROMPT = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.

Your task is to create a detailed summary of the conversation so far,
paying close attention to the user's explicit requests and your previous actions.

This summary should be thorough in capturing technical details, code patterns,
architectural decisions, file names, errors encountered, pending tasks, and what
was being worked on most recently.`;

const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "claude-opus-4-20250514": 200_000,
  "claude-sonnet-4-20250514": 200_000,
  "claude-3-5-sonnet-20241022": 200_000,
};

const COMPACTABLE_TOOLS = new Set(["Read", "Bash", "Grep", "Glob", "Edit", "Write"]);
let consecutiveAutoCompactFailures = 0;

export type TokenWarningLevel = "normal" | "warning" | "error" | "blocking";

export interface TokenBudgetSnapshot {
  estimatedConversationTokens: number;
  contextWindow: number;
  effectiveContextWindow: number;
  warningThreshold: number;
  autoCompactThreshold: number;
  manualCompactThreshold: number;
  percentUsed: number;
}

export interface TokenWarningState extends TokenBudgetSnapshot {
  state: TokenWarningLevel;
}

export interface CompactMessagesParams {
  usage?: Usage;
  usageAnchorIndex?: number;
  contextWindow?: number;
  force?: boolean;
  trigger?: "manual" | "auto";
  focus?: string;
  model?: string;
  signal?: AbortSignal;
  summarize?: (params: {
    system: string;
    messages: Message[];
    model?: string;
    signal?: AbortSignal;
  }) => Promise<string>;
  querySource?: "compact" | "session_memory" | "user";
}

export interface CompactMessagesResult {
  messages: Message[];
  summary?: string;
  didMicroCompact: boolean;
  didFullCompact: boolean;
  beforeMessageCount: number;
  afterMessageCount: number;
  beforeTokens: number;
  afterTokens: number;
  compactedToolUseIds: string[];
}

function roughTokenCount(
  content: string,
  charsPerToken = TEXT_CHARS_PER_TOKEN,
): number {
  return Math.max(1, Math.round(content.length / charsPerToken));
}

export function getContextWindowForModel(model?: string): number {
  const envOverride = process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS;

  if (envOverride) {
    const parsed = Number.parseInt(envOverride, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  if (model && MODEL_CONTEXT_WINDOWS[model]) {
    return MODEL_CONTEXT_WINDOWS[model];
  }

  return MODEL_CONTEXT_WINDOW_DEFAULT;
}

export function getEffectiveContextWindowSize(model?: string): number {
  const contextWindow = getContextWindowForModel(model);
  const reserved = Math.min(
    MAX_OUTPUT_TOKENS_FOR_SUMMARY,
    Math.floor(contextWindow * 0.2),
  );
  return Math.max(1, contextWindow - reserved);
}

function scaleBuffer(buffer: number, effectiveWindow: number): number {
  if (effectiveWindow >= REFERENCE_EFFECTIVE_CONTEXT_WINDOW) {
    return buffer;
  }

  return Math.round(buffer * (effectiveWindow / REFERENCE_EFFECTIVE_CONTEXT_WINDOW));
}

function stringifyContent(content: string | ContentBlock[]): string {
  return typeof content === "string" ? content : JSON.stringify(content);
}

function estimateContentBlockTokens(content: Message["content"]): number {
  if (typeof content === "string") {
    return roughTokenCount(content);
  }

  return content.reduce((total, block) => {
    switch (block.type) {
      case "text":
        return total + roughTokenCount(block.text);
      case "tool_use":
        return (
          total +
          TOOL_BLOCK_OVERHEAD_TOKENS +
          roughTokenCount(block.name) +
          roughTokenCount(JSON.stringify(block.input ?? {}), JSON_CHARS_PER_TOKEN)
        );
      case "tool_result":
        return (
          total +
          TOOL_BLOCK_OVERHEAD_TOKENS +
          roughTokenCount(
            stringifyContent(block.content),
            JSON_CHARS_PER_TOKEN,
          )
        );
      default:
        return (
          total +
          FIXED_BINARY_BLOCK_TOKENS +
          roughTokenCount(JSON.stringify(block), JSON_CHARS_PER_TOKEN)
        );
    }
  }, 0);
}

export function estimateMessageTokens(message: Message): number {
  return MESSAGE_OVERHEAD_TOKENS + estimateContentBlockTokens(message.content);
}

export function estimateMessagesTokens(messages: readonly Message[]): number {
  const rawEstimate = messages.reduce(
    (sum, message) => sum + estimateMessageTokens(message),
    0,
  );
  return Math.ceil((rawEstimate * 4) / 3);
}

export function getTokenCountFromUsage(usage: Usage): number {
  return (
    usage.input_tokens +
    usage.output_tokens +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0)
  );
}

export function tokenCountWithEstimation(
  messages: readonly Message[],
  options?: { usage?: Usage; usageAnchorIndex?: number },
): number {
  if (
    options?.usage &&
    options.usageAnchorIndex !== undefined &&
    options.usageAnchorIndex >= 0
  ) {
    const suffix = messages.slice(options.usageAnchorIndex + 1);
    return getTokenCountFromUsage(options.usage) + estimateMessagesTokens(suffix);
  }

  return estimateMessagesTokens(messages);
}

export function buildTokenBudgetSnapshot(
  messages: readonly Message[],
  options?: {
    usage?: Usage;
    usageAnchorIndex?: number;
    contextWindow?: number;
    model?: string;
  },
): TokenBudgetSnapshot {
  const contextWindow = options?.contextWindow ?? getContextWindowForModel(options?.model);
  const estimatedConversationTokens = tokenCountWithEstimation(messages, options);
  const effectiveContextWindow =
    options?.contextWindow !== undefined
      ? Math.max(
          1,
          contextWindow -
            Math.min(MAX_OUTPUT_TOKENS_FOR_SUMMARY, Math.floor(contextWindow * 0.2)),
        )
      : getEffectiveContextWindowSize(options?.model);
  const warningThreshold =
    effectiveContextWindow -
    scaleBuffer(WARNING_THRESHOLD_BUFFER_TOKENS, effectiveContextWindow);
  const autoCompactThreshold =
    effectiveContextWindow -
    scaleBuffer(AUTOCOMPACT_BUFFER_TOKENS, effectiveContextWindow);
  const manualCompactThreshold =
    effectiveContextWindow -
    scaleBuffer(MANUAL_COMPACT_BUFFER_TOKENS, effectiveContextWindow);

  return {
    estimatedConversationTokens,
    contextWindow,
    effectiveContextWindow,
    warningThreshold,
    autoCompactThreshold,
    manualCompactThreshold,
    percentUsed: Math.min(
      100,
      Math.ceil((estimatedConversationTokens / effectiveContextWindow) * 100),
    ),
  };
}

export function calculateTokenWarningState(
  estimatedTokens: number,
  model?: string,
): TokenWarningState {
  const snapshot = buildTokenBudgetSnapshot([], { model });
  let state: TokenWarningLevel = "normal";

  if (estimatedTokens >= snapshot.manualCompactThreshold) {
    state = "blocking";
  } else if (estimatedTokens >= snapshot.autoCompactThreshold) {
    state = "error";
  } else if (estimatedTokens >= snapshot.warningThreshold) {
    state = "warning";
  }

  return {
    ...snapshot,
    estimatedConversationTokens: estimatedTokens,
    percentUsed: Math.min(
      100,
      Math.ceil((estimatedTokens / snapshot.effectiveContextWindow) * 100),
    ),
    state,
  };
}

export function resetAutoCompactFailures(): void {
  consecutiveAutoCompactFailures = 0;
}

export function recordAutoCompactFailure(): void {
  consecutiveAutoCompactFailures += 1;
}

export function recordAutoCompactSuccess(): void {
  consecutiveAutoCompactFailures = 0;
}

export function isAutoCompactCircuitOpen(): boolean {
  return consecutiveAutoCompactFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES;
}

export function shouldAutoCompact(
  estimatedTokens: number,
  model?: string,
  querySource?: "compact" | "session_memory" | "user",
): boolean {
  if (querySource === "compact" || querySource === "session_memory") {
    return false;
  }

  if (isAutoCompactCircuitOpen()) {
    return false;
  }

  return calculateTokenWarningState(estimatedTokens, model).state === "error" ||
    calculateTokenWarningState(estimatedTokens, model).state === "blocking";
}

export function truncateToolResult(
  content: string,
  maxChars = DEFAULT_MAX_RESULT_SIZE_CHARS,
): string {
  if (content.length <= maxChars) {
    return content;
  }

  return `${content.slice(0, maxChars)}\n\n[Output truncated: ${content.length} chars total, showing first ${maxChars}]`;
}

function getToolUseNames(messages: readonly Message[]): Map<string, string> {
  const toolUseNames = new Map<string, string>();

  for (const message of messages) {
    if (!Array.isArray(message.content)) {
      continue;
    }

    for (const block of message.content) {
      if (block.type === "tool_use") {
        toolUseNames.set(block.id, block.name);
      }
    }
  }

  return toolUseNames;
}

export function microCompactMessages(messages: readonly Message[]): {
  messages: Message[];
  didCompact: boolean;
  compactedToolUseIds: string[];
} {
  if (messages.length < MICROCOMPACT_MIN_MESSAGES) {
    return {
      messages: [...messages],
      didCompact: false,
      compactedToolUseIds: [],
    };
  }

  const toolUseNames = getToolUseNames(messages);
  const keepFrom = Math.max(
    0,
    messages.length - MICROCOMPACT_KEEP_RECENT_MESSAGES,
  );
  const compactedToolUseIds: string[] = [];

  const compactedMessages = messages.map((message, index) => {
    if (index >= keepFrom || !Array.isArray(message.content)) {
      return message;
    }

    let changed = false;
    const content = message.content.map((block) => {
      if (block.type !== "tool_result") {
        return block;
      }

      const toolName = toolUseNames.get(block.tool_use_id);
      if (!toolName || !COMPACTABLE_TOOLS.has(toolName)) {
        return block;
      }

      if (Array.isArray(block.content)) {
        const hasOnlyBinary = block.content.every((contentBlock) => {
          return contentBlock.type === "image" || contentBlock.type === "document";
        });

        if (hasOnlyBinary) {
          changed = true;
          compactedToolUseIds.push(block.tool_use_id);
          return {
            ...block,
            content: "[image]",
          };
        }

        return block;
      }

      if (typeof block.content !== "string") {
        return block;
      }

      if (block.content === CLEARED_TOOL_RESULT_PLACEHOLDER) {
        return block;
      }

      changed = true;
      compactedToolUseIds.push(block.tool_use_id);
      return {
        ...block,
        content: CLEARED_TOOL_RESULT_PLACEHOLDER,
      };
    });

    return changed ? { ...message, content } : message;
  });

  return {
    messages: compactedMessages,
    didCompact: compactedToolUseIds.length > 0,
    compactedToolUseIds,
  };
}

function collectToolUseIds(messages: readonly Message[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    if (!Array.isArray(message.content)) {
      continue;
    }
    for (const block of message.content) {
      if (block.type === "tool_use") {
        ids.add(block.id);
      }
    }
  }
  return ids;
}

function collectToolResultIds(messages: readonly Message[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    if (!Array.isArray(message.content)) {
      continue;
    }
    for (const block of message.content) {
      if (block.type === "tool_result") {
        ids.add(block.tool_use_id);
      }
    }
  }
  return ids;
}

export function findSafeTailStart(
  messages: readonly Message[],
  desiredCount: number,
): number {
  let start = Math.max(0, messages.length - desiredCount);

  while (start > 0) {
    const tail = messages.slice(start);
    const toolUses = collectToolUseIds(tail);
    const toolResults = collectToolResultIds(tail);
    const hasDanglingResult = [...toolResults].some((id) => !toolUses.has(id));

    if (!hasDanglingResult) {
      return start;
    }

    start -= 1;
  }

  return 0;
}

export function isCompactMessage(message: Message): boolean {
  const content = typeof message.content === "string" ? message.content : "";
  return (
    content.startsWith("[CompactBoundary]") ||
    content.startsWith(
      "This session is being continued from a previous conversation",
    )
  );
}

function createSummaryPrompt(messages: readonly Message[], focus?: string): string {
  return [
    "Conversation to summarize:",
    JSON.stringify(messages, null, 2),
    focus ? `\nFocus especially on: ${focus}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function getTextFromAssistant(message: Message): string {
  if (typeof message.content === "string") {
    return message.content;
  }

  return message.content
    .filter((block): block is Extract<ContentBlock, { type: "text" }> => {
      return block.type === "text";
    })
    .map((block) => block.text)
    .join("");
}

async function defaultSummarize(params: {
  system: string;
  messages: Message[];
  model?: string;
  signal?: AbortSignal;
}): Promise<string> {
  const generator = streamMessage({
    system: params.system,
    messages: params.messages,
    model: params.model,
    maxTokens: COMPACT_MAX_OUTPUT_TOKENS,
    signal: params.signal,
    querySource: "compact",
  } as StreamRequestParams);
  let result: StreamResult | null = null;

  while (true) {
    const { value, done } = await generator.next();

    if (done) {
      result = value;
      break;
    }

    if (value.type === "error") {
      throw value.error;
    }
  }

  if (!result) {
    throw new Error("Compaction summary stream ended without a result.");
  }

  return getTextFromAssistant(result.assistantMessage).trim();
}

export async function compactMessages(
  messages: readonly Message[],
  params: CompactMessagesParams = {},
): Promise<CompactMessagesResult> {
  const beforeMessageCount = messages.length;
  const beforeTokens = tokenCountWithEstimation(messages, params);
  const micro = microCompactMessages(messages);
  const budget = buildTokenBudgetSnapshot(micro.messages, params);

  if (
    !params.force &&
    budget.estimatedConversationTokens < budget.autoCompactThreshold
  ) {
    return {
      messages: micro.messages,
      didMicroCompact: micro.didCompact,
      didFullCompact: false,
      beforeMessageCount,
      afterMessageCount: micro.messages.length,
      beforeTokens,
      afterTokens: estimateMessagesTokens(micro.messages),
      compactedToolUseIds: micro.compactedToolUseIds,
    };
  }

  const summarize = params.summarize ?? defaultSummarize;
  const summary = await summarize({
    system: COMPACT_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: createSummaryPrompt(micro.messages, params.focus),
      },
    ],
    model: params.model,
    signal: params.signal,
  });
  const tailStart =
    micro.messages.length <= MICROCOMPACT_KEEP_RECENT_MESSAGES
      ? micro.messages.length
      : findSafeTailStart(micro.messages, MICROCOMPACT_KEEP_RECENT_MESSAGES);
  const tail = micro.messages.slice(tailStart);
  const trigger = params.trigger ?? (params.force ? "manual" : "auto");
  const compacted: Message[] = [
    {
      role: "user",
      content: [
        "This session is being continued from a previous conversation that ran out of context.",
        "The summary below covers the earlier portion of the conversation.",
        "",
        summary,
        tail.length > 0 ? "\nRecent messages are preserved verbatim." : "",
      ]
        .filter(Boolean)
        .join("\n"),
    },
    {
      role: "assistant",
      content: `[CompactBoundary] trigger=${trigger} messages=${micro.messages.length}`,
    },
    ...tail,
  ];

  return {
    messages: compacted,
    summary,
    didMicroCompact: micro.didCompact,
    didFullCompact: true,
    beforeMessageCount,
    afterMessageCount: compacted.length,
    beforeTokens,
    afterTokens: estimateMessagesTokens(compacted),
    compactedToolUseIds: micro.compactedToolUseIds,
  };
}
