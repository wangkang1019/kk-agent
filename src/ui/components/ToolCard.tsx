import { Box, Text } from "ink";
import type { ReactNode } from "react";

import type { ContentBlock } from "../../types/message.js";

export interface ToolDisplay {
  id: string;
  name: string;
  input: Record<string, unknown>;
  result?: Extract<ContentBlock, { type: "tool_result" }>;
}

export interface ToolGroupDisplay {
  kind: "tool_group";
  id: string;
  tools: ToolDisplay[];
}

export type ToolCardDisplay =
  | {
      kind: "tool";
      tool: ToolDisplay;
    }
  | ToolGroupDisplay;

const GROUPABLE_TOOLS = new Set(["Read", "Grep", "Glob"]);

export function isGroupableTool(name: string): boolean {
  return GROUPABLE_TOOLS.has(name);
}

function stringifyInputValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return "";
}

export function getToolTarget(tool: ToolDisplay): string {
  const candidate =
    tool.input.file_path ??
    tool.input.path ??
    tool.input.pattern ??
    tool.input.command ??
    tool.input.skill ??
    tool.input.description;

  return stringifyInputValue(candidate) || "(no target)";
}

function getToolResultText(tool: ToolDisplay): string {
  const content = tool.result?.content;

  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content.map((block) => {
      if (block.type === "text") {
        return block.text;
      }

      return `[${block.type}]`;
    }).join("\n");
  }

  return "";
}

export function diffStatsFromText(text: string): { added: number; removed: number } {
  const plusMatch = /\+(\d+)/.exec(text);
  const minusMatch = /-(\d+)/.exec(text);

  if (plusMatch || minusMatch) {
    return {
      added: plusMatch ? Number(plusMatch[1]) : 0,
      removed: minusMatch ? Number(minusMatch[1]) : 0,
    };
  }

  return {
    added: text.split(/\r?\n/).filter((line) => line.startsWith("+")).length,
    removed: text.split(/\r?\n/).filter((line) => line.startsWith("-")).length,
  };
}

export function formatToolSummary(tool: ToolDisplay): string {
  const target = getToolTarget(tool);
  const text = getToolResultText(tool);

  if (tool.result?.is_error) {
    return `✗ ${tool.name} ${target}`;
  }

  if (tool.name === "Edit" || tool.name === "Write") {
    const stats = diffStatsFromText(text);
    return `✓ ${tool.name}(${target}) +${stats.added} -${stats.removed}`;
  }

  if (tool.name === "Bash") {
    const stdout = text.split("STDOUT:")[1]?.split("STDERR:")[0]?.trim() ?? text.trim();
    const firstLine = stdout.split(/\r?\n/).find(Boolean) ?? "no output";
    return `⎿ Bash ${target}: ${firstLine}`;
  }

  return `⎿ ${tool.name} ${target}`;
}

export function formatToolVerboseLines(tool: ToolDisplay): string[] {
  const text = getToolResultText(tool);

  if (!text) {
    return [formatToolSummary(tool)];
  }

  return [
    formatToolSummary(tool),
    ...text.split(/\r?\n/).map((line) => `  ${line}`),
  ];
}

export function formatGroupedToolSummary(group: ToolGroupDisplay): string {
  const counts = new Map<string, number>();

  for (const tool of group.tools) {
    counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);
  }

  const countText = [...counts.entries()]
    .map(([name, count]) => `${name} ${count}`)
    .join(" · ");
  const targets = group.tools.map(getToolTarget);
  const shown = targets.slice(0, 3).join(", ");
  const more = targets.length > 3 ? `, +${targets.length - 3} more` : "";

  return `● ${countText}\n  ⎿ ${shown}${more}`;
}

export function ToolCard({
  display,
}: {
  display: ToolCardDisplay;
}): ReactNode {
  if (display.kind === "tool_group") {
    return (
      <Box marginLeft={2}>
        <Text dimColor>{formatGroupedToolSummary(display)}</Text>
      </Box>
    );
  }

  const isError = display.tool.result?.is_error === true;

  return (
    <Box marginLeft={2}>
      <Text color={isError ? "red" : "green"}>
        {formatToolSummary(display.tool)}
      </Text>
    </Box>
  );
}
