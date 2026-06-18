import {
  blockTask,
  deleteTask,
  getTask,
  getTaskListId,
  updateTask,
} from "../state/taskStore.js";
import { isTaskModeEnabled } from "../state/taskModeStore.js";
import type { Task, TaskStatus } from "../types/task.js";
import { TASK_STATUSES } from "../types/task.js";
import type { Tool, ToolContext, ToolResult } from "./Tool.js";

type UpdateStatus = TaskStatus | "deleted";

function getString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" ? value.trim() : undefined;
}

function getStringArray(input: Record<string, unknown>, key: string): string[] | undefined {
  const value = input[key];
  if (!Array.isArray(value)) {
    return undefined;
  }

  const items = value.filter((item): item is string => typeof item === "string");
  return items.length === value.length ? items : undefined;
}

function mergeMetadata(
  existing: Record<string, unknown> | undefined,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...(existing ?? {}) };

  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete next[key];
    } else {
      next[key] = value;
    }
  }

  return next;
}

function isUpdateStatus(value: string): value is UpdateStatus {
  return value === "deleted" || TASK_STATUSES.includes(value as TaskStatus);
}

export const taskUpdateTool: Tool = {
  name: "TaskUpdate",
  description:
    "Update a persistent task. Use for status changes, field edits, metadata, dependencies, or deletion by setting status to deleted.",
  inputSchema: {
    type: "object",
    properties: {
      taskId: { type: "string", description: "Task id to update." },
      subject: { type: "string", description: "New task subject." },
      description: { type: "string", description: "New task description." },
      activeForm: { type: "string", description: "New active spinner text." },
      status: {
        type: "string",
        enum: ["pending", "in_progress", "completed", "deleted"],
        description: "New status. deleted removes the task.",
      },
      addBlocks: {
        type: "array",
        items: { type: "string" },
        description: "Downstream task ids blocked by this task.",
      },
      addBlockedBy: {
        type: "array",
        items: { type: "string" },
        description: "Upstream task ids that block this task.",
      },
      metadata: { type: "object", description: "Metadata patch. Null deletes a key." },
    },
    required: ["taskId"],
  },
  async call(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const taskId = getString(input, "taskId");

    if (!taskId) {
      return { content: "Error: `taskId` is required.", isError: true };
    }

    const taskListId = getTaskListId(context.sessionId ?? "default");
    const existing = await getTask(taskListId, taskId);

    if (!existing) {
      return { content: `Task #${taskId} not found`, isError: true };
    }

    const status = getString(input, "status");

    if (status !== undefined && !isUpdateStatus(status)) {
      return { content: `Error: invalid status '${status}'.`, isError: true };
    }

    if (status === "deleted") {
      const deleted = await deleteTask(taskListId, taskId);
      return deleted
        ? { content: `Task #${taskId} deleted.` }
        : { content: `Failed to delete task #${taskId}.`, isError: true };
    }

    const updates: Partial<Omit<Task, "id">> = {};
    const fields: string[] = [];
    const subject = getString(input, "subject");
    const description = getString(input, "description");
    const activeForm = getString(input, "activeForm");

    if (subject !== undefined && subject !== existing.subject) {
      updates.subject = subject;
      fields.push("subject");
    }
    if (description !== undefined && description !== existing.description) {
      updates.description = description;
      fields.push("description");
    }
    if (activeForm !== undefined && activeForm !== existing.activeForm) {
      updates.activeForm = activeForm;
      fields.push("activeForm");
    }
    if (status !== undefined && status !== existing.status) {
      updates.status = status;
      fields.push("status");
    }
    if (input.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata)) {
      updates.metadata = mergeMetadata(existing.metadata, input.metadata as Record<string, unknown>);
      fields.push("metadata");
    }

    if (Object.keys(updates).length > 0) {
      await updateTask(taskListId, taskId, updates);
    }

    const addBlocks = getStringArray(input, "addBlocks");
    if (addBlocks) {
      let changed = false;
      for (const downstream of addBlocks) {
        if (!existing.blocks.includes(downstream)) {
          changed = await blockTask(taskListId, taskId, downstream) || changed;
        }
      }
      if (changed) {
        fields.push("blocks");
      }
    }

    const addBlockedBy = getStringArray(input, "addBlockedBy");
    if (addBlockedBy) {
      let changed = false;
      for (const upstream of addBlockedBy) {
        if (!existing.blockedBy.includes(upstream)) {
          changed = await blockTask(taskListId, upstream, taskId) || changed;
        }
      }
      if (changed) {
        fields.push("blockedBy");
      }
    }

    return fields.length > 0
      ? { content: `Updated task #${taskId}: ${fields.join(", ")}` }
      : { content: `Task #${taskId} unchanged.` };
  },
  isReadOnly(): boolean {
    return false;
  },
  isEnabled(): boolean {
    return isTaskModeEnabled();
  },
};
