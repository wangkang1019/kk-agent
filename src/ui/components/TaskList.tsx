import { Box, Text } from "ink";
import type { ReactNode } from "react";

import type { Task } from "../../types/task.js";

export function countCompletedTasks(tasks: Task[]): number {
  return tasks.filter((task) => task.status === "completed").length;
}

export function getInProgressTask(tasks: Task[]): Task | null {
  return tasks.find((task) => task.status === "in_progress") ?? null;
}

export function getOpenBlockers(task: Task, tasks: Task[]): string[] {
  const completed = new Set(
    tasks.filter((item) => item.status === "completed").map((item) => item.id),
  );

  return task.blockedBy.filter((id) => !completed.has(id));
}

export function formatTaskRow(task: Task, openBlockers: string[]): string {
  const blocked = openBlockers.length > 0
    ? ` [blocked by ${openBlockers.map((id) => `#${id}`).join(", ")}]`
    : "";

  if (task.status === "completed") {
    return `✓ #${task.id} ${task.subject}`;
  }

  if (task.status === "in_progress") {
    return `▸ #${task.id} ${task.activeForm ?? task.subject}${blocked}`;
  }

  return `○ #${task.id} ${task.subject}${blocked}`;
}

export function TaskList({ tasks }: { tasks: Task[] }): ReactNode {
  if (tasks.length === 0) {
    return null;
  }

  const sorted = [...tasks].sort((left, right) => Number(left.id) - Number(right.id));
  const completed = countCompletedTasks(sorted);

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold color="cyan">
        Tasks ({completed}/{sorted.length} done)
      </Text>
      {sorted.map((task) => (
        <Text
          key={task.id}
          color={task.status === "in_progress" ? "yellow" : undefined}
          dimColor={task.status === "completed"}
        >
          {"  "}
          {formatTaskRow(task, getOpenBlockers(task, sorted))}
        </Text>
      ))}
    </Box>
  );
}
