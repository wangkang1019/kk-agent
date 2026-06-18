export type SubAgentStatus = "running" | "completed" | "error";

export interface SubAgentProgress {
  agentType: string;
  description: string;
  status: SubAgentStatus;
  teammateName?: string;
  teamName?: string;
  startedAt: number;
  durationMs?: number;
  lastToolName?: string;
  lastToolIsError?: boolean;
  toolUseCount: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
}

export type SubAgentProgressListener = (
  toolUseId: string,
  progress: SubAgentProgress,
) => void;

const store = new Map<string, SubAgentProgress>();
const listeners = new Set<SubAgentProgressListener>();

function emit(toolUseId: string, progress: SubAgentProgress): void {
  for (const listener of listeners) {
    listener(toolUseId, progress);
  }
}

export function startSubAgentProgress(
  toolUseId: string,
  init: {
    agentType: string;
    description: string;
    teammateName?: string;
    teamName?: string;
  },
): void {
  const progress: SubAgentProgress = {
    agentType: init.agentType,
    description: init.description,
    status: "running",
    ...(init.teammateName && { teammateName: init.teammateName }),
    ...(init.teamName && { teamName: init.teamName }),
    startedAt: Date.now(),
    toolUseCount: 0,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
  };
  store.set(toolUseId, progress);
  emit(toolUseId, progress);
}

export function updateSubAgentProgress(
  toolUseId: string,
  patch: Partial<Omit<SubAgentProgress, "agentType" | "description" | "startedAt">>,
): void {
  const current = store.get(toolUseId);

  if (!current) {
    return;
  }

  const next = { ...current, ...patch };
  store.set(toolUseId, next);
  emit(toolUseId, next);
}

export function completeSubAgentProgress(
  toolUseId: string,
  patch: Partial<SubAgentProgress> = {},
): void {
  const current = store.get(toolUseId);

  if (!current) {
    return;
  }

  const next: SubAgentProgress = {
    ...current,
    ...patch,
    status: patch.status ?? "completed",
    durationMs: patch.durationMs ?? Date.now() - current.startedAt,
  };
  store.set(toolUseId, next);
  emit(toolUseId, next);
}

export function getSubAgentProgress(
  toolUseId: string,
): SubAgentProgress | undefined {
  return store.get(toolUseId);
}

export function subscribeSubAgentProgress(
  listener: SubAgentProgressListener,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function clearSubAgentProgress(): void {
  store.clear();
}
