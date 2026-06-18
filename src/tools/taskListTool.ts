import { getTaskListId, listTasks } from "../state/taskStore.js";
import { isTaskModeEnabled } from "../state/taskModeStore.js";
import type { Tool, ToolContext, ToolResult } from "./Tool.js";

export const taskListTool: Tool = {
  name: "TaskList",
  description:
    "List all tasks in the current persistent task graph. Use before starting work to find the next unblocked task.",
  inputSchema: {
    type: "object",
    properties: {},
  },
  async call(_input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const taskListId = getTaskListId(context.sessionId ?? "default");
    const tasks = await listTasks(taskListId);

    if (tasks.length === 0) {
      return { content: "No tasks found" };
    }

    const completed = new Set(
      tasks.filter((task) => task.status === "completed").map((task) => task.id),
    );
    const lines = tasks.map((task) => {
      const openBlockers = task.blockedBy.filter((id) => !completed.has(id));
      const blocked = openBlockers.length > 0
        ? ` [blocked by ${openBlockers.map((id) => `#${id}`).join(", ")}]`
        : "";
      return `#${task.id} [${task.status}] ${task.subject}${blocked}`;
    });

    return { content: lines.join("\n") };
  },
  isReadOnly(): boolean {
    return true;
  },
  isEnabled(): boolean {
    return isTaskModeEnabled();
  },
};
