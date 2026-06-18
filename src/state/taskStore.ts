import {
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Task, TaskStatus } from "../types/task.js";
import { TASK_STATUSES } from "../types/task.js";

const HIGH_WATER_MARK_FILE = ".highwatermark";
const LOCK_DIR = ".lock";
const TASK_LOCK_SUFFIX = ".lock";
const LOCK_RETRIES = 30;
const LOCK_MIN_TIMEOUT_MS = 5;
const LOCK_MAX_TIMEOUT_MS = 100;

let tasksRootOverride: string | null = null;

export type TaskListener = (taskListId: string) => void;

const taskListeners = new Set<TaskListener>();

export function setTasksRootForTesting(root: string | null): void {
  tasksRootOverride = root;
}

export function getTasksRoot(): string {
  return tasksRootOverride ?? path.join(os.homedir(), ".kk-agent", "tasks");
}

export function sanitizePathComponent(input: string): string {
  return String(input).replace(/[^A-Za-z0-9_-]/g, "-");
}

export function getTaskListId(sessionId: string): string {
  return sessionId || "default";
}

export function getTasksDir(taskListId: string): string {
  return path.join(getTasksRoot(), sanitizePathComponent(taskListId));
}

export function getTaskPath(taskListId: string, taskId: string): string {
  return path.join(
    getTasksDir(taskListId),
    `${sanitizePathComponent(taskId)}.json`,
  );
}

function getHighWaterMarkPath(taskListId: string): string {
  return path.join(getTasksDir(taskListId), HIGH_WATER_MARK_FILE);
}

async function ensureTasksDir(taskListId: string): Promise<void> {
  await mkdir(getTasksDir(taskListId), { recursive: true });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  let timeout = LOCK_MIN_TIMEOUT_MS;

  for (let attempt = 0; attempt <= LOCK_RETRIES; attempt += 1) {
    try {
      await mkdir(lockPath, { recursive: false });
      try {
        return await fn();
      } finally {
        await rm(lockPath, { recursive: true, force: true });
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;

      if (code !== "EEXIST" || attempt === LOCK_RETRIES) {
        throw error;
      }

      await sleep(timeout);
      timeout = Math.min(timeout * 2, LOCK_MAX_TIMEOUT_MS);
    }
  }

  throw new Error(`Failed to acquire lock: ${lockPath}`);
}

function getListLockPath(taskListId: string): string {
  return path.join(getTasksDir(taskListId), LOCK_DIR);
}

function getTaskLockPath(taskListId: string, taskId: string): string {
  return path.join(
    getTasksDir(taskListId),
    `${sanitizePathComponent(taskId)}${TASK_LOCK_SUFFIX}`,
  );
}

async function readHighWaterMark(taskListId: string): Promise<number> {
  try {
    const content = (await readFile(getHighWaterMarkPath(taskListId), "utf8")).trim();
    const value = Number.parseInt(content, 10);
    return Number.isNaN(value) ? 0 : value;
  } catch {
    return 0;
  }
}

async function writeHighWaterMark(
  taskListId: string,
  value: number,
): Promise<void> {
  await ensureTasksDir(taskListId);
  await writeFile(getHighWaterMarkPath(taskListId), String(value), "utf8");
}

async function findHighestTaskIdFromFiles(taskListId: string): Promise<number> {
  let files: string[];

  try {
    files = await readdir(getTasksDir(taskListId));
  } catch {
    return 0;
  }

  let highest = 0;

  for (const file of files) {
    if (!file.endsWith(".json") || file.startsWith(".")) {
      continue;
    }

    const value = Number.parseInt(file.replace(".json", ""), 10);

    if (!Number.isNaN(value) && value > highest) {
      highest = value;
    }
  }

  return highest;
}

async function findHighestTaskId(taskListId: string): Promise<number> {
  const [fromFiles, fromMark] = await Promise.all([
    findHighestTaskIdFromFiles(taskListId),
    readHighWaterMark(taskListId),
  ]);

  return Math.max(fromFiles, fromMark);
}

function parseStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function isTaskStatus(value: unknown): value is TaskStatus {
  return (
    typeof value === "string" &&
    TASK_STATUSES.includes(value as TaskStatus)
  );
}

function parseTask(raw: unknown): Task | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const value = raw as Record<string, unknown>;

  if (
    typeof value.id !== "string" ||
    typeof value.subject !== "string" ||
    typeof value.description !== "string" ||
    !isTaskStatus(value.status)
  ) {
    return null;
  }

  const task: Task = {
    id: value.id,
    subject: value.subject,
    description: value.description,
    status: value.status,
    blocks: parseStringArray(value.blocks),
    blockedBy: parseStringArray(value.blockedBy),
  };

  if (typeof value.activeForm === "string") {
    task.activeForm = value.activeForm;
  }

  if (typeof value.owner === "string") {
    task.owner = value.owner;
  }

  if (
    value.metadata &&
    typeof value.metadata === "object" &&
    !Array.isArray(value.metadata)
  ) {
    task.metadata = value.metadata as Record<string, unknown>;
  }

  return task;
}

