export interface ParsedTaskNotification {
  taskId?: string;
  agentType?: string;
  status?: string;
  description?: string;
  outputFile?: string;
  result?: string;
  usage?: string;
  error?: string;
}

function readTag(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`).exec(xml);
  return match?.[1]?.trim();
}

export function isTaskNotificationText(content: string): boolean {
  return content.includes("<task-notification>") ||
    content.startsWith("[task-notification]");
}

export function parseTaskNotification(
  content: string,
): ParsedTaskNotification | null {
  if (!isTaskNotificationText(content)) {
    return null;
  }

  const xml = content.replace(/^\[task-notification\]\s*/, "");

  return {
    taskId: readTag(xml, "task_id"),
    agentType: readTag(xml, "agent_type"),
    status: readTag(xml, "status"),
    description: readTag(xml, "description"),
    outputFile: readTag(xml, "output_file"),
    result: readTag(xml, "result"),
    usage: readTag(xml, "usage"),
    error: readTag(xml, "error"),
  };
}

export function formatTaskNotificationTitle(
  notification: ParsedTaskNotification,
): string {
  const status = notification.status ?? "completed";
  const normalized = status.charAt(0).toUpperCase() + status.slice(1);
  return `Background Agent ${normalized}`;
}

export function taskNotificationToLines(
  notification: ParsedTaskNotification,
): string[] {
  const lines = [formatTaskNotificationTitle(notification)];
  const subtitle = [
    notification.agentType,
    notification.description,
  ].filter(Boolean).join(" · ");

  if (subtitle) lines.push(subtitle);
  if (notification.usage) lines.push(notification.usage);
  if (notification.outputFile) lines.push(`output: ${notification.outputFile}`);
  if (notification.error) lines.push(`error: ${notification.error}`);
  if (notification.result) {
    lines.push(
      ...notification.result.split(/\r?\n/).filter(Boolean).slice(0, 5),
    );
  }

  return lines;
}
