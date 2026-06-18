export type AsyncAgentStatus = "running" | "completed" | "failed" | "killed";

export interface RegisterAsyncAgentInit {
  agentId: string;
  agentType: string;
  description: string;
  prompt: string;
  outputFile: string;
  worktreePath?: string;
  worktreeBranch?: string;
  teammateName?: string;
  teamName?: string;
}

export interface AsyncAgentEntry {
  agentId: string;
  agentType: string;
  description: string;
  prompt: string;
  outputFile: string;
  startedAt: string;
  status: AsyncAgentStatus;
  abortController: AbortController;
  isolated: boolean;
  worktreePath?: string;
  worktreeBranch?: string;
  teammateName?: string;
  teamName?: string;
  lastToolName?: string;
  toolUseCount: number;
  turnCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  durationMs?: number;
  finalText?: string;
  error?: string;
  reason?: string;
}

export type AsyncAgentListener = (entry: AsyncAgentEntry) => void;

const entries = new Map<string, AsyncAgentEntry>();
const listeners = new Set<AsyncAgentListener>();

function emit(entry: AsyncAgentEntry): void {
  for (const listener of listeners) {
    listener({ ...entry });
  }
}

export function subscribeAsyncAgents(listener: AsyncAgentListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function registerAsyncAgent(init: RegisterAsyncAgentInit): AsyncAgentEntry {
  if (entries.has(init.agentId)) {
    throw new Error(`Async agent already exists: ${init.agentId}`);
  }

  const entry: AsyncAgentEntry = {
    agentId: init.agentId,
    agentType: init.agentType,
    description: init.description,
    prompt: init.prompt,
    outputFile: init.outputFile,
    startedAt: new Date().toISOString(),
    status: "running",
    abortController: new AbortController(),
    isolated: Boolean(init.worktreePath),
    ...(init.worktreePath && { worktreePath: init.worktreePath }),
    ...(init.worktreeBranch && { worktreeBranch: init.worktreeBranch }),
    ...(init.teammateName && { teammateName: init.teammateName }),
    ...(init.teamName && { teamName: init.teamName }),
    toolUseCount: 0,
    turnCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };

  entries.set(entry.agentId, entry);
  emit(entry);
  return entry;
}

export function updateAsyncAgentProgress(
  agentId: string,
  patch: Partial<Omit<AsyncAgentEntry, "agentId" | "abortController">>,
): void {
  const current = entries.get(agentId);

  if (!current || current.status !== "running") {
    return;
  }

  const next = { ...current, ...patch };
  entries.set(agentId, next);
  emit(next);
}

export function completeAsyncAgent(
  agentId: string,
  patch: Partial<Omit<AsyncAgentEntry, "agentId" | "abortController">>,
): void {
  const current = entries.get(agentId);

  if (!current) {
    return;
  }

  const next: AsyncAgentEntry = {
    ...current,
    ...patch,
    status: "completed",
  };
  entries.set(agentId, next);
  emit(next);
}

export function failAsyncAgent(
  agentId: string,
  error: string,
  patch: Partial<Omit<AsyncAgentEntry, "agentId" | "abortController">> = {},
): void {
  const current = entries.get(agentId);

  if (!current) {
    return;
  }

  const next: AsyncAgentEntry = {
    ...current,
    ...patch,
    status: "failed",
    error,
    reason: patch.reason ?? "model_error",
  };
  entries.set(agentId, next);
  emit(next);
}

export function killAsyncAgent(agentId: string): boolean {
  const current = entries.get(agentId);

  if (!current || current.status !== "running") {
    return false;
  }

  current.abortController.abort();
  const next: AsyncAgentEntry = {
    ...current,
    status: "killed",
    reason: "aborted",
    durationMs: Date.now() - Date.parse(current.startedAt),
  };
  entries.set(agentId, next);
  emit(next);
  return true;
}

export function getAsyncAgent(agentId: string): AsyncAgentEntry | undefined {
  const entry = entries.get(agentId);
  return entry ? { ...entry } : undefined;
}

export function getAllAsyncAgents(): AsyncAgentEntry[] {
  return [...entries.values()].map((entry) => ({ ...entry }));
}

export function clearAsyncAgentsForTesting(): void {
  entries.clear();
  for (const listener of listeners) {
    listener({
      agentId: "",
      agentType: "",
      description: "",
      prompt: "",
      outputFile: "",
      startedAt: new Date().toISOString(),
      status: "completed",
      abortController: new AbortController(),
      isolated: false,
      toolUseCount: 0,
      turnCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    });
  }
}
