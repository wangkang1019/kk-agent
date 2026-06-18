import crypto from "node:crypto";
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Message, Usage } from "../types/message.js";
import type { FileHistorySnapshot } from "./fileHistory.js";

const DEFAULT_AGENT_HOME = path.join(os.homedir(), ".kk-agent");
const PROJECTS_DIR_NAME = "projects";
const DEFAULT_SESSION_LIMIT = 20;

export interface SessionPathParams {
  cwd: string;
  sessionId: string;
  homeDir?: string;
}

export interface SessionPaths {
  rootDir: string;
  projectDir: string;
  sessionsDir: string;
  transcriptPath: string;
  latestPath: string;
}

export interface InitSessionStorageParams {
  cwd: string;
  sessionId: string;
  startedAt: string;
  model: string;
  homeDir?: string;
}

export interface AppendTranscriptEntryParams {
  cwd: string;
  sessionId: string;
  entry: TranscriptEntry;
  homeDir?: string;
}

export interface RestoreSessionParams {
  cwd: string;
  sessionId?: string | null;
  homeDir?: string;
}

export interface ListProjectSessionsParams {
  cwd: string;
  limit?: number;
  homeDir?: string;
}

export interface FormatProjectSessionHistoryParams {
  cwd: string;
  homeDir?: string;
}

export interface SessionSummary {
  sessionId: string;
  cwd: string;
  startedAt: string;
  updatedAt: string;
  model: string;
  title?: string;
  messageCount: number;
  totalUsage: Usage;
}

export interface RestoredSession {
  summary: SessionSummary;
  messages: Message[];
  fileHistorySnapshots: FileHistorySnapshot[];
}

export type TranscriptEntry =
  | {
      type: "session_meta";
      sessionId: string;
      cwd: string;
      startedAt: string;
      model: string;
    }
  | {
      type: "message";
      timestamp: string;
      role: "user" | "assistant";
      message: Message;
    }
  | {
      type: "tool_event";
      timestamp: string;
      name: string;
      phase: "start" | "done";
      resultLength?: number;
      isError?: boolean;
    }
  | {
      type: "usage";
      timestamp: string;
      turn: Usage;
      total: Usage;
    }
  | {
      type: "compaction";
      timestamp: string;
      trigger: "manual" | "auto";
      beforeMessageCount: number;
      afterMessageCount: number;
      summary?: string;
    }
  | {
      type: "file_history_snapshot";
      timestamp: string;
      snapshot: FileHistorySnapshot;
    }
  | {
      type: "system";
      timestamp: string;
      level: "info" | "error";
      message: string;
    };

