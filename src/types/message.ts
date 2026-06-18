// 三种内容块
export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | ContentBlock[];
  is_error?: boolean;
}

export interface BinaryBlock {
  type: "image" | "document";
  [key: string]: unknown;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | BinaryBlock;

// 消息 = role + content blocks
export interface UserMessage {
  role: "user";
  content: string | ContentBlock[];
}

export interface AssistantMessage {
  role: "assistant";
  content: string | ContentBlock[];
}

export type Message = UserMessage | AssistantMessage;

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface StreamRequestParams {
  messages: Message[];
  system?: string;
  model?: string;
  maxTokens?: number;
  tools?: unknown[];
  signal?: AbortSignal;
  querySource?: "foreground" | "background" | "compact" | "session_memory";
  maxRetries?: number;
  onRetry?: (event: StreamApiRetryEvent) => void;
}

export interface StreamResult {
  assistantMessage: AssistantMessage;
  usage: Usage;
  stopReason: string;
}

export interface StreamTextEvent {
  type: "text";
  text: string;
}

export interface StreamToolUseStartEvent {
  type: "tool_use_start";
  id: string;
  name: string;
}

export interface StreamToolUseInputEvent {
  type: "tool_use_input";
  partialJson: string;
}

export interface StreamMessageStartEvent {
  type: "message_start";
  messageId: string;
}

export interface StreamMessageDoneEvent {
  type: "message_done";
  stopReason: string;
  usage: Usage;
}

export interface StreamErrorEvent {
  type: "error";
  error: Error;
}

export interface StreamApiRetryEvent {
  type: "api_retry";
  attempt: number;
  maxRetries: number;
  delayMs: number;
  category: string;
  message: string;
}

export interface StreamRestartEvent {
  type: "stream_restart";
  reason:
    | "max_tokens_escalation"
    | "max_tokens_continue"
    | "reactive_compact";
  message: string;
}

export type StreamEvent =
  | StreamTextEvent
  | StreamToolUseStartEvent
  | StreamToolUseInputEvent
  | StreamMessageStartEvent
  | StreamMessageDoneEvent
  | StreamErrorEvent
  | StreamApiRetryEvent
  | StreamRestartEvent;
