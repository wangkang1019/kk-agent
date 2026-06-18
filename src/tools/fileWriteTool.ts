import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Tool, ToolContext, ToolResult } from "./Tool.js";
import { resolveWorkspacePath } from "./pathUtils.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export const fileWriteTool: Tool = {
  name: "Write",
  description: "Create or overwrite a file in the current workspace.",
  inputSchema: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "File path to write.",
      },
      content: {
        type: "string",
        description: "Complete file content to write.",
      },
    },
    required: ["file_path", "content"],
  },
  async call(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    if (context.abortSignal?.aborted) {
      return { content: "Write was aborted.", isError: true };
    }

    if (!isRecord(input) || typeof input.file_path !== "string") {
      return { content: "Write requires a string file_path.", isError: true };
    }

    if (typeof input.content !== "string") {
      return { content: "Write requires string content.", isError: true };
    }

    const filePath = input.file_path.trim();

    if (!filePath) {
      return { content: "Write requires a non-empty file_path.", isError: true };
    }

    try {
      const resolvedPath = resolveWorkspacePath(
        filePath,
        context.cwd,
        context.allowedRoots,
      );
      const existed = await fileExists(resolvedPath);

      await mkdir(path.dirname(resolvedPath), { recursive: true });
      await writeFile(resolvedPath, input.content, {
        encoding: "utf8",
        signal: context.abortSignal,
      });

      return {
        content: `${existed ? "Updated" : "Created"} file: ${resolvedPath}`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: `Error: Cannot write ${filePath}: ${message}`, isError: true };
    }
  },
  isReadOnly(): boolean {
    return false;
  },
  isEnabled(): boolean {
    return true;
  },
};