function emptyUsage(): Usage {
  return { input_tokens: 0, output_tokens: 0 };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isUsage(value: unknown): value is Usage {
  return (
    isRecord(value) &&
    typeof value.input_tokens === "number" &&
    typeof value.output_tokens === "number"
  );
}

function isMessage(value: unknown): value is Message {
  return (
    isRecord(value) &&
    (value.role === "user" || value.role === "assistant") &&
    "content" in value
  );
}

function isFileHistoryBackup(value: unknown): boolean {
  return (
    isRecord(value) &&
    (typeof value.backupFileName === "string" || value.backupFileName === null) &&
    typeof value.version === "number" &&
    typeof value.backupTime === "string"
  );
}

function isFileHistorySnapshot(value: unknown): value is FileHistorySnapshot {
  if (
    !isRecord(value) ||
    typeof value.messageId !== "string" ||
    typeof value.timestamp !== "string" ||
    !isRecord(value.trackedFileBackups)
  ) {
    return false;
  }

  return Object.values(value.trackedFileBackups).every(isFileHistoryBackup);
}

export function createSessionId(): string {
  return crypto.randomUUID();
}

export function getProjectHash(cwd: string): string {
  return crypto
    .createHash("sha256")
    .update(path.resolve(cwd))
    .digest("hex")
    .slice(0, 16);
}

export function getSessionPaths(params: SessionPathParams): SessionPaths {
  const rootDir = params.homeDir ?? DEFAULT_AGENT_HOME;
  const projectDir = path.join(
    rootDir,
    PROJECTS_DIR_NAME,
    getProjectHash(params.cwd),
  );
  const sessionsDir = path.join(projectDir, "sessions");

  return {
    rootDir,
    projectDir,
    sessionsDir,
    transcriptPath: path.join(sessionsDir, `${params.sessionId}.jsonl`),
    latestPath: path.join(projectDir, "latest"),
  };
}

export function createSessionMetaEntry(
  params: Omit<InitSessionStorageParams, "homeDir">,
): TranscriptEntry {
  return {
    type: "session_meta",
    sessionId: params.sessionId,
    cwd: params.cwd,
    startedAt: params.startedAt,
    model: params.model,
  };
}

export function createMessageEntry(params: {
  message: Message;
  timestamp?: string;
}): TranscriptEntry {
  return {
    type: "message",
    timestamp: params.timestamp ?? new Date().toISOString(),
    role: params.message.role,
    message: params.message,
  };
}

export function createToolEventEntry(params: {
  name: string;
  phase: "start" | "done";
  resultLength?: number;
  isError?: boolean;
  timestamp?: string;
}): TranscriptEntry {
  return {
    type: "tool_event",
    timestamp: params.timestamp ?? new Date().toISOString(),
    name: params.name,
    phase: params.phase,
    ...(typeof params.resultLength === "number" && {
      resultLength: params.resultLength,
    }),
    ...(typeof params.isError === "boolean" && { isError: params.isError }),
  };
}

export function createUsageEntry(params: {
  turn: Usage;
  total: Usage;
  timestamp?: string;
}): TranscriptEntry {
  return {
    type: "usage",
    timestamp: params.timestamp ?? new Date().toISOString(),
    turn: params.turn,
    total: params.total,
  };
}

export function createCompactionEntry(params: {
  trigger: "manual" | "auto";
  beforeMessageCount: number;
  afterMessageCount: number;
  summary?: string;
  timestamp?: string;
}): TranscriptEntry {
  return {
    type: "compaction",
    timestamp: params.timestamp ?? new Date().toISOString(),
    trigger: params.trigger,
    beforeMessageCount: params.beforeMessageCount,
    afterMessageCount: params.afterMessageCount,
    ...(params.summary && { summary: params.summary }),
  };
}

export function createFileHistorySnapshotEntry(params: {
  snapshot: FileHistorySnapshot;
  timestamp?: string;
}): TranscriptEntry {
  return {
    type: "file_history_snapshot",
    timestamp: params.timestamp ?? new Date().toISOString(),
    snapshot: params.snapshot,
  };
}

export function createSystemEntry(params: {
  level: "info" | "error";
  message: string;
  timestamp?: string;
}): TranscriptEntry {
  return {
    type: "system",
    timestamp: params.timestamp ?? new Date().toISOString(),
    level: params.level,
    message: params.message,
  };
}

async function ensureSessionDir(paths: SessionPaths): Promise<void> {
  await mkdir(paths.sessionsDir, { recursive: true });
}

export async function initSessionStorage(
  params: InitSessionStorageParams,
): Promise<SessionPaths> {
  const paths = getSessionPaths(params);
  await ensureSessionDir(paths);
  await appendFile(
    paths.transcriptPath,
    `${JSON.stringify(createSessionMetaEntry(params))}\n`,
    "utf8",
  );
  await writeFile(paths.latestPath, `${params.sessionId}\n`, "utf8");

  return paths;
}

export async function appendTranscriptEntry(
  params: AppendTranscriptEntryParams,
): Promise<void> {
  const paths = getSessionPaths(params);
  await ensureSessionDir(paths);
  await appendFile(
    paths.transcriptPath,
    `${JSON.stringify(params.entry)}\n`,
    "utf8",
  );
  await writeFile(paths.latestPath, `${params.sessionId}\n`, "utf8");
}

export function parseJsonLine(line: string): TranscriptEntry | null {
  try {
    const parsed = JSON.parse(line) as unknown;

    if (!isRecord(parsed) || typeof parsed.type !== "string") {
      return null;
    }

    if (
      parsed.type === "session_meta" &&
      typeof parsed.sessionId === "string" &&
      typeof parsed.cwd === "string" &&
      typeof parsed.startedAt === "string" &&
      typeof parsed.model === "string"
    ) {
      return {
        type: "session_meta",
        sessionId: parsed.sessionId,
        cwd: parsed.cwd,
        startedAt: parsed.startedAt,
        model: parsed.model,
      };
    }

    if (
      parsed.type === "message" &&
      typeof parsed.timestamp === "string" &&
      isMessage(parsed.message)
    ) {
      return {
        type: "message",
        timestamp: parsed.timestamp,
        role: parsed.message.role,
        message: parsed.message,
      };
    }

    if (
      parsed.type === "tool_event" &&
      typeof parsed.timestamp === "string" &&
      typeof parsed.name === "string" &&
      (parsed.phase === "start" || parsed.phase === "done")
    ) {
      return {
        type: "tool_event",
        timestamp: parsed.timestamp,
        name: parsed.name,
        phase: parsed.phase,
        ...(typeof parsed.resultLength === "number" && {
          resultLength: parsed.resultLength,
        }),
        ...(typeof parsed.isError === "boolean" && {
          isError: parsed.isError,
        }),
      };
    }

    if (
      parsed.type === "usage" &&
      typeof parsed.timestamp === "string" &&
      isUsage(parsed.turn) &&
      isUsage(parsed.total)
    ) {
      return {
        type: "usage",
        timestamp: parsed.timestamp,
        turn: parsed.turn,
        total: parsed.total,
      };
    }

    if (
      parsed.type === "compaction" &&
      typeof parsed.timestamp === "string" &&
      (parsed.trigger === "manual" || parsed.trigger === "auto") &&
      typeof parsed.beforeMessageCount === "number" &&
      typeof parsed.afterMessageCount === "number"
    ) {
      return {
        type: "compaction",
        timestamp: parsed.timestamp,
        trigger: parsed.trigger,
        beforeMessageCount: parsed.beforeMessageCount,
        afterMessageCount: parsed.afterMessageCount,
        ...(typeof parsed.summary === "string" && { summary: parsed.summary }),
      };
    }

    if (
      parsed.type === "file_history_snapshot" &&
      typeof parsed.timestamp === "string" &&
      isFileHistorySnapshot(parsed.snapshot)
    ) {
      return {
        type: "file_history_snapshot",
        timestamp: parsed.timestamp,
        snapshot: parsed.snapshot,
      };
    }

    if (
      parsed.type === "system" &&
      typeof parsed.timestamp === "string" &&
      (parsed.level === "info" || parsed.level === "error") &&
      typeof parsed.message === "string"
    ) {
      return {
        type: "system",
        timestamp: parsed.timestamp,
        level: parsed.level,
        message: parsed.message,
      };
    }

    return null;
  } catch {
    return null;
  }
}

export async function readTranscriptEntries(
  transcriptPath: string,
): Promise<TranscriptEntry[]> {
  const raw = await readFile(transcriptPath, "utf8");
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseJsonLine)
    .filter((entry): entry is TranscriptEntry => entry !== null);
}

