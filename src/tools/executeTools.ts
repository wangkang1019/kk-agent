import type { ContentBlock, UserMessage } from "../types/message.js";
import { truncateToolResult } from "../context/compaction.js";
import {
  activateConditionalSkillsForPaths,
  extractToolFilePaths,
} from "../services/skills/registry.js";
import {
  checkPermission,
  type PermissionResponse,
} from "../permissions/permissions.js";
import {
  runPostToolUseHooks,
  runPreToolUseHooks,
} from "../hooks/index.js";
import { findToolByName } from "./registry.js";
import type { Tool, ToolContext, ToolResult } from "./Tool.js";

function getToolUseBlocks(
  contentBlocks: ContentBlock[],
): Extract<ContentBlock, { type: "tool_use" }>[] {
  return contentBlocks.filter(
    (block): block is Extract<ContentBlock, { type: "tool_use" }> =>
      block.type === "tool_use",
  );
}

export async function executeTools(
  contentBlocks: ContentBlock[],
  context: ToolContext,
): Promise<UserMessage> {
  const toolUseBlocks = getToolUseBlocks(contentBlocks);
  const batches = partitionToolCalls(toolUseBlocks, context);
  const toolResults: Array<Extract<ContentBlock, { type: "tool_result" }>> = [];

  for (const batch of batches) {
    const results = batch.isConcurrencySafe
      ? await Promise.all(batch.blocks.map((block) => executeOneTool(block, context)))
      : [];

    if (batch.isConcurrencySafe) {
      toolResults.push(...results);
    } else {
      for (const block of batch.blocks) {
        toolResults.push(await executeOneTool(block, context));
      }
    }
  }

  return { role: "user", content: toolResults };
}

interface ToolBatch {
  isConcurrencySafe: boolean;
  blocks: Extract<ContentBlock, { type: "tool_use" }>[];
}

function findToolInContext(name: string, context: ToolContext): Tool | undefined {
  if (context.availableTools) {
    return context.availableTools.find((tool) => tool.name === name);
  }

  return findToolByName(name);
}

function partitionToolCalls(
  blocks: Extract<ContentBlock, { type: "tool_use" }>[],
  context: ToolContext,
): ToolBatch[] {
  const batches: ToolBatch[] = [];

  for (const block of blocks) {
    const tool = findToolInContext(block.name, context);
    const isConcurrencySafe = Boolean(tool?.isConcurrencySafe?.(block.input));
    const last = batches[batches.length - 1];

    if (isConcurrencySafe && last?.isConcurrencySafe) {
      last.blocks.push(block);
    } else {
      batches.push({ isConcurrencySafe, blocks: [block] });
    }
  }

  return batches;
}

function toolError(
  toolUseId: string,
  content: string,
): Extract<ContentBlock, { type: "tool_result" }> {
  return {
    type: "tool_result",
    tool_use_id: toolUseId,
    content,
    is_error: true,
  };
}

function shouldTrackFileEdit(toolName: string, input: Record<string, unknown>): string | null {
  if (toolName !== "Write" && toolName !== "Edit") {
    return null;
  }

  return typeof input.file_path === "string" && input.file_path.trim()
    ? input.file_path
    : null;
}

async function executeOneTool(
  block: Extract<ContentBlock, { type: "tool_use" }>,
  context: ToolContext,
): Promise<Extract<ContentBlock, { type: "tool_result" }>> {
  const tool = findToolInContext(block.name, context);

  if (!tool) {
    return toolError(block.id, `Error: Unknown tool "${block.name}"`);
  }

  const preOutcome = await runPreToolUseHooks({
    toolName: block.name,
    toolInput: block.input,
    cwd: context.cwd,
    homeDir: context.homeDir,
    sessionId: context.sessionId,
    toolUseId: block.id,
    signal: context.abortSignal,
  });

  if (preOutcome.blockingError || preOutcome.permissionBehavior === "deny") {
    return toolError(
      block.id,
      `Hook blocked ${block.name}: ${preOutcome.blockingError ?? preOutcome.permissionDecisionReason ?? "permission denied"}`,
    );
  }

  const checkedDecision = await checkPermission({
    tool,
    input: block.input,
    mode: context.permissions?.mode,
    settings: context.permissions?.settings,
    sessionAllowRules: context.permissions?.sessionAllowRules,
    planFilePath: context.permissions?.planFilePath ?? context.planFilePath,
  });
  const decision = preOutcome.permissionBehavior === "allow"
    ? { ...checkedDecision, behavior: "allow" as const, reason: "allowed by PreToolUse hook" }
    : preOutcome.permissionBehavior === "ask"
      ? { ...checkedDecision, behavior: "ask" as const, reason: "confirmation requested by PreToolUse hook" }
      : checkedDecision;

  if (decision.behavior === "deny") {
    return toolError(block.id, `Permission denied: ${decision.reason}`);
  }

  let permissionResponse: PermissionResponse | undefined;

  if (decision.behavior === "ask") {
    permissionResponse = context.permissions?.requestPermission
      ? await context.permissions.requestPermission(decision)
      : "deny";

    if (permissionResponse === "deny") {
      return toolError(block.id, `Permission denied: ${decision.reason}`);
    }

    if (
      permissionResponse === "always_allow" &&
      context.permissions?.sessionAllowRules &&
      !context.permissions.sessionAllowRules.includes(
        decision.request.suggestedAllowRule,
      )
    ) {
      context.permissions.sessionAllowRules.push(
        decision.request.suggestedAllowRule,
      );
    }
  }

  const filePathToTrack = shouldTrackFileEdit(block.name, block.input);

  if (
    filePathToTrack &&
    context.currentMessageId &&
    context.fileHistory
  ) {
    await context.fileHistory.trackEdit(filePathToTrack, context.currentMessageId);
  }

  const result: ToolResult = await tool.call(block.input, {
    ...context,
    toolUseId: block.id,
    permissionResponse,
  });
  const postOutcome = await runPostToolUseHooks({
    toolName: block.name,
    toolInput: block.input,
    toolResponse: result,
    cwd: context.cwd,
    homeDir: context.homeDir,
    sessionId: context.sessionId,
    toolUseId: block.id,
    signal: context.abortSignal,
  });
  const filePaths = extractToolFilePaths(block.name, block.input);

  if (!result.isError && filePaths.length > 0) {
    activateConditionalSkillsForPaths(filePaths, context.cwd);
  }

  const hookContext = [
    preOutcome.additionalContext
      ? `[Hook:PreToolUse]\n${preOutcome.additionalContext}`
      : "",
    postOutcome.additionalContext
      ? `[Hook:PostToolUse]\n${postOutcome.additionalContext}`
      : "",
  ].filter(Boolean).join("\n\n");
  const finalContent = hookContext
    ? `${result.content}\n\n${hookContext}`
    : result.content;

  return {
    type: "tool_result",
    tool_use_id: block.id,
    content: truncateToolResult(finalContent, tool.maxResultSizeChars),
    ...(result.isError && { is_error: true }),
  };
}
