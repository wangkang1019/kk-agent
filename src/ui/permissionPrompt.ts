import type { PermissionResponse } from "../permissions/permissions.js";

export interface PermissionOption {
  label: string;
  shortcut: string;
  response: PermissionResponse;
}

export const PERMISSION_OPTIONS: PermissionOption[] = [
  { label: "Yes", shortcut: "y", response: "allow" },
  {
    label: "Yes, allow this tool during this session",
    shortcut: "a",
    response: "always_allow",
  },
  { label: "No", shortcut: "n", response: "deny" },
];

export function movePermissionSelection(
  current: number,
  direction: "up" | "down",
): number {
  const length = PERMISSION_OPTIONS.length;
  if (direction === "up") {
    return (current - 1 + length) % length;
  }
  return (current + 1) % length;
}

export function permissionResponseForKey(
  input: string,
): PermissionResponse | null {
  const normalized = input.toLowerCase();
  return PERMISSION_OPTIONS.find((option) => option.shortcut === normalized)
    ?.response ?? null;
}

export function permissionResponseForIndex(index: number): PermissionResponse {
  return PERMISSION_OPTIONS[index]?.response ?? "allow";
}

export function getPermissionPreviewLines(params: {
  toolName: string;
  input?: Record<string, unknown>;
  summary: string;
}): string[] {
  const input = params.input ?? {};

  if (params.toolName === "Bash" && typeof input.command === "string") {
    return input.command.split(/\r?\n/).slice(0, 8).map((line) => `$ ${line}`);
  }

  if (params.toolName === "Write") {
    const path = typeof input.file_path === "string" ? input.file_path : params.summary;
    const content = typeof input.content === "string" ? input.content : "";
    return [
      `Create file: ${path}`,
      ...content.split(/\r?\n/).slice(0, 8).map((line) => `  ${line || " "}`),
    ];
  }

  if (params.toolName === "Edit") {
    const path = typeof input.file_path === "string" ? input.file_path : params.summary;
    const oldText = typeof input.old_string === "string" ? input.old_string : "";
    const newText = typeof input.new_string === "string" ? input.new_string : "";
    return [
      `Edit file: ${path}`,
      ...oldText.split(/\r?\n/).slice(0, 4).map((line) => `- ${line}`),
      ...newText.split(/\r?\n/).slice(0, 4).map((line) => `+ ${line}`),
    ];
  }

  return [params.summary];
}
