import crypto from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { diffLines } from "diff";

const DEFAULT_AGENT_HOME = path.join(os.homedir(), ".kk-agent");
const MAX_SNAPSHOTS = 100;
const DEFAULT_CLEANUP_DAYS = 30;

export interface FileHistoryBackup {
  backupFileName: string | null;
  version: number;
  backupTime: string;
}

export interface FileHistorySnapshot {
  messageId: string;
  prompt?: string;
  trackedFileBackups: Record<string, FileHistoryBackup>;
  timestamp: string;
}

export interface FileHistoryDiffStats {
  filesChanged: string[];
  insertions: number;
  deletions: number;
}

export interface FileHistoryDiffPreview {
  files: Array<{
    filePath: string;
    lines: string[];
    truncated: boolean;
  }>;
}

export interface FileHistoryStore {
  makeSnapshot(messageId: string, prompt?: string): Promise<FileHistorySnapshot | null>;
  trackEdit(filePath: string, messageId: string): Promise<void>;
  getSnapshotByOffset(offset: number): FileHistorySnapshot | undefined;
  getSnapshotById(messageId: string): FileHistorySnapshot | undefined;
  listSnapshots(): FileHistorySnapshot[];
  getDiffStats(messageId: string): Promise<FileHistoryDiffStats>;
  getDiffPreview(messageId: string, options?: {
    maxFiles?: number;
    maxLinesPerFile?: number;
  }): Promise<FileHistoryDiffPreview>;
  rewind(messageId: string): Promise<string[]>;
  restoreSnapshots(snapshots: FileHistorySnapshot[]): void;
  snapshotCount(): number;
}

export interface CreateFileHistoryStoreParams {
  cwd: string;
  sessionId: string;
  homeDir?: string;
  enabled?: boolean;
  onSnapshot?: (snapshot: FileHistorySnapshot) => Promise<void>;
}

function agentHome(homeDir?: string): string {
  return homeDir ?? DEFAULT_AGENT_HOME;
}

