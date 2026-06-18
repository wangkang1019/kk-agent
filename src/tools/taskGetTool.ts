import { getTask, getTaskListId } from "../state/taskStore.js";
import { isTaskModeEnabled } from "../state/taskModeStore.js";
import type { Tool, ToolContext, ToolResult } from "./Tool.js";

export const taskGetTool: Tool = {
  name: "TaskGet",
  description:
    "Read full details for one task by id. Call this before TaskUpdate when editing a task.",
  inputSchema: {
    type: "object",
    properties: {
      taskId: { type: "string", description: "Task id to read." },
    },
    required: ["taskId"],
  },
  async call(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const taskId = typeof input.taskId === "string" ? input.taskId.trim() : "";

    if (!taskId) {
      return { content: "Error: `taskId` is required.", isError: true };
    }

    const task = await getTask(getTaskListId(context.sessionId ?? "default"), taskId);

    if (!task) {
      return { content: `Task #${taskId} not found`, isError: true };
    }

    const lines = [
      `Task #${task.id}: ${task.subject}`,
      `Status: ${task.status}`,
      `Description: ${task.description}`,
    ];

    if (task.activeForm) {
      lines.push(`ActiveForm: ${task.activeForm}`);
    }
    if (task.blockedBy.length > 0) {
      lines.push(`Blocked by: ${task.blockedBy.map((id) => `#${id}`).join(", ")}`);
    }
    if (task.blocks.length > 0) {
      lines.push(`Blocks: ${task.blocks.map((id) => `#${id}`).join(", ")}`);
    }

    return { content: lines.join("\n") };
  },
  isReadOnly(): boolean {
    return true;
  },
  isEnabled(): boolean {
    return isTaskModeEnabled();
  },
};
