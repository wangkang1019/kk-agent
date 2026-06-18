import { readdir, readFile } from "node:fs/promises";

import type { Tool, ToolContext, ToolResult } from "./Tool.js";
import { resolveWorkspacePath } from "./pathUtils.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getNumberInput(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key];

  if (value === undefined) {
    return undefined;
  }

  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function selectLines(content: string, offset?: number, limit?: number): {
  selected: string[];
  startLine: number;
  totalLines: number;
} {
  const lines = content.split(/\r?\n/);
  const start = offset === undefined ? 0 : Math.max(0, Math.floor(offset) - 1);
  const end =
    limit === undefined ? undefined : start + Math.max(0, Math.floor(limit));

  return {
    selected: lines.slice(start, end),
    startLine: start + 1,
    totalLines: lines.length,
  };
}

function addLineNumbers(lines: string[], startLine: number): string {
  const lastLine = startLine + Math.max(0, lines.length - 1);
  const padWidth = String(lastLine).length;

  return lines
    .map((line, index) => {
      const lineNumber = String(startLine + index).padStart(padWidth, " ");
      return `${lineNumber}\t${line}`;
    })
    .join("\n");
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }

  return undefined;
}

function formatReadError(error: unknown, filePath: string): ToolResult {
  switch (getErrorCode(error)) {
    case "ENOENT":
      return { content: `Error: File not found: ${filePath}`, isError: true };
    case "EISDIR":
      return { content: `Error: Path is a directory: ${filePath}`, isError: true };
    case "EACCES":
    case "EPERM":
      return { content: `Error: Permission denied: ${filePath}`, isError: true };
    default: {
      const message = error instanceof Error ? error.message : String(error);
      return { content: `Error: Cannot read ${filePath}: ${message}`, isError: true };
    }
  }
}

async function readDirectory(resolvedPath: string): Promise<ToolResult> {
  const entries = await readdir(resolvedPath, { withFileTypes: true });
  const listing = entries
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => `- ${entry.name}${entry.isDirectory() ? "/" : ""}`)
    .join("\n");

  return { content: `${resolvedPath} (directory)\n${listing}` };
}

export const fileReadTool: Tool = {
  name: "Read",
  description: "Read the contents of a file from the current workspace.",
  inputSchema: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "File path to read.",
      },
      offset: {
        type: "number",
        description: "Starting line number, 1-indexed.",
      },
      limit: {
        type: "number",
        description: "Number of lines to read.",
      },
    },
    required: ["file_path"],
  },
  async call(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    if (context.abortSignal?.aborted) {
      return { content: "Read was aborted.", isError: true };
    }

    if (!isRecord(input) || typeof input.file_path !== "string") {
      return { content: "Read requires a string file_path.", isError: true };
    }

    const filePath = input.file_path.trim();

    if (!filePath) {
      return { content: "Read requires a non-empty file_path.", isError: true };
    }

    try {
      const resolvedPath = resolveWorkspacePath(
        filePath,
        context.cwd,
        context.allowedRoots,
      );
      const content = await readFile(resolvedPath, {
        encoding: "utf8",
        signal: context.abortSignal,
      });
      const offset = getNumberInput(input, "offset");
      const limit = getNumberInput(input, "limit");
      const { selected, startLine, totalLines } = selectLines(
        content,
        offset,
        limit,
      );
      const numbered = addLineNumbers(selected, startLine);

      return { content: `${resolvedPath} (${totalLines} lines)\n${numbered}` };
    } catch (error) {
      if (getErrorCode(error) === "EISDIR") {
        try {
          return await readDirectory(
            resolveWorkspacePath(filePath, context.cwd, context.allowedRoots),
          );
        } catch (directoryError) {
          return formatReadError(directoryError, filePath);
        }
      }

      if (error instanceof Error && /outside the workspace/.test(error.message)) {
        return { content: `Cannot read ${filePath}: ${error.message}`, isError: true };
      }

      return formatReadError(error, filePath);
    }
  },
  isReadOnly(): boolean {
    return true;
  },
  isEnabled(): boolean {
    return true;
  },
  isConcurrencySafe(): boolean {
    return true;
  },
};