function backupRoot(homeDir: string | undefined, sessionId: string): string {
  return path.join(agentHome(homeDir), "file-history", sessionId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isInsidePath(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function trackingPathFor(filePath: string, cwd: string): string {
  const absolute = path.resolve(filePath);
  return isInsidePath(absolute, cwd)
    ? path.relative(cwd, absolute)
    : absolute;
}

function expandTrackingPath(trackingPath: string, cwd: string): string {
  return path.isAbsolute(trackingPath)
    ? trackingPath
    : path.join(cwd, trackingPath);
}

function backupName(filePath: string, version: number): string {
  const hash = crypto
    .createHash("sha256")
    .update(path.resolve(filePath))
    .digest("hex")
    .slice(0, 16);

  return `${hash}@v${version}`;
}

function backupPath(homeDir: string | undefined, sessionId: string, name: string): string {
  return path.join(backupRoot(homeDir, sessionId), name);
}

async function readTextOrNull(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

async function createBackup(
  filePath: string,
  version: number,
  params: { homeDir?: string; sessionId: string },
): Promise<FileHistoryBackup> {
  const time = new Date().toISOString();

  try {
    await stat(filePath);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return { backupFileName: null, version, backupTime: time };
    }

    throw error;
  }

  const name = backupName(filePath, version);
  const target = backupPath(params.homeDir, params.sessionId, name);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(filePath, target);

  return { backupFileName: name, version, backupTime: time };
}

async function backupContent(
  backupFileName: string | null,
  params: { homeDir?: string; sessionId: string },
): Promise<string | null> {
  if (backupFileName === null) {
    return null;
  }

  return readTextOrNull(backupPath(params.homeDir, params.sessionId, backupFileName));
}

async function fileChangedFromBackup(
  filePath: string,
  backupFileName: string | null,
  params: { homeDir?: string; sessionId: string },
): Promise<boolean> {
  const [current, backup] = await Promise.all([
    readTextOrNull(filePath),
    backupContent(backupFileName, params),
  ]);

  return current !== backup;
}

function countDiff(fromText: string, toText: string): { insertions: number; deletions: number } {
  let insertions = 0;
  let deletions = 0;

  for (const part of diffLines(fromText, toText)) {
    const count = part.count ?? part.value.split(/\r?\n/).filter((line) => line.length > 0).length;

    if (part.added) {
      insertions += count;
    } else if (part.removed) {
      deletions += count;
    }
  }

  return { insertions, deletions };
}

function changedLinesPreview(
  fromText: string,
  toText: string,
  maxLines: number,
): { lines: string[]; truncated: boolean } {
  const lines: string[] = [];
  let truncated = false;

  for (const part of diffLines(fromText, toText)) {
    if (!part.added && !part.removed) {
      continue;
    }

    const prefix = part.added ? "+" : "-";
    const partLines = part.value.split(/\r?\n/);

    for (let index = 0; index < partLines.length; index++) {
      const line = partLines[index] ?? "";

      if (!line && index === partLines.length - 1) {
        continue;
      }

      if (lines.length >= maxLines) {
        truncated = true;
        break;
      }

      lines.push(`${prefix} ${line}`);
    }

    if (truncated) {
      break;
    }
  }

  return { lines, truncated };
}

export function createFileHistoryStore(
  params: CreateFileHistoryStoreParams,
): FileHistoryStore {
  const cwd = path.resolve(params.cwd);
  const enabled = params.enabled !== false;
  let snapshots: FileHistorySnapshot[] = [];
  let trackedFiles = new Set<string>();

  function latestSnapshot(): FileHistorySnapshot | undefined {
    return snapshots[snapshots.length - 1];
  }

  function earliestBackupFor(trackingPath: string): FileHistoryBackup | undefined {
    for (const snapshot of snapshots) {
      const backup = snapshot.trackedFileBackups[trackingPath];
      if (backup) {
        return backup;
      }
    }

    return undefined;
  }

  async function recordSnapshot(snapshot: FileHistorySnapshot): Promise<void> {
    await params.onSnapshot?.(snapshot);
  }

  async function makeSnapshot(
    messageId: string,
    prompt?: string,
  ): Promise<FileHistorySnapshot | null> {
    if (!enabled) {
      return null;
    }

    const previous = latestSnapshot();
    const trackedFileBackups: Record<string, FileHistoryBackup> = {};

    for (const trackingPath of trackedFiles) {
      const absolute = expandTrackingPath(trackingPath, cwd);
      const previousBackup = previous?.trackedFileBackups[trackingPath];
      const version = previousBackup ? previousBackup.version + 1 : 1;

      if (
        previousBackup &&
        !(await fileChangedFromBackup(absolute, previousBackup.backupFileName, params))
      ) {
        trackedFileBackups[trackingPath] = previousBackup;
      } else {
        trackedFileBackups[trackingPath] = await createBackup(absolute, version, params);
      }
    }

    const snapshot = {
      messageId,
      ...(prompt && { prompt }),
      trackedFileBackups,
      timestamp: new Date().toISOString(),
    };
    snapshots.push(snapshot);

    if (snapshots.length > MAX_SNAPSHOTS) {
      snapshots = snapshots.slice(-MAX_SNAPSHOTS);
    }

    await recordSnapshot(snapshot);
    return snapshot;
  }

  async function trackEdit(filePath: string, messageId: string): Promise<void> {
    if (!enabled) {
      return;
    }

    const absolute = path.resolve(cwd, filePath);

    if (!isInsidePath(absolute, cwd)) {
      return;
    }

    if (!latestSnapshot()) {
      snapshots.push({
        messageId,
        trackedFileBackups: {},
        timestamp: new Date().toISOString(),
      });
    }

    const snapshot = latestSnapshot();

    if (!snapshot) {
      return;
    }

    const trackingPath = trackingPathFor(absolute, cwd);

    if (snapshot.trackedFileBackups[trackingPath]) {
      return;
    }

    trackedFiles.add(trackingPath);
    snapshot.trackedFileBackups[trackingPath] = await createBackup(absolute, 1, params);
    await recordSnapshot(snapshot);
  }

  function getSnapshotByOffset(offset: number): FileHistorySnapshot | undefined {
    if (offset < 1) {
      return undefined;
    }

    return snapshots[snapshots.length - offset];
  }

  function getSnapshotById(messageId: string): FileHistorySnapshot | undefined {
    return [...snapshots].reverse().find((snapshot) => snapshot.messageId === messageId);
  }

  function listSnapshots(): FileHistorySnapshot[] {
    return [...snapshots];
  }

  async function getDiffStats(messageId: string): Promise<FileHistoryDiffStats> {
    const snapshot = getSnapshotById(messageId);
    const out: FileHistoryDiffStats = { filesChanged: [], insertions: 0, deletions: 0 };

    if (!snapshot) {
      return out;
    }

    for (const trackingPath of trackedFiles) {
      const absolute = expandTrackingPath(trackingPath, cwd);
      const targetBackup =
        snapshot.trackedFileBackups[trackingPath] ?? earliestBackupFor(trackingPath);

      if (!targetBackup) {
        continue;
      }

      const [current, backup] = await Promise.all([
        readTextOrNull(absolute),
        backupContent(targetBackup.backupFileName, params),
      ]);
      const diff = countDiff(current ?? "", backup ?? "");

      if (diff.insertions || diff.deletions) {
        out.filesChanged.push(absolute);
        out.insertions += diff.insertions;
        out.deletions += diff.deletions;
      }
    }

    return out;
  }

  async function getDiffPreview(
    messageId: string,
    options?: {
      maxFiles?: number;
      maxLinesPerFile?: number;
    },
  ): Promise<FileHistoryDiffPreview> {
    const snapshot = getSnapshotById(messageId);
    const out: FileHistoryDiffPreview = { files: [] };

    if (!snapshot) {
      return out;
    }

    const maxFiles = options?.maxFiles ?? 5;
    const maxLinesPerFile = options?.maxLinesPerFile ?? 24;

    for (const trackingPath of trackedFiles) {
      if (out.files.length >= maxFiles) {
        break;
      }

      const absolute = expandTrackingPath(trackingPath, cwd);
      const targetBackup =
        snapshot.trackedFileBackups[trackingPath] ?? earliestBackupFor(trackingPath);

      if (!targetBackup) {
        continue;
      }

      const [current, backup] = await Promise.all([
        readTextOrNull(absolute),
        backupContent(targetBackup.backupFileName, params),
      ]);
      const preview = changedLinesPreview(current ?? "", backup ?? "", maxLinesPerFile);

      if (preview.lines.length > 0) {
        out.files.push({
          filePath: absolute,
          lines: preview.lines,
          truncated: preview.truncated,
        });
      }
    }

    return out;
  }

  async function restoreBackup(
    filePath: string,
    backupFileName: string | null,
  ): Promise<void> {
    if (backupFileName === null) {
      await rm(filePath, { force: true });
      return;
    }

    await mkdir(path.dirname(filePath), { recursive: true });
    await copyFile(backupPath(params.homeDir, params.sessionId, backupFileName), filePath);
  }

  async function rewind(messageId: string): Promise<string[]> {
    if (!enabled) {
      return [];
    }

    const snapshot = getSnapshotById(messageId);

    if (!snapshot) {
      throw new Error(`Snapshot not found: ${messageId}`);
    }

    const changed: string[] = [];

    for (const trackingPath of trackedFiles) {
      const absolute = expandTrackingPath(trackingPath, cwd);
      const targetBackup =
        snapshot.trackedFileBackups[trackingPath] ?? earliestBackupFor(trackingPath);

      if (!targetBackup) {
        continue;
      }

      if (await fileChangedFromBackup(absolute, targetBackup.backupFileName, params)) {
        await restoreBackup(absolute, targetBackup.backupFileName);
        changed.push(absolute);
      }
    }

    return changed;
  }

  function restoreSnapshots(records: FileHistorySnapshot[]): void {
    const latestByMessageId = new Map<string, FileHistorySnapshot>();

    for (const snapshot of records) {
      latestByMessageId.set(snapshot.messageId, snapshot);
    }

    snapshots = [...latestByMessageId.values()].slice(-MAX_SNAPSHOTS).map((snapshot) => ({
      messageId: snapshot.messageId,
      ...(snapshot.prompt && { prompt: snapshot.prompt }),
      trackedFileBackups: { ...snapshot.trackedFileBackups },
      timestamp: snapshot.timestamp,
    }));
    trackedFiles = new Set();

    for (const snapshot of snapshots) {
      for (const trackingPath of Object.keys(snapshot.trackedFileBackups)) {
        trackedFiles.add(trackingPath);
      }
    }
  }

  return {
    makeSnapshot,
    trackEdit,
    getSnapshotByOffset,
    getSnapshotById,
    listSnapshots,
    getDiffStats,
    getDiffPreview,
    rewind,
    restoreSnapshots,
    snapshotCount: () => snapshots.length,
  };
}

export async function cleanupOldFileHistoryBackups(params: {
  homeDir?: string;
  cleanupPeriodDays?: number;
}): Promise<void> {
  const root = path.join(agentHome(params.homeDir), "file-history");
  const cleanupDays = params.cleanupPeriodDays ?? DEFAULT_CLEANUP_DAYS;
  const cutoff = Date.now() - cleanupDays * 24 * 60 * 60 * 1000;

  let entries;

  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return;
    }

    throw error;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const dirPath = path.join(root, entry.name);
    const stats = await stat(dirPath);

    if (cleanupDays <= 0 || stats.mtimeMs < cutoff) {
      await rm(dirPath, { recursive: true, force: true });
    }
  }
}
