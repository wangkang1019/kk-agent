import type { PermissionMode } from "../permissions/permissions.js";
import type { Message, Usage } from "../types/message.js";

export type AgentSource = "built-in" | "user" | "project";

export interface AgentDefinition {
  agentType: string;
  whenToUse: string;
  tools?: string[];
  disallowedTools?: string[];
  model?: string;
  maxTurns?: number;
  permissionMode?: PermissionMode;
  isolation?: "none" | "worktree";
  source: AgentSource;
  filePath?: string;
  getSystemPrompt(): string;
}

export interface AgentRunResult {
  agentType: string;
  finalText: string;
  messages: Message[];
  totalToolUseCount: number;
  totalDurationMs: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  turnCount: number;
  reason: string;
  warnings?: string[];
}

export interface AgentProgressEvent {
  type: "text" | "tool_use_start" | "tool_use_done" | "turn_usage";
  text?: string;
  toolName?: string;
  isError?: boolean;
  cumulativeUsage?: Usage;
}
