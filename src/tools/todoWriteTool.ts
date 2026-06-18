import { parseTodos, setTodos } from "../state/todoStore.js";
import { isTodoModeEnabled } from "../state/taskModeStore.js";
import type { Tool, ToolContext, ToolResult } from "./Tool.js";

export const todoWriteTool: Tool = {
  name: "TodoWrite",
  description:
    "Update the todo list for the current session. Use it proactively to track progress and pending tasks for multi-step work. Each call replaces the entire list.",
  inputSchema: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        description:
          "The full updated todo list. Each call replaces the entire previous list.",
        items: {
          type: "object",
          properties: {
            content: {
              type: "string",
              description: "Imperative task description, such as Run the tests.",
            },
            status: {
              type: "string",
              enum: ["pending", "in_progress", "completed"],
              description: "Current task status.",
            },
            activeForm: {
              type: "string",
              description:
                "Present-tense status text for the active spinner, such as Running the tests.",
            },
          },
          required: ["content", "status", "activeForm"],
        },
      },
    },
    required: ["todos"],
  },
  async call(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    const parsed = parseTodos(input);

    if (!Array.isArray(parsed)) {
      return { content: `Error: ${parsed.error}`, isError: true };
    }

    const sessionId = context.sessionId ?? "default";
    const allDone =
      parsed.length > 0 && parsed.every((todo) => todo.status === "completed");

    setTodos(sessionId, allDone ? [] : parsed);

    return {
      content:
        "Todos have been modified successfully. " +
        "Ensure that you continue to use the todo list to track your progress. " +
        "Please proceed with the current tasks if applicable",
    };
  },
  isReadOnly(): boolean {
    return false;
  },
  isEnabled(): boolean {
    return isTodoModeEnabled();
  },
};
