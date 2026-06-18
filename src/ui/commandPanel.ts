import type { PermissionMode } from "../permissions/permissions.js";

export interface CommandPanelOption {
  id: string;
  label: string;
  description: string;
  command: string;
  isCurrent?: boolean;
  isDanger?: boolean;
}

export interface CommandPanelState {
  title: string;
  description: string;
  options: CommandPanelOption[];
  selectedIndex: number;
}

export const PERMISSION_MODE_OPTIONS: Array<{
  mode: PermissionMode;
  description: string;
}> = [
  { mode: "default", description: "Ask before sensitive write or shell actions" },
  { mode: "plan", description: "Read-only exploration and planning mode" },
  { mode: "auto", description: "Auto-allow safe operations with explicit deny rules" },
];

export function nextPermissionMode(mode: PermissionMode): PermissionMode {
  const index = PERMISSION_MODE_OPTIONS.findIndex((option) => option.mode === mode);
  const next = (index + 1) % PERMISSION_MODE_OPTIONS.length;
  return PERMISSION_MODE_OPTIONS[next]?.mode ?? "default";
}

export function movePanelSelection(
  current: number,
  direction: "up" | "down",
  length: number,
): number {
  if (length <= 0) return 0;
  if (direction === "up") {
    return (current - 1 + length) % length;
  }
  return (current + 1) % length;
}

export function panelSelectionForInput(
  input: string,
  length: number,
): number | null {
  if (!/^[1-9]$/.test(input)) {
    return null;
  }

  const index = Number(input) - 1;
  return index >= 0 && index < length ? index : null;
}