export async function getLatestSessionId(params: {
  cwd: string;
  homeDir?: string;
}): Promise<string | null> {
  const paths = getSessionPaths({
    cwd: params.cwd,
    homeDir: params.homeDir,
    sessionId: "placeholder",
  });

  try {
    const latest = (await readFile(paths.latestPath, "utf8")).trim();
    return latest || null;
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

function getEntryTimestamp(entry: TranscriptEntry): string | undefined {
  return "timestamp" in entry ? entry.timestamp : undefined;
}

function getLastUpdatedAt(
  entries: TranscriptEntry[],
  fallback: string,
): string {
  const latest = [...entries]
    .reverse()
    .map(getEntryTimestamp)
    .find((timestamp) => timestamp !== undefined);

  return latest ?? fallback;
}

function extractMessageText(message: Message): string {
  if (typeof message.content === "string") {
    return message.content;
  }

  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function normalizeSessionTitle(text: string): string | undefined {
  const normalized = text
    .replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (
    !normalized ||
    normalized.startsWith("[") ||
    normalized.startsWith("<") ||
    normalized.startsWith("/")
  ) {
    return undefined;
  }

  return normalized.length > 48 ? `${normalized.slice(0, 45)}...` : normalized;
}

function getSessionTitle(entries: TranscriptEntry[]): string | undefined {
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message.role !== "user") {
      continue;
    }

    const title = normalizeSessionTitle(extractMessageText(entry.message));
    if (title) {
      return title;
    }
  }

  return undefined;
}

function summarizeEntries(entries: TranscriptEntry[]): RestoredSession {
  const meta = entries.find((entry) => entry.type === "session_meta");

  if (!meta || meta.type !== "session_meta") {
    throw new Error("Session is missing session metadata.");
  }

  let latestCompactionIndex = -1;
  for (let index = entries.length - 1; index >= 0; index--) {
    if (entries[index]?.type === "compaction") {
      latestCompactionIndex = index;
      break;
    }
  }
  const restorableEntries =
    latestCompactionIndex === -1
      ? entries
      : entries.slice(latestCompactionIndex + 1);
  const messages = restorableEntries
    .filter((entry): entry is Extract<TranscriptEntry, { type: "message" }> => {
      return entry.type === "message";
    })
    .map((entry) => entry.message);
  const latestUsage = [...entries]
    .reverse()
    .find((entry): entry is Extract<TranscriptEntry, { type: "usage" }> => {
      return entry.type === "usage";
    });

  return {
    summary: {
      sessionId: meta.sessionId,
      cwd: meta.cwd,
      startedAt: meta.startedAt,
      updatedAt: getLastUpdatedAt(entries, meta.startedAt),
      model: meta.model,
      title: getSessionTitle(entries),
      messageCount: messages.length,
      totalUsage: latestUsage?.total ?? emptyUsage(),
    },
    messages,
    fileHistorySnapshots: entries
      .filter((entry): entry is Extract<TranscriptEntry, { type: "file_history_snapshot" }> =>
        entry.type === "file_history_snapshot"
      )
      .map((entry) => entry.snapshot),
  };
}

export async function restoreSession(
  params: RestoreSessionParams,
): Promise<RestoredSession> {
  const sessionId =
    params.sessionId ?? await getLatestSessionId({
      cwd: params.cwd,
      homeDir: params.homeDir,
    });

  if (!sessionId) {
    throw new Error("No saved session found for this project.");
  }

  const paths = getSessionPaths({
    cwd: params.cwd,
    homeDir: params.homeDir,
    sessionId,
  });
  const entries = await readTranscriptEntries(paths.transcriptPath);

  if (entries.length === 0) {
    throw new Error("Session is empty or unreadable.");
  }

  return summarizeEntries(entries);
}

export async function listProjectSessions(
  params: ListProjectSessionsParams,
): Promise<SessionSummary[]> {
  const paths = getSessionPaths({
    cwd: params.cwd,
    homeDir: params.homeDir,
    sessionId: "placeholder",
  });

  let entries;

  try {
    entries = await readdir(paths.sessionsDir, { withFileTypes: true });
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return [];
    }

    throw error;
  }

  const sessionFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => path.join(paths.sessionsDir, entry.name));
  const restored = await Promise.all(
    sessionFiles.map(async (filePath) => {
      try {
        return summarizeEntries(await readTranscriptEntries(filePath)).summary;
      } catch {
        return null;
      }
    }),
  );

  return restored
    .filter((summary): summary is SessionSummary => summary !== null)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, params.limit ?? DEFAULT_SESSION_LIMIT);
}

export async function formatProjectSessionHistory(
  params: FormatProjectSessionHistoryParams,
): Promise<string> {
  const sessions = await listProjectSessions(params);

  if (sessions.length === 0) {
    return "No saved sessions found for this project.";
  }

  return [
    "Recent sessions:",
    ...sessions.map((session) => {
      const total =
        session.totalUsage.input_tokens + session.totalUsage.output_tokens;

      return [
        `- ${session.sessionId}`,
        ...(session.title ? [`  Title: ${session.title}`] : []),
        `  Updated: ${session.updatedAt}`,
        `  Started: ${session.startedAt}`,
        `  Messages: ${session.messageCount}`,
        `  Usage: ${session.totalUsage.input_tokens} in / ${session.totalUsage.output_tokens} out / ${total} total`,
        `  Model: ${session.model}`,
      ].join("\n");
    }),
  ].join("\n");
}
