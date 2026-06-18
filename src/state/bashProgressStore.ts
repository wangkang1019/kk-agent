export interface BashProgressEntry {
  toolUseId: string;
  startedAt: number;
  stdout: string[];
  stderr: string[];
  lineCount: number;
  running: boolean;
  exitCode?: number;
  endedAt?: number;
}

type BashProgressSubscriber = (
  toolUseId: string,
  entry: BashProgressEntry,
) => void;

const MAX_LINES = 200;
const entries = new Map<string, BashProgressEntry>();
const subscribers = new Set<BashProgressSubscriber>();

function splitLines(chunk: string): string[] {
  return chunk.split(/\r?\n/).filter(Boolean);
}

function notify(toolUseId: string, entry: BashProgressEntry): void {
  for (const subscriber of subscribers) {
    subscriber(toolUseId, entry);
  }
}

function getOrCreateEntry(toolUseId: string): BashProgressEntry {
  const existing = entries.get(toolUseId);

  if (existing) {
    return existing;
  }

  const entry: BashProgressEntry = {
    toolUseId,
    startedAt: Date.now(),
    stdout: [],
    stderr: [],
    lineCount: 0,
    running: true,
  };
  entries.set(toolUseId, entry);
  return entry;
}

export function appendBashProgress(
  toolUseId: string | undefined,
  chunk: string,
  stream: "stdout" | "stderr",
): void {
  if (!toolUseId) {
    return;
  }

  const entry = getOrCreateEntry(toolUseId);
  const lines = splitLines(chunk);
  const bucket = stream === "stderr" ? entry.stderr : entry.stdout;

  bucket.push(...lines);

  while (bucket.length > MAX_LINES) {
    bucket.shift();
  }

  entry.lineCount += lines.length;
  notify(toolUseId, entry);
}

export function finishBashProgress(
  toolUseId: string | undefined,
  exitCode: number,
): void {
  if (!toolUseId) {
    return;
  }

  const entry = getOrCreateEntry(toolUseId);
  entry.running = false;
  entry.exitCode = exitCode;
  entry.endedAt = Date.now();
  notify(toolUseId, entry);
}

export function getBashProgress(
  toolUseId: string,
): BashProgressEntry | undefined {
  return entries.get(toolUseId);
}

export function subscribeBashProgress(
  subscriber: BashProgressSubscriber,
): () => void {
  subscribers.add(subscriber);
  return () => {
    subscribers.delete(subscriber);
  };
}

export function clearBashProgressForTesting(): void {
  entries.clear();
  subscribers.clear();
}
