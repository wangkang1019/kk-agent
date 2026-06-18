import { Box, Static, Text } from "ink";
import type { ReactNode } from "react";

import { isCompactMessage } from "../../context/compaction.js";
import { isInternalPlanMessage } from "../../context/planMode.js";
import { isInternalHookMessage } from "../../hooks/index.js";
import type { ContentBlock, Message } from "../../types/message.js";
import { markdownToAnsiLines } from "../markdown/index.js";
import {
  isTaskNotificationText,
  parseTaskNotification,
  type ParsedTaskNotification,
} from "../taskNotification.js";
import { TaskNotificationCard } from "./TaskNotificationCard.js";
import {
  formatGroupedToolSummary,
  formatToolVerboseLines,
  isGroupableTool,
  ToolCard,
  type ToolCardDisplay,
  type ToolDisplay,
  type ToolGroupDisplay,
} from "./ToolCard.js";
import { AppHeaderBlock, buildHeaderLines, type HeaderInfo } from "./AppHeader.js";

export type ConversationItem =
  | {
      kind: "header";
      key: string;
      info: HeaderInfo;
    }
  | {
      kind: "user";
      key: string;
      text: string;
    }
  | {
      kind: "assistant";
      key: string;
      text: string;
    }
  | {
      kind: "notification";
      key: string;
      raw: string;
      notification: ParsedTaskNotification;
    }
  | ({
      key: string;
    } & ToolCardDisplay);

export function isInternalSkillInvocationMessage(message: Message): boolean {
  return message.role === "user" &&
    typeof message.content === "string" &&
    (message.content.startsWith("[skill_invocation:") ||
      message.content.startsWith("[user_command:"));
}

export function parseCommandMarker(message: Message): string | null {
  if (message.role !== "user" || typeof message.content !== "string") {
    return null;
  }

  const name = /<command-name>([\s\S]*?)<\/command-name>/.exec(message.content)
    ?.[1]?.trim();
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(message.content)
    ?.[1]?.trim();

  if (!name) {
    return null;
  }

  return args ? `${name} ${args}` : name;
}

export function shouldHideMessage(message: Message): boolean {
  return isCompactMessage(message) ||
    isInternalPlanMessage(message) ||
    isInternalSkillInvocationMessage(message) ||
    isInternalHookMessage(message);
}

export function extractAssistantText(message: Message): string {
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

function buildToolResultMap(
  messages: Message[],
): Map<string, Extract<ContentBlock, { type: "tool_result" }>> {
  const results = new Map<string, Extract<ContentBlock, { type: "tool_result" }>>();

  for (const message of messages) {
    if (!Array.isArray(message.content)) {
      continue;
    }

    for (const block of message.content) {
      if (block.type === "tool_result") {
        results.set(block.tool_use_id, block);
      }
    }
  }

  return results;
}

function assistantToolUses(message: Message): ToolDisplay[] {
  if (!Array.isArray(message.content)) {
    return [];
  }

  return message.content
    .filter((block): block is Extract<ContentBlock, { type: "tool_use" }> =>
      block.type === "tool_use"
    )
    .map((block) => ({
      id: block.id,
      name: block.name,
      input: block.input,
    }));
}

function pushToolDisplays(
  items: ConversationItem[],
  tools: ToolDisplay[],
): void {
  let index = 0;

  while (index < tools.length) {
    const tool = tools[index]!;

    if (isGroupableTool(tool.name) && !tool.result?.is_error) {
      const groupTools: ToolDisplay[] = [tool];
      let nextIndex = index + 1;

      while (
        nextIndex < tools.length &&
        isGroupableTool(tools[nextIndex]!.name) &&
        !tools[nextIndex]!.result?.is_error
      ) {
        groupTools.push(tools[nextIndex]!);
        nextIndex += 1;
      }

      if (groupTools.length > 1) {
        const group: ToolGroupDisplay = {
          kind: "tool_group",
          id: `group-${tool.id}`,
          tools: groupTools,
        };
        items.push({ ...group, key: group.id });
        index = nextIndex;
        continue;
      }
    }

    items.push({
      kind: "tool",
      key: `tool-${tool.id}`,
      tool,
    });
    index += 1;
  }
}

export function flattenConversation(messages: Message[]): ConversationItem[] {
  const items: ConversationItem[] = [];
  const toolResults = buildToolResultMap(messages);

  messages.forEach((message, messageIndex) => {
    if (shouldHideMessage(message)) {
      return;
    }

    if (message.role === "user") {
      if (typeof message.content !== "string") {
        return;
      }

      const notification = parseTaskNotification(message.content);
      if (notification && isTaskNotificationText(message.content)) {
        items.push({
          kind: "notification",
          key: `n-${messageIndex}`,
          raw: message.content,
          notification,
        });
        return;
      }

      const text = parseCommandMarker(message) ?? message.content;
      items.push({ kind: "user", key: `u-${messageIndex}`, text });
      return;
    }

    const text = extractAssistantText(message);

    if (text) {
      items.push({ kind: "assistant", key: `a-${messageIndex}`, text });
    }

    const tools = assistantToolUses(message)
      .map((tool) => ({ ...tool, result: toolResults.get(tool.id) }))
      .filter((tool) => tool.result);

    pushToolDisplays(items, tools);
  });

  return items;
}

export function shouldResetStaticHistory(
  previous: ConversationItem[],
  next: ConversationItem[],
): boolean {
  if (next.length < previous.length) {
    return true;
  }

  return previous.some((item, index) => next[index]?.key !== item.key);
}

export function conversationItemToLines(
  item: ConversationItem,
  verbose = false,
): string[] {
  if (item.kind === "header") {
    const lines = buildHeaderLines(item.info);
    return [
      lines.titleLine,
      lines.modelLine,
      lines.cwdLine,
      lines.helpLine,
    ];
  }

  if (item.kind === "user") {
    return [`› ${item.text}`];
  }

  if (item.kind === "assistant") {
    return markdownToAnsiLines(item.text).map((line, index) =>
      index === 0 ? `| ${line}` : `  ${line}`
    );
  }

  if (item.kind === "notification") {
    return item.raw.split(/\r?\n/);
  }

  if (item.kind === "tool_group") {
    if (!verbose) {
      return formatGroupedToolSummary(item).split(/\r?\n/);
    }

    return item.tools.flatMap((tool) => formatToolVerboseLines(tool));
  }

  return verbose
    ? formatToolVerboseLines(item.tool)
    : [`  ${item.tool.result?.is_error ? "error" : "ok"} ${item.tool.name}`];
}

export function ConversationItemView({
  item,
}: {
  item: ConversationItem;
}): ReactNode {
  if (item.kind === "header") {
    return <AppHeaderBlock info={item.info} />;
  }

  if (item.kind === "user") {
    return (
      <Box marginTop={1}>
        <Text color="cyan" bold>{"› "}</Text>
        <Text>{item.text}</Text>
      </Box>
    );
  }

  if (item.kind === "assistant") {
    return (
      <Box>
        <Text color="magenta">{"| "}</Text>
        <Text>{markdownToAnsiLines(item.text).join("\n")}</Text>
      </Box>
    );
  }

  if (item.kind === "notification") {
    return <TaskNotificationCard notification={item.notification} />;
  }

  return <ToolCard display={item} />;
}

export function ConversationView({
  items,
  epoch,
}: {
  items: ConversationItem[];
  epoch: number;
}): ReactNode {
  return (
    <Static key={`history-${epoch}`} items={items}>
      {(item) => <ConversationItemView key={item.key} item={item} />}
    </Static>
  );
}
