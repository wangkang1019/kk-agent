import type { ToolResult } from "../tools/Tool.js";

export const HOOK_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "SessionStart",
  "Stop",
  "SubagentStop",
] as const;

export type HookEvent = typeof HOOK_EVENTS[number];

export type HookShell = "powershell" | "cmd" | "bash" | "sh";

export interface HookCommand {
  type: "command";
  command: string;
  timeout: number;
  shell?: HookShell;
}

export interface HookMatcherGroup {
  matcher?: string;
  hooks: HookCommand[];
}

export type HooksSettings = Partial<Record<HookEvent, HookMatcherGroup[]>>;

export interface BaseHookInput {
  hook_event_name: HookEvent;
  session_id: string;
  cwd: string;
}

export interface PreToolUseHookInput extends BaseHookInput {
  hook_event_name: "PreToolUse";
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_use_id?: string;
}

export interface PostToolUseHookInput extends BaseHookInput {
  hook_event_name: "PostToolUse";
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response: ToolResult;
  tool_use_id?: string;
}

export interface UserPromptSubmitHookInput extends BaseHookInput {
  hook_event_name: "UserPromptSubmit";
  prompt: string;
}

export interface SessionStartHookInput extends BaseHookInput {
  hook_event_name: "SessionStart";
  source: string;
}

export interface StopHookInput extends BaseHookInput {
  hook_event_name: "Stop";
  last_assistant_message: string;
}

export interface SubagentStopHookInput extends BaseHookInput {
  hook_event_name: "SubagentStop";
  agent_id?: string;
  agent_type: string;
  last_assistant_message: string;
}

export type HookInput =
  | PreToolUseHookInput
  | PostToolUseHookInput
  | UserPromptSubmitHookInput
  | SessionStartHookInput
  | StopHookInput
  | SubagentStopHookInput;

export type HookOutcome = "success" | "blocking" | "non_blocking_error" | "cancelled";
export type HookPermissionBehavior = "allow" | "ask" | "deny";

export interface HookResult {
  hookName: string;
  command: string;
  outcome: HookOutcome;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  timedOut?: boolean;
  aborted?: boolean;
  permissionBehavior?: HookPermissionBehavior;
  permissionDecisionReason?: string;
  additionalContext?: string;
  blockingError?: string;
  systemMessage?: string;
  preventContinuation?: boolean;
  stopReason?: string;
}

export interface AggregatedHookOutcome {
  results: HookResult[];
  permissionBehavior?: HookPermissionBehavior;
  permissionDecisionReason?: string;
  additionalContext?: string;
  blockingError?: string;
  systemMessage?: string;
  preventContinuation?: boolean;
  stopReason?: string;
}
