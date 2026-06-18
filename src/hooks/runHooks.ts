import type {
  AggregatedHookOutcome,
  HookEvent,
  HookInput,
  HookResult,
} from "./types.js";
import type { ToolResult } from "../tools/Tool.js";
import { executeHookCommand } from "./executor.js";
import {
  findMatchingHooks,
  loadHooksSettings,
} from "./settings.js";

function aggregateResults(results: HookResult[]): AggregatedHookOutcome {
  const priority = { allow: 1, ask: 2, deny: 3 };
  const contexts: string[] = [];
  const messages: string[] = [];
  const out: AggregatedHookOutcome = { results };

  for (const result of results) {
    if (
      result.permissionBehavior &&
      priority[result.permissionBehavior] > (out.permissionBehavior ? priority[out.permissionBehavior] : 0)
    ) {
      out.permissionBehavior = result.permissionBehavior;
      out.permissionDecisionReason = result.permissionDecisionReason;
    }

    if (result.blockingError && !out.blockingError) {
      out.blockingError = result.blockingError;
    }

    if (result.preventContinuation) {
      out.preventContinuation = true;
      out.stopReason ||= result.stopReason;
    }

    if (result.additionalContext) {
      contexts.push(result.additionalContext);
    }

    if (result.systemMessage) {
      messages.push(result.systemMessage);
    }
  }

  if (contexts.length > 0) {
    out.additionalContext = contexts.join("\n\n");
  }

  if (messages.length > 0) {
    out.systemMessage = messages.join("\n\n");
  }

  return out;
}

async function runHooksForEvent(params: {
  event: HookEvent;
  matchField?: string;
  hookInput: HookInput;
  cwd: string;
  homeDir?: string;
  signal?: AbortSignal;
}): Promise<AggregatedHookOutcome> {
  const settings = await loadHooksSettings({
    cwd: params.cwd,
    homeDir: params.homeDir,
  });
  const hooks = findMatchingHooks(settings, params.event, params.matchField);

  if (hooks.length === 0) {
    return { results: [] };
  }

  const results = await Promise.all(
    hooks.map((hook) =>
      executeHookCommand({
        hook,
        hookEvent: params.event,
        hookName: params.matchField
          ? `${params.event}:${params.matchField}`
          : params.event,
        hookInput: params.hookInput,
        cwd: params.cwd,
        signal: params.signal,
      })
    ),
  );

  return aggregateResults(results);
}

export function formatHookContextMessage(
  event: HookEvent,
  content: string,
): string {
  return `<hook-context event="${event}">\n${content}\n</hook-context>`;
}

export function isInternalHookMessage(message: {
  role: string;
  content: unknown;
}): boolean {
  return message.role === "user" &&
    typeof message.content === "string" &&
    message.content.startsWith("<hook-context ");
}

export function runPreToolUseHooks(params: {
  toolName: string;
  toolInput: Record<string, unknown>;
  cwd: string;
  sessionId?: string;
  homeDir?: string;
  toolUseId?: string;
  signal?: AbortSignal;
}): Promise<AggregatedHookOutcome> {
  return runHooksForEvent({
    event: "PreToolUse",
    matchField: params.toolName,
    cwd: params.cwd,
    homeDir: params.homeDir,
    signal: params.signal,
    hookInput: {
      hook_event_name: "PreToolUse",
      session_id: params.sessionId ?? "",
      cwd: params.cwd,
      tool_name: params.toolName,
      tool_input: params.toolInput,
      ...(params.toolUseId && { tool_use_id: params.toolUseId }),
    },
  });
}

export function runPostToolUseHooks(params: {
  toolName: string;
  toolInput: Record<string, unknown>;
  toolResponse: ToolResult;
  cwd: string;
  sessionId?: string;
  homeDir?: string;
  toolUseId?: string;
  signal?: AbortSignal;
}): Promise<AggregatedHookOutcome> {
  return runHooksForEvent({
    event: "PostToolUse",
    matchField: params.toolName,
    cwd: params.cwd,
    homeDir: params.homeDir,
    signal: params.signal,
    hookInput: {
      hook_event_name: "PostToolUse",
      session_id: params.sessionId ?? "",
      cwd: params.cwd,
      tool_name: params.toolName,
      tool_input: params.toolInput,
      tool_response: params.toolResponse,
      ...(params.toolUseId && { tool_use_id: params.toolUseId }),
    },
  });
}

export function runUserPromptSubmitHooks(params: {
  prompt: string;
  cwd: string;
  sessionId?: string;
  homeDir?: string;
  signal?: AbortSignal;
}): Promise<AggregatedHookOutcome> {
  return runHooksForEvent({
    event: "UserPromptSubmit",
    cwd: params.cwd,
    homeDir: params.homeDir,
    signal: params.signal,
    hookInput: {
      hook_event_name: "UserPromptSubmit",
      session_id: params.sessionId ?? "",
      cwd: params.cwd,
      prompt: params.prompt,
    },
  });
}

export function runSessionStartHooks(params: {
  source: string;
  cwd: string;
  sessionId?: string;
  homeDir?: string;
  signal?: AbortSignal;
}): Promise<AggregatedHookOutcome> {
  return runHooksForEvent({
    event: "SessionStart",
    matchField: params.source,
    cwd: params.cwd,
    homeDir: params.homeDir,
    signal: params.signal,
    hookInput: {
      hook_event_name: "SessionStart",
      session_id: params.sessionId ?? "",
      cwd: params.cwd,
      source: params.source,
    },
  });
}

export function runStopHooks(params: {
  lastAssistantMessage: string;
  cwd: string;
  sessionId?: string;
  homeDir?: string;
  signal?: AbortSignal;
}): Promise<AggregatedHookOutcome> {
  return runHooksForEvent({
    event: "Stop",
    cwd: params.cwd,
    homeDir: params.homeDir,
    signal: params.signal,
    hookInput: {
      hook_event_name: "Stop",
      session_id: params.sessionId ?? "",
      cwd: params.cwd,
      last_assistant_message: params.lastAssistantMessage,
    },
  });
}

export function runSubagentStopHooks(params: {
  agentId?: string;
  agentType: string;
  lastAssistantMessage: string;
  cwd: string;
  sessionId?: string;
  homeDir?: string;
  signal?: AbortSignal;
}): Promise<AggregatedHookOutcome> {
  return runHooksForEvent({
    event: "SubagentStop",
    matchField: params.agentType,
    cwd: params.cwd,
    homeDir: params.homeDir,
    signal: params.signal,
    hookInput: {
      hook_event_name: "SubagentStop",
      session_id: params.sessionId ?? "",
      cwd: params.cwd,
      agent_type: params.agentType,
      last_assistant_message: params.lastAssistantMessage,
      ...(params.agentId && { agent_id: params.agentId }),
    },
  });
}
