import { createTask, getTaskListId } from "../state/taskStore.js";
import { isTaskModeEnabled } from "../state/taskModeStore.js";
import type { Tool, ToolContext, ToolResult } from "./Tool.js";

function getString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" ? value.trim() : undefined;
}

function getMetadata(input: Record<string, unknown>): Record<string, unknown> | undefined {
  return input.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata)
    ? input.metadata as Record<string, unknown>
    : undefined;
}

export const taskCreateTool: Tool = {
  name: "TaskCreate",
  description:
    "Create a persistent task in the current session's task graph. Use this for multi-step work that should survive restarts and support dependencies.",
  inputSchema: {
    type: "object",
    properties: {
      subject: {
        type: "string",
        description: "Imperative one-line task title, such as Run the tests.",
      },
      description: {
        type: "string",
        description: "Detailed description of the task.",
      },
      activeForm: {
        type: "string",
        description: "Present-tense spinner text, such as Running the tests.",
      },
      metadata: {
        type: "object",
        description: "Optional free-form metadata.",
      },
    },
    required: ["subject", "description"],
  },
  async call(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const subject = getString(input, "subject");
    const description = getString(input, "description");

    if (!subject) {
      return { content: "Error: `subject` must be a non-empty string.", isError: true };
    }

    if (!description) {
      return { content: "Error: `description` must be a non-empty string.", isError: true };
    }

    const taskListId = getTaskListId(context.sessionId ?? "default");
    const id = await createTask(taskListId, {
      subject,
      description,
      activeForm: getString(input, "activeForm"),
      status: "pending",
      blocks: [],
      blockedBy: [],
      metadata: getMetadata(input),
    });

    return { content: `Task #${id} created: ${subject}` };
  },
  isReadOnly(): boolean {
    return false;
  },
  isEnabled(): boolean {
    return isTaskModeEnabled();
  },
};
