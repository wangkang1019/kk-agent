export const TASK_STATUSES = ["pending", "in_progress", "completed"] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface Task {
  id: string;
  subject: string;
  description: string;
  activeForm?: string;
  owner?: string;
  status: TaskStatus;
  blocks: string[];
  blockedBy: string[];
  metadata?: Record<string, unknown>;
}
