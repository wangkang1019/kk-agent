import { readFile, writeFile } from "node:fs/promises";

import type { Tool, ToolContext, ToolResult } from "./Tool.js";
import { resolveWorkspacePath } from "./pathUtils.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeQuotes(value: string): string {
  return value
    .replaceAll("\u201c", "\"")
    .replaceAll("\u201d", "\"")
    .replaceAll("\u2018", "'")
    .replaceAll("\u2019", "'");
}

function countOccurrences(content: string, search: string): number {
  if (!search) {
    return 0;
  }

  let count = 0;
  let index = content.indexOf(search);

  while (index !== -1) {
    count++;
    index = content.indexOf(search, index + search.length);
  }

  return count;
}

export const fileEditTool: Tool = {
  name: "Edit",
  description: "Replace a unique string in a file in the current workspace.",
  inputSchema: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "File path to edit.",
      },
      old_string: {
        type: "string",
        description: "Existing text to replace. Must match exactly and uniquely.",
      },
      new_string: {
        type: "string",
        description: "Replacement text.",
      },
    },
    required: ["file_path", "old_string", "new_string"],
  },
  async call(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    if (context.abortSignal?.aborted) {
      return { content: "Edit was aborted.", isError: true };
    }

    if (
      !isRecord(input) ||
      typeof input.file_path !== "string" ||
      typeof input.old_string !== "string" ||
      typeof input.new_string !== "string"
    ) {
      return {
        content: "Edit requires string file_path, old_string, and new_string.",
        isError: true,
      };
    }

    const filePath = input.file_path.trim();
    const oldString = normalizeQuotes(input.old_string);
    const newString = normalizeQuotes(input.new_string);

    if (!filePath) {
      return { content: "Edit requires a non-empty file_path.", isError: true };
    }

    if (!oldString) {
      return { content: "Edit requires a non-empty old_string.", isError: true };
    }

    try {
      const resolvedPath = resolveWorkspacePath(filePath, context.cwd);
      const content = await readFile(resolvedPath, {
        encoding: "utf8",
        signal: context.abortSignal,
      });
      const occurrenceCount = countOccurrences(content, oldString);

      if (occurrenceCount === 0) {
        return {
          content: `Error: old_string not found in ${filePath}`,
          isError: true,
        };
      }

      if (occurrenceCount > 1) {
        return {
          content: `Error: old_string is not unique in ${filePath} (${occurrenceCount} matches)`,
          isError: true,
        };
      }

      const updated = content.replace(oldString, newString);
      await writeFile(resolvedPath, updated, {
        encoding: "utf8",
        signal: context.abortSignal,
      });

      return {
        content: `Edited file: ${resolvedPath}\n- ${oldString}\n+ ${newString}`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: `Error: Cannot edit ${filePath}: ${message}`, isError: true };
    }
  },
  isReadOnly(): boolean {
    return false;
  },
  isEnabled(): boolean {
    return true;
  },
};
