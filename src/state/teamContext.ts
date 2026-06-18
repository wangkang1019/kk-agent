import type { TeamContext } from "../teams/types.js";

export type TeamContextListener = (context: TeamContext | null) => void;

let activeTeam: TeamContext | null = null;
const listeners = new Set<TeamContextListener>();

function emit(): void {
  for (const listener of listeners) {
    listener(activeTeam ? { ...activeTeam } : null);
  }
}

export function subscribeTeamContext(listener: TeamContextListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getActiveTeam(): TeamContext | null {
  return activeTeam ? { ...activeTeam } : null;
}

export function setActiveTeam(context: TeamContext): void {
  if (activeTeam && activeTeam.teamName !== context.teamName) {
    throw new Error(`Already leading team "${activeTeam.teamName}"`);
  }

  activeTeam = { ...context };
  emit();
}

export function clearActiveTeam(): void {
  activeTeam = null;
  emit();
}
