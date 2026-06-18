import type { Tool, ToolContext, ToolResult } from "./Tool.js";
import {
  type MemoryType,
  saveMemory,
  shouldStoreAsMemory,
} from "../memory/projectMemory.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getString(input: Record<string, unknown>, key: string): string | null {
  const value = input[key];
  return typeof value === "string" ? value.trim() : null;
}

export const memoryWriteTool: Tool = {
  name: "MemoryWrite",
  description:
    "Save or update a long-term project memory that remains useful across future conversations. Only store facts that cannot be easily inferred from the current repository.",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Short stable title for the memory.",
      },
      description: {
        type: "string",
        description: "One-line hook used in MEMORY.md.",
      },
      type: {
        type: "string",
        description: "One of: user, feedback, project, reference.",
      },
      body: {
        type: "string",
        description: "Markdown body explaining the durable memory.",
      },
    },
    required: ["name", "description", "type", "body"],
  },
  async call(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    if (!isRecord(input)) {
      return { content: "MemoryWrite requires an object input.", isError: true };
    }

    const memory = {
      name: getString(input, "name") ?? "",
      description: getString(input, "description") ?? "",
      type: getString(input, "type") ?? "",
      body: getString(input, "body") ?? "",
    };

    if (!shouldStoreAsMemory(memory)) {
      return {
        content:
          "Invalid memory payload. Memory requires name, description, type(user|feedback|project|reference), and body. Store only durable facts that cannot be inferred from the repository.",
        isError: true,
      };
    }

    try {
      const filePath = await saveMemory({
        cwd: context.cwd,
        memory: {
          ...memory,
          type: memory.type as MemoryType,
        },
      });

      return { content: `Saved project memory: ${filePath}` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: `Error: Cannot save memory: ${message}`, isError: true };
    }
  },
  isReadOnly(): boolean {
    return false;
  },
  isEnabled(): boolean {
    return true;
  },
};