function notifyTasksUpdated(taskListId: string): void {
  for (const listener of taskListeners) {
    listener(taskListId);
  }
}

export function subscribeTasks(listener: TaskListener): () => void {
  taskListeners.add(listener);

  return () => {
    taskListeners.delete(listener);
  };
}

async function writeTask(taskListId: string, task: Task): Promise<void> {
  await ensureTasksDir(taskListId);
  await writeFile(
    getTaskPath(taskListId, task.id),
    `${JSON.stringify(task, null, 2)}\n`,
    "utf8",
  );
}

export async function createTask(
  taskListId: string,
  data: Omit<Task, "id">,
): Promise<string> {
  await ensureTasksDir(taskListId);

  return withLock(getListLockPath(taskListId), async () => {
    const id = String((await findHighestTaskId(taskListId)) + 1);
    await writeTask(taskListId, { id, ...data });
    notifyTasksUpdated(taskListId);
    return id;
  });
}

export async function getTask(
  taskListId: string,
  taskId: string,
): Promise<Task | null> {
  try {
    const content = await readFile(getTaskPath(taskListId, taskId), "utf8");
    return parseTask(JSON.parse(content));
  } catch {
    return null;
  }
}

export async function listTasks(taskListId: string): Promise<Task[]> {
  let files: string[];

  try {
    files = await readdir(getTasksDir(taskListId));
  } catch {
    return [];
  }

  const ids = files
    .filter((file) => file.endsWith(".json") && !file.startsWith("."))
    .map((file) => file.replace(".json", ""));
  const tasks = await Promise.all(ids.map((id) => getTask(taskListId, id)));

  return tasks
    .filter((task): task is Task => task !== null)
    .sort((left, right) => Number(left.id) - Number(right.id));
}

async function updateTaskUnsafe(
  taskListId: string,
  taskId: string,
  updates: Partial<Omit<Task, "id">>,
): Promise<Task | null> {
  const existing = await getTask(taskListId, taskId);

  if (!existing) {
    return null;
  }

  const updated = { ...existing, ...updates, id: taskId };
  await writeTask(taskListId, updated);
  notifyTasksUpdated(taskListId);
  return updated;
}

export async function updateTask(
  taskListId: string,
  taskId: string,
  updates: Partial<Omit<Task, "id">>,
): Promise<Task | null> {
  if (!await getTask(taskListId, taskId)) {
    return null;
  }

  return withLock(getTaskLockPath(taskListId, taskId), () => {
    return updateTaskUnsafe(taskListId, taskId, updates);
  });
}

export async function deleteTask(
  taskListId: string,
  taskId: string,
): Promise<boolean> {
  const numericId = Number.parseInt(taskId, 10);

  if (!Number.isNaN(numericId)) {
    const highWaterMark = await readHighWaterMark(taskListId);

    if (numericId > highWaterMark) {
      await writeHighWaterMark(taskListId, numericId);
    }
  }

  try {
    await rm(getTaskPath(taskListId, taskId), { force: false });
  } catch {
    return false;
  }

  const siblings = await listTasks(taskListId);

  for (const sibling of siblings) {
    const blocks = sibling.blocks.filter((id) => id !== taskId);
    const blockedBy = sibling.blockedBy.filter((id) => id !== taskId);

    if (
      blocks.length !== sibling.blocks.length ||
      blockedBy.length !== sibling.blockedBy.length
    ) {
      await updateTask(taskListId, sibling.id, { blocks, blockedBy });
    }
  }

  notifyTasksUpdated(taskListId);
  return true;
}

export async function resetTaskList(taskListId: string): Promise<void> {
  await ensureTasksDir(taskListId);

  await withLock(getListLockPath(taskListId), async () => {
    const highest = await findHighestTaskIdFromFiles(taskListId);
    const mark = await readHighWaterMark(taskListId);

    if (highest > mark) {
      await writeHighWaterMark(taskListId, highest);
    }

    const files = await readdir(getTasksDir(taskListId));

    for (const file of files) {
      if (file.endsWith(".json") && !file.startsWith(".")) {
        await rm(path.join(getTasksDir(taskListId), file), { force: true });
      }
    }

    notifyTasksUpdated(taskListId);
  });
}

export async function blockTask(
  taskListId: string,
  fromTaskId: string,
  toTaskId: string,
): Promise<boolean> {
  const [from, to] = await Promise.all([
    getTask(taskListId, fromTaskId),
    getTask(taskListId, toTaskId),
  ]);

  if (!from || !to) {
    return false;
  }

  if (!from.blocks.includes(toTaskId)) {
    await updateTask(taskListId, fromTaskId, {
      blocks: [...from.blocks, toTaskId],
    });
  }

  if (!to.blockedBy.includes(fromTaskId)) {
    await updateTask(taskListId, toTaskId, {
      blockedBy: [...to.blockedBy, fromTaskId],
    });
  }

  return true;
}

export function isReady(task: Task, tasks: readonly Task[]): boolean {
  if (task.status !== "pending") {
    return false;
  }

  const unresolved = new Set(
    tasks.filter((item) => item.status !== "completed").map((item) => item.id),
  );

  return task.blockedBy.every((id) => !unresolved.has(id));
}
