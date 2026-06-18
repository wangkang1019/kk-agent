export interface PendingNotification {
  mode: "task-notification";
  text: string;
  enqueuedAt: number;
}

export type NotificationListener = (count: number) => void;

const queue: PendingNotification[] = [];
const listeners = new Set<NotificationListener>();

function emit(): void {
  for (const listener of listeners) {
    listener(queue.length);
  }
}

export function subscribeNotifications(listener: NotificationListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function enqueuePendingNotification(
  notification: Omit<PendingNotification, "enqueuedAt">,
): void {
  queue.push({ ...notification, enqueuedAt: Date.now() });
  emit();
}

export function drainPendingNotifications(): PendingNotification[] {
  const drained = queue.splice(0, queue.length);
  emit();
  return drained;
}

export function getPendingNotificationCount(): number {
  return queue.length;
}

export function clearPendingNotificationsForTesting(): void {
  queue.splice(0, queue.length);
  emit();
}

export function formatTaskNotification(params: {
  agentId: string;
  agentType: string;
  status: "completed" | "failed" | "killed";
  description?: string;
  outputFile: string;
  finalText?: string;
  error?: string;
  durationMs?: number;
  totalTokens?: number;
  toolUseCount?: number;
  worktreePath?: string;
  worktreeBranch?: string;
}): string {
  const lines = [
    "<task-notification>",
    `  <task_id>${params.agentId}</task_id>`,
    `  <agent_type>${params.agentType}</agent_type>`,
    `  <status>${params.status}</status>`,
  ];

  if (params.description) {
    lines.push(`  <description>${params.description}</description>`);
  }

  lines.push(`  <output_file>${params.outputFile}</output_file>`);

  if (params.finalText) {
    lines.push("  <result>", params.finalText, "  </result>");
  }

  if (params.error) {
    lines.push(`  <error>${params.error}</error>`);
  }

  const usage = [
    typeof params.totalTokens === "number" ? `tokens=${params.totalTokens}` : "",
    typeof params.toolUseCount === "number" ? `tools=${params.toolUseCount}` : "",
    typeof params.durationMs === "number" ? `duration_ms=${params.durationMs}` : "",
  ].filter(Boolean).join(" ");

  if (usage) {
    lines.push(`  <usage>${usage}</usage>`);
  }

  if (params.worktreePath) {
    lines.push(`  <worktree_path>${params.worktreePath}</worktree_path>`);
  }

  if (params.worktreeBranch) {
    lines.push(`  <worktree_branch>${params.worktreeBranch}</worktree_branch>`);
  }

  lines.push("</task-notification>");
  return lines.join("\n");
}
