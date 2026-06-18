export type TaskMode = "task" | "todo";

export type TaskModeListener = (mode: TaskMode) => void;

let currentMode: TaskMode = "task";
const listeners = new Set<TaskModeListener>();

export function getTaskMode(): TaskMode {
  return currentMode;
}

export function setTaskMode(mode: TaskMode): void {
  if (mode === currentMode) {
    return;
  }

  currentMode = mode;

  for (const listener of listeners) {
    listener(mode);
  }
}

export function subscribeTaskMode(listener: TaskModeListener): () => void {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

export function isTaskModeEnabled(): boolean {
  return currentMode === "task";
}

export function isTodoModeEnabled(): boolean {
  return currentMode === "todo";
}
